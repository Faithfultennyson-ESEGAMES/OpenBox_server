import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import config from '../config.js';
import { requireControlAuth } from './middleware/auth.js';
import sessionRegistry from '../runtime/sessionRegistry.js';
import redisStore from '../store/redisStore.js';
import { RoundStatus, WebhookEventType } from '../shared/protocol.js';
import {
  clearDlq,
  dispatchWebhook,
  listDlqItems,
  readDlqItem,
  resendDlqItem
} from '../webhooks/dispatcher.js';
import { validateStartPayload } from './validation.js';
import { signJsonPayload } from '../security/hmac.js';
import { buildSessionCreatedPayload } from '../webhooks/payloads.js';

const router = express.Router();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientRoot = path.resolve(__dirname, '../../../client/public');
const clientIndexPath = path.join(clientRoot, 'index.html');

const asyncRoute = (handler) => (req, res, next) => {
  Promise.resolve(handler(req, res, next)).catch(next);
};

function setNoStoreHeaders(res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
}

async function sendClientIndex(req, res) {
  const clientBuildVersion = String(req.query?.v || Date.now().toString(36));
  const html = await fs.readFile(clientIndexPath, 'utf8');
  const rendered = html
    .replace('/src/style.css', `/src/style.css?v=${clientBuildVersion}`)
    .replace('/src/main.js', `/src/main.js?v=${clientBuildVersion}`);

  setNoStoreHeaders(res);
  res.type('html').send(rendered);
}

function buildServerJoinUrl(req, sessionId) {
  return `${req.protocol}://${req.get('host')}/session/${sessionId}/join`;
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || '')
  );
}

function shouldExposeRevealData(roundStatus) {
  return [
    RoundStatus.REVEALING,
    RoundStatus.ROUND_ENDED,
    RoundStatus.ROUND_CANCELLED
  ].includes(roundStatus);
}

function buildPublicSessionState(runtime) {
  const exposeRevealData = shouldExposeRevealData(runtime.round?.status);
  const round = {
    ...runtime.round
  };

  if (!exposeRevealData) {
    delete round.auditSeed;
  }

  return {
    session: runtime.session,
    round,
    players: runtime.players,
    boxes: runtime.boxes.map((box) => ({
      boxId: box.boxId,
      boxNumber: box.boxNumber,
      initialOwnerPlayerId: box.initialOwnerPlayerId,
      currentOwnerPlayerId: box.currentOwnerPlayerId,
      ...(exposeRevealData
        ? {
            rewardAmount: box.rewardAmount,
            isWinningBox: box.isWinningBox
          }
        : {})
    }))
  };
}

router.post('/session/start', requireControlAuth, asyncRoute(async (req, res) => {
  const validation = validateStartPayload(req.body);
  if (!validation.ok) {
    res.status(400).json({ error: validation.error });
    return;
  }

  let runtime;
  try {
    runtime = await sessionRegistry.createSession({
      ...validation,
      platformFeeType: config.platformFeeType,
      platformFeeValue: config.platformFeeValue
    });
  } catch (error) {
    if (error?.code === 'PLAYER_ACTIVE_SESSION_CONFLICT') {
      res.status(409).json({
        error: error.message,
        code: error.code,
        playerId: error.playerId,
        activeSessionId: error.activeSessionId
      });
      return;
    }
    throw error;
  }

  await dispatchWebhook(
    WebhookEventType.SESSION_CREATED,
    buildSessionCreatedPayload({
      eventName: WebhookEventType.SESSION_CREATED,
      session: runtime.session,
      round: runtime.round,
      players: runtime.players
    })
  );

  const responsePayload = {
    sessionId: runtime.session.sessionId,
    joinUrl: buildServerJoinUrl(req, runtime.session.sessionId),
    playerCount: runtime.session.initialExpectedPlayerCount,
    stakeAmount: runtime.session.stakeAmount,
    status: runtime.session.status,
    firstJoinTimeoutMs: config.devWaitForAllPlayers ? null : config.firstJoinTimeoutMs,
    devWaitForAllPlayers: config.devWaitForAllPlayers
  };
  const signature = signJsonPayload(responsePayload);
  if (signature) {
    res.set('X-Hub-Signature-256', signature);
  }
  res.status(201).json(responsePayload);
}));

router.post('/session/:sessionId/join-intent', asyncRoute(async (req, res) => {
  const { sessionId } = req.params;
  const { playerId, playerName } = req.body || {};
  if (!playerId || !playerName) {
    res.status(400).json({ error: 'playerId and playerName are required' });
    return;
  }

  const runtime = await sessionRegistry.getOrHydrate(sessionId);
  if (!runtime) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  const result = await runtime.markJoinIntent({
    playerId: String(playerId),
    playerName: String(playerName).trim()
  });
  if (!result.ok) {
    res.status(400).json({ error: result.error });
    return;
  }

  res.json(result);
}));

router.post('/session/:sessionId/replay', requireControlAuth, asyncRoute(async (req, res) => {
  const { sessionId } = req.params;
  const playerIds = Array.isArray(req.body?.playerIds) ? req.body.playerIds.map(String) : [];
  if (playerIds.length < 5) {
    res.status(400).json({ error: 'Replay requires at least 5 unique players' });
    return;
  }
  if (new Set(playerIds).size !== playerIds.length) {
    res.status(400).json({ error: 'Replay playerIds must be unique' });
    return;
  }

  const runtime = await sessionRegistry.getOrHydrate(sessionId);
  if (!runtime) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  const currentSessionPlayers = new Set(runtime.session.registeredPlayerIds);
  if (playerIds.some((playerId) => !currentSessionPlayers.has(playerId))) {
    res.status(400).json({ error: 'Replay playerIds must belong to the session' });
    return;
  }

  const currentlyConnected = new Set(
    runtime.players.filter((player) => player.isConnected).map((player) => player.playerId)
  );
  if (playerIds.some((playerId) => !currentlyConnected.has(playerId))) {
    res.status(400).json({ error: 'Replay players are expected to be connected' });
    return;
  }

  await runtime.createReplayRound(playerIds);
  res.json({
    sessionId: runtime.session.sessionId,
    roundId: runtime.round.roundId,
    roundNumber: runtime.round.roundNumber,
    expectedPlayerCountForRound: runtime.round.expectedPlayerCountForRound
  });
}));

router.post('/session/:sessionId/end', requireControlAuth, asyncRoute(async (req, res) => {
  const runtime = await sessionRegistry.getOrHydrate(req.params.sessionId);
  if (!runtime) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  await runtime.endSession('manual_end');
  res.json({ ok: true, sessionId: runtime.session.sessionId });
}));

async function handleActiveSessions(req, res) {
  const activeSessionIds = await redisStore.getActiveSessionIds();
  const sessions = [];

  for (const sessionId of activeSessionIds) {
    const runtime = await sessionRegistry.getOrHydrate(sessionId);
    if (!runtime) continue;
    sessions.push({
      sessionId: runtime.session.sessionId,
      sessionStatus: runtime.session.status,
      roundId: runtime.round?.roundId || null,
      roundNumber: runtime.round?.roundNumber || null,
      roundStatus: runtime.round?.status || null,
      playerCount: runtime.session.currentExpectedPlayerCount,
      joinedCount: runtime.getJoinedCount(),
      readyCount: runtime.round?.readyPlayerIdsForRound?.length || 0,
      expectedReadyCount: runtime.round?.gatePlayerIdsForRound?.length || 0,
      connectedCount: runtime.players.filter((player) => player.isConnected).length,
      createdAt: runtime.session.createdAt,
      endedAt: runtime.session.endedAt || null,
      endReason: runtime.session.endReason || null
    });
  }

  res.json({
    activeCount: sessions.length,
    sessions
  });
}

router.get('/admin/sessions/active', requireControlAuth, asyncRoute(handleActiveSessions));
router.post('/admin/sessions/active', requireControlAuth, asyncRoute(handleActiveSessions));

router.post('/admin/session/:sessionId/end', requireControlAuth, asyncRoute(async (req, res) => {
  const runtime = await sessionRegistry.getOrHydrate(req.params.sessionId);
  if (!runtime) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  await runtime.endSession('manual_end');
  res.json({
    ok: true,
    sessionId: runtime.session.sessionId,
    sessionStatus: runtime.session.status
  });
}));

router.get('/admin/session/:sessionId/debug', requireControlAuth, asyncRoute(async (req, res) => {
  const runtime = await sessionRegistry.getOrHydrate(req.params.sessionId);
  if (!runtime) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  const events = await redisStore.getEvents(runtime.session.sessionId, 250);
  res.json({
    snapshotRevision: runtime.session.snapshotRevision || 0,
    session: runtime.session,
    round: runtime.round,
    players: runtime.players,
    boxes: runtime.boxes,
    swaps: runtime.swaps,
    events
  });
}));

router.get('/admin/dlq', requireControlAuth, asyncRoute(async (req, res) => {
  res.json({ items: await listDlqItems() });
}));

router.get('/admin/dlq/:id', requireControlAuth, asyncRoute(async (req, res) => {
  if (!isUuid(req.params.id)) {
    res.status(400).json({ error: 'Invalid DLQ item id' });
    return;
  }

  try {
    res.json(await readDlqItem(req.params.id));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      res.status(404).json({ error: 'DLQ item not found' });
      return;
    }
    throw error;
  }
}));

router.post('/admin/dlq/:id/resend', requireControlAuth, asyncRoute(async (req, res) => {
  if (!isUuid(req.params.id)) {
    res.status(400).json({ error: 'Invalid DLQ item id' });
    return;
  }

  try {
    const { item, result } = await resendDlqItem(req.params.id);
    if (result.ok) {
      res.json({
        ok: true,
        dlqItemId: item.dlqItemId,
        eventId: item.eventId,
        eventName: item.eventName,
        endpoint: item.endpoint
      });
      return;
    }

    res.status(400).json({
      ok: false,
      dlqItemId: item.dlqItemId,
      eventId: item.eventId,
      eventName: item.eventName,
      endpoint: item.endpoint,
      error: result.error || result.reason || 'Failed to resend DLQ item',
      attempts: result.attempts,
      status: result.status ?? null
    });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      res.status(404).json({ error: 'DLQ item not found' });
      return;
    }
    throw error;
  }
}));

router.delete('/admin/dlq', requireControlAuth, asyncRoute(async (req, res) => {
  res.json({
    ok: true,
    clearedCount: await clearDlq()
  });
}));

router.get('/session/:sessionId', asyncRoute(async (req, res) => {
  const runtime = await sessionRegistry.getOrHydrate(req.params.sessionId);
  if (!runtime) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  res.json(buildPublicSessionState(runtime));
}));

router.get('/session/:sessionId/join', (req, res) => {
  sendClientIndex(req, res).catch((error) => {
    res.status(500).json({ error: error.message || 'Unable to load client' });
  });
});

router.get('/health', asyncRoute(async (req, res) => {
  const activeSessions = await redisStore.getActiveSessionIds();
  res.json({ ok: true, activeSessions: activeSessions.length });
}));

export default router;
