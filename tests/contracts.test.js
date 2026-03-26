import express from 'express';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import config from '../src/config.js';
import { validateEnv } from '../src/config/validateEnv.js';
import { RoundStatus, SessionStatus, SwapState } from '../src/shared/protocol.js';
import { validateStartPayload } from '../src/http/validation.js';
import routes from '../src/http/routes.js';
import { buildSessionSnapshot } from '../src/runtime/snapshot.js';
import {
  buildRoundEndedPayload,
  buildRoundStartedPayload,
  buildRoundSwapMatchedPayload,
  buildSessionCreatedPayload,
  buildSessionEndedPayload
} from '../src/webhooks/payloads.js';
import { createRound, createRoundPlayers, createSessionContainer } from '../src/domain/sessionState.js';
import sessionRegistry from '../src/runtime/sessionRegistry.js';

test('validateStartPayload accepts valid payloads', () => {
  const result = validateStartPayload({
    playerCount: 5,
    stakeAmount: 1000,
    playerIds: ['p1', 'p2', 'p3', 'p4', 'p5']
  });

  assert.deepEqual(result, {
    ok: true,
    playerCount: 5,
    stakeAmount: 1000,
    playerIds: ['p1', 'p2', 'p3', 'p4', 'p5']
  });
});

test('validateStartPayload rejects invalid player counts, mismatches, duplicates, and stake', () => {
  assert.equal(validateStartPayload({ playerCount: 4, stakeAmount: 1000, playerIds: ['p1', 'p2', 'p3', 'p4'] }).ok, false);
  assert.equal(validateStartPayload({ playerCount: 51, stakeAmount: 1000, playerIds: Array.from({ length: 51 }, (_, i) => `p${i}`) }).ok, false);
  assert.equal(validateStartPayload({ playerCount: 5, stakeAmount: 1000, playerIds: ['p1', 'p2'] }).ok, false);
  assert.equal(validateStartPayload({ playerCount: 5, stakeAmount: 1000, playerIds: ['p1', 'p1', 'p3', 'p4', 'p5'] }).ok, false);
  assert.equal(validateStartPayload({ playerCount: 5, stakeAmount: 0, playerIds: ['p1', 'p2', 'p3', 'p4', 'p5'] }).ok, false);
});

test('join client html propagates the request version into asset urls', async (t) => {
  const app = express();
  app.use(routes);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const response = await fetch(`http://127.0.0.1:${port}/session/test-session/join?v=run-123`);
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(html, /\/src\/style\.css\?v=run-123/);
  assert.match(html, /\/src\/main\.js\?v=run-123/);
  assert.equal(response.headers.get('cache-control'), 'no-store, no-cache, must-revalidate, proxy-revalidate');
});

test('public session endpoint hides audit seed and box rewards before reveal', async (t) => {
  const originalGetOrHydrate = sessionRegistry.getOrHydrate;
  sessionRegistry.getOrHydrate = async () => ({
    session: { sessionId: 'session-1', status: SessionStatus.ROUND_ACTIVE },
    round: {
      roundId: 'round-1',
      status: RoundStatus.SWAP_OPEN,
      auditSeed: 'seed-hidden'
    },
    players: [{ playerId: 'p1', isConnected: true }],
    boxes: [
      {
        boxId: 'box-1',
        boxNumber: 1,
        rewardAmount: 2700,
        isWinningBox: true,
        initialOwnerPlayerId: 'p1',
        currentOwnerPlayerId: 'p1'
      }
    ]
  });

  const app = express();
  app.use(routes);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    sessionRegistry.getOrHydrate = originalGetOrHydrate;
    await new Promise((resolve) => server.close(resolve));
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const response = await fetch(`http://127.0.0.1:${port}/session/session-1`);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal('auditSeed' in payload.round, false);
  assert.equal('rewardAmount' in payload.boxes[0], false);
  assert.equal('isWinningBox' in payload.boxes[0], false);
});

test('public session endpoint includes reveal data after reveal begins', async (t) => {
  const originalGetOrHydrate = sessionRegistry.getOrHydrate;
  sessionRegistry.getOrHydrate = async () => ({
    session: { sessionId: 'session-1', status: SessionStatus.REPLAY_WAITING },
    round: {
      roundId: 'round-1',
      status: RoundStatus.REVEALING,
      auditSeed: 'seed-visible'
    },
    players: [{ playerId: 'p1', isConnected: true }],
    boxes: [
      {
        boxId: 'box-1',
        boxNumber: 1,
        rewardAmount: 2700,
        isWinningBox: true,
        initialOwnerPlayerId: 'p1',
        currentOwnerPlayerId: 'p1'
      }
    ]
  });

  const app = express();
  app.use(routes);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    sessionRegistry.getOrHydrate = originalGetOrHydrate;
    await new Promise((resolve) => server.close(resolve));
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const response = await fetch(`http://127.0.0.1:${port}/session/session-1`);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.round.auditSeed, 'seed-visible');
  assert.equal(payload.boxes[0].rewardAmount, 2700);
  assert.equal(payload.boxes[0].isWinningBox, true);
});

test('buildSessionSnapshot exposes 2D timings before reveal and full results after reveal', () => {
  const session = createSessionContainer({
    playerCount: 5,
    stakeAmount: 1000,
    playerIds: ['p1', 'p2', 'p3', 'p4', 'p5'],
    platformFeeType: 'percentage',
    platformFeeValue: 10
  });
  const round = createRound({
    sessionId: session.sessionId,
    roundNumber: 1,
    playerIds: session.registeredPlayerIds
  });
  const players = createRoundPlayers(session.registeredPlayerIds);

  players[0].playerName = 'Alice';
  players[0].hasJoinedRound = true;
  players[0].currentBoxId = 'b1';
  players[0].initialBoxId = 'b1';
  players[0].initialBoxNumber = 1;
  players[0].swapState = SwapState.MATCHED;

  players[1].playerName = 'Bob';
  players[1].hasJoinedRound = true;
  players[1].currentBoxId = 'b2';
  players[1].initialBoxId = 'b2';
  players[1].initialBoxNumber = 2;
  players[1].swapState = SwapState.KEPT;

  const boxes = [
    { boxId: 'b1', boxNumber: 1, currentOwnerPlayerId: 'p1', rewardAmount: 0, isWinningBox: false },
    { boxId: 'b2', boxNumber: 2, currentOwnerPlayerId: 'p2', rewardAmount: 2700, isWinningBox: true }
  ];

  round.status = RoundStatus.SWAP_OPEN;
  round.distributionStartedAt = 1000;
  round.distributionEndsAt = 4000;
  round.swapStartedAt = 4000;
  round.swapActionClosesAt = 6100;
  round.swapEndsAt = 7000;

  const preReveal = buildSessionSnapshot({ session, round, players, boxes, playerId: 'p1' });
  assert.equal(preReveal.you.initialBoxNumber, 1);
  assert.equal(preReveal.you.currentBoxNumber, 1);
  assert.equal(preReveal.you.hasRevealOccurred, false);
  assert.equal(preReveal.you.result, null);
  assert.equal(preReveal.roundResults, null);
  assert.equal(preReveal.distributionStartedAt, 1000);
  assert.equal(preReveal.swapActionClosesAt, 6100);
  assert.equal('sceneGateEndsAt' in preReveal, false);
  assert.equal('readyEndsAt' in preReveal, false);
  assert.equal('sceneTrack' in preReveal, false);
  assert.equal('sceneLoadState' in preReveal.you, false);
  assert.equal('readyState' in preReveal.you, false);

  players[0].finalBoxId = 'b2';
  players[0].finalBoxNumber = 2;
  players[0].finalPrizeAmount = 2700;
  players[0].isWinner = true;

  players[1].finalBoxId = 'b1';
  players[1].finalBoxNumber = 1;
  players[1].finalPrizeAmount = 0;
  players[1].isWinner = false;

  round.status = RoundStatus.ROUND_ENDED;
  round.rewardPool = 4500;
  round.grossStakeTotal = 5000;
  round.feeAmount = 500;
  round.winnerCount = 1;

  const postReveal = buildSessionSnapshot({ session, round, players, boxes, playerId: 'p1' });
  assert.equal(postReveal.you.hasRevealOccurred, true);
  assert.deepEqual(postReveal.you.result, {
    playerId: 'p1',
    playerName: 'Alice',
    initialBoxNumber: 1,
    finalBoxNumber: 2,
    wasSwapped: true,
    isWinner: true,
    prizeAmount: 2700
  });
  assert.equal(postReveal.roundResults.allPlayers.length, 2);
  assert.equal(postReveal.roundResults.winnerList.length, 1);
  assert.equal(postReveal.roundResults.loserList.length, 1);
  assert.equal(postReveal.roundResults.allPlayers[0].playerId, 'p1');
});

test('buildSessionSnapshot keeps reveal barrier timing fields available before final results release', () => {
  const session = createSessionContainer({
    playerCount: 5,
    stakeAmount: 1000,
    playerIds: ['p1', 'p2', 'p3', 'p4', 'p5'],
    platformFeeType: 'percentage',
    platformFeeValue: 10
  });
  const round = createRound({
    sessionId: session.sessionId,
    roundNumber: 1,
    playerIds: session.registeredPlayerIds
  });
  const players = createRoundPlayers(session.registeredPlayerIds);
  const boxes = [{ boxId: 'b1', boxNumber: 1, currentOwnerPlayerId: 'p1', rewardAmount: 0, isWinningBox: false }];

  players[0].playerName = 'Alice';
  players[0].hasJoinedRound = true;
  players[0].currentBoxId = 'b1';
  players[0].initialBoxId = 'b1';
  players[0].initialBoxNumber = 1;
  players[0].swapState = SwapState.KEPT;

  round.status = RoundStatus.REVEALING;
  round.revealAt = 7100;
  round.preResultStartedAt = 7100;
  round.preResultReadyDeadlineAt = 13100;
  round.finalResultsReleaseAt = null;

  const snapshot = buildSessionSnapshot({ session, round, players, boxes, playerId: 'p1' });

  assert.equal(snapshot.revealAt, 7100);
  assert.equal(snapshot.preResultStartedAt, 7100);
  assert.equal(snapshot.preResultReadyDeadlineAt, 13100);
  assert.equal(snapshot.finalResultsReleaseAt, null);
  assert.equal(snapshot.you.hasRevealOccurred, false);
  assert.equal(snapshot.roundResults, null);
});

test('buildSessionCreatedPayload normalizes session bootstrap details', () => {
  const session = createSessionContainer({
    playerCount: 5,
    stakeAmount: 1000,
    playerIds: ['p1', 'p2', 'p3', 'p4', 'p5'],
    platformFeeType: 'percentage',
    platformFeeValue: 10
  });
  const round = createRound({
    sessionId: session.sessionId,
    roundNumber: 1,
    playerIds: session.registeredPlayerIds
  });
  const players = createRoundPlayers(session.registeredPlayerIds);

  players[0].playerName = 'Alice';
  players[0].isConnected = true;
  players[0].hasJoinedRound = true;

  const payload = buildSessionCreatedPayload({
    eventName: 'session.created',
    session,
    round,
    players
  });

  assert.equal(payload.eventName, 'session.created');
  assert.equal(payload.eventVersion, 1);
  assert.equal(payload.registeredPlayerCountForSession, 5);
  assert.equal(payload.totalStakeAmount, 5000);
  assert.equal(payload.platformFee.effectivePercentage, 10);
  assert.equal(payload.rewardPool, 4500);
  assert.equal(payload.players.length, 5);
  assert.equal(payload.currentRoundId, session.currentRoundId);
});

test('buildRoundStartedPayload includes normalized economy, players, and boxes', () => {
  const session = {
    sessionId: 's1',
    stakeAmount: 1000,
    platformFeeType: 'percentage',
    platformFeeValueSnapshot: 10,
    registeredPlayerIds: ['p1', 'p2', 'p3', 'p4', 'p5']
  };
  const round = {
    roundId: 'r1',
    roundNumber: 1,
    expectedPlayerCountForRound: 5,
    joinedPlayerIdsForRound: ['p1', 'p2', 'p3', 'p4', 'p5'],
    status: RoundStatus.DISTRIBUTING,
    grossStakeTotal: 5000,
    feeAmount: 500,
    rewardPool: 4500,
    distributionStartedAt: 1000,
    distributionEndsAt: 4000
  };
  const players = [
    {
      playerId: 'p1',
      playerName: 'Alice',
      hasJoinedRound: true,
      connectedAtStartOfRound: true,
      initialBoxId: 'b1',
      initialBoxNumber: 1,
      finalBoxId: 'b2',
      finalBoxNumber: 2,
      swapRequested: true,
      swapMatched: true,
      finalPrizeAmount: 2700,
      isWinner: true
    },
    {
      playerId: 'p2',
      playerName: 'Bob',
      hasJoinedRound: false,
      connectedAtStartOfRound: false,
      initialBoxId: 'b2',
      initialBoxNumber: 2,
      participationLabel: 'REGISTERED_ABSENT'
    }
  ];
  const boxes = [
    {
      boxId: 'b1',
      boxNumber: 1,
      rewardAmount: 0,
      isWinningBox: false,
      initialOwnerPlayerId: 'p1',
      currentOwnerPlayerId: 'p2'
    },
    {
      boxId: 'b2',
      boxNumber: 2,
      rewardAmount: 2700,
      isWinningBox: true,
      initialOwnerPlayerId: 'p2',
      currentOwnerPlayerId: 'p1'
    }
  ];

  const payload = buildRoundStartedPayload({
    eventName: 'round.started',
    session,
    round,
    players,
    boxes,
    reason: 'all_players_joined'
  });

  assert.equal(payload.eventName, 'round.started');
  assert.equal(payload.status, 'distributing');
  assert.equal(payload.totalStakeAmount, 5000);
  assert.equal(payload.platformFee.feeAmount, 500);
  assert.equal(payload.rewardPool, 4500);
  assert.equal(payload.connectedPlayerCountAtRoundStart, 1);
  assert.equal(payload.players.length, 2);
  assert.equal(payload.boxes.length, 2);
  assert.equal(payload.distributionStartedAt, 1000);
});

test('buildRoundSwapMatchedPayload includes before and after box ownership summaries', () => {
  const session = { sessionId: 's1' };
  const round = { roundId: 'r1', roundNumber: 1 };
  const players = [
    { playerId: 'p1', playerName: 'Alice' },
    { playerId: 'p2', playerName: 'Bob' }
  ];
  const boxes = [
    { boxId: 'b1', boxNumber: 1, rewardAmount: 0, isWinningBox: false, initialOwnerPlayerId: 'p1', currentOwnerPlayerId: 'p2' },
    { boxId: 'b2', boxNumber: 2, rewardAmount: 2700, isWinningBox: true, initialOwnerPlayerId: 'p2', currentOwnerPlayerId: 'p1' }
  ];

  const payload = buildRoundSwapMatchedPayload({
    eventName: 'round.swap_matched',
    session,
    round,
    players,
    boxes,
    matched: {
      matchedAt: 1234,
      firstPlayerId: 'p1',
      secondPlayerId: 'p2',
      firstBoxId: 'b1',
      secondBoxId: 'b2'
    }
  });

  assert.equal(payload.firstPlayer.playerName, 'Alice');
  assert.equal(payload.secondPlayer.playerName, 'Bob');
  assert.equal(payload.firstBoxBefore.boxId, 'b1');
  assert.equal(payload.firstBoxAfter.boxId, 'b2');
  assert.equal(payload.swapMatch.firstPlayerId, 'p1');
});

test('buildRoundEndedPayload includes winners, losers, platform fee, and swap summaries', () => {
  const session = {
    sessionId: 's1',
    stakeAmount: 1000,
    platformFeeType: 'percentage',
    platformFeeValueSnapshot: 10,
    registeredPlayerIds: ['p1', 'p2', 'p3', 'p4', 'p5']
  };
  const round = {
    roundId: 'r1',
    roundNumber: 1,
    expectedPlayerCountForRound: 5,
    joinedPlayerIdsForRound: ['p1', 'p2'],
    grossStakeTotal: 5000,
    feeAmount: 500,
    rewardPool: 4500,
    distributionStartedAt: 1000,
    distributionEndsAt: 4000,
    swapStartedAt: 4000,
    swapActionClosesAt: 6100,
    swapEndsAt: 7000,
    swapClosedAt: 7100,
    revealAt: 7100,
    preResultStartedAt: 7100,
    preResultReadyDeadlineAt: 13100,
    finalResultsReleaseAt: 14300,
    finalResultsSentAt: 14350,
    endedAt: 14350,
    roundEndReason: 'completed'
  };
  const players = [
    {
      playerId: 'p1',
      playerName: 'Alice',
      hasJoinedRound: true,
      isConnected: true,
      connectedAtStartOfRound: true,
      participationLabel: 'ROUND_COMPLETE',
      initialBoxId: 'b1',
      initialBoxNumber: 1,
      finalBoxId: 'b2',
      finalBoxNumber: 2,
      swapRequested: true,
      swapMatched: true,
      finalPrizeAmount: 2700,
      isWinner: true
    },
    {
      playerId: 'p2',
      playerName: 'Bob',
      hasJoinedRound: true,
      isConnected: false,
      connectedAtStartOfRound: false,
      participationLabel: 'ROUND_COMPLETE',
      initialBoxId: 'b2',
      initialBoxNumber: 2,
      finalBoxId: 'b1',
      finalBoxNumber: 1,
      swapRequested: false,
      swapMatched: true,
      finalPrizeAmount: 0,
      isWinner: false
    }
  ];
  const boxes = [
    {
      boxId: 'b1',
      boxNumber: 1,
      rewardAmount: 0,
      isWinningBox: false,
      initialOwnerPlayerId: 'p1',
      currentOwnerPlayerId: 'p2'
    },
    {
      boxId: 'b2',
      boxNumber: 2,
      rewardAmount: 2700,
      isWinningBox: true,
      initialOwnerPlayerId: 'p2',
      currentOwnerPlayerId: 'p1'
    }
  ];
  const swaps = {
    matched: [{ matchedAt: 5555, firstPlayerId: 'p1', secondPlayerId: 'p2', firstBoxId: 'b1', secondBoxId: 'b2' }]
  };

  const payload = buildRoundEndedPayload({
    eventName: 'round.ended',
    session,
    round,
    players,
    boxes,
    swaps
  });

  assert.equal(payload.eventName, 'round.ended');
  assert.equal(payload.totalStakeAmount, 5000);
  assert.equal(payload.platformFee.effectivePercentage, 10);
  assert.equal(payload.players.length, 2);
  assert.equal(payload.boxes.length, 2);
  assert.equal(payload.swapMatches.length, 1);
  assert.equal(payload.winners.length, 1);
  assert.equal(payload.losers.length, 1);
  assert.equal(payload.players[0].swapMatchedWithPlayerId, 'p2');
  assert.equal(payload.winners[0].playerId, 'p1');
  assert.equal(payload.losers[0].playerId, 'p2');
});

test('buildSessionEndedPayload stays lightweight and references only the last round', () => {
  const payload = buildSessionEndedPayload({
    eventName: 'session.ended',
    session: {
      sessionId: 's1',
      stakeAmount: 1000,
      platformFeeType: 'fixed',
      platformFeeValueSnapshot: 500,
      currentExpectedPlayerCount: 5,
      roundCount: 3,
      endReason: 'replay_timeout',
      endedAt: 20000
    },
    round: {
      roundId: 'r3',
      roundNumber: 3,
      grossStakeTotal: 5000,
      feeAmount: 500
    }
  });

  assert.equal(payload.eventName, 'session.ended');
  assert.equal(payload.roundCount, 3);
  assert.equal(payload.lastRoundId, 'r3');
  assert.equal(payload.lastRoundNumber, 3);
  assert.equal(payload.platformFee.effectivePercentage, 10);
  assert.equal('players' in payload, false);
  assert.equal('boxes' in payload, false);
});

test('validateEnv accepts the current pre-result config and rejects invalid barrier timings', () => {
  const previousReadyTimeout = config.preResultReadyTimeoutMs;
  const previousHold = config.preResultHoldMs;

  try {
    assert.doesNotThrow(() => validateEnv());
    assert.equal('revealPhaseMs' in config, false);

    config.preResultReadyTimeoutMs = 0;
    assert.throws(() => validateEnv(), /PRE_RESULT_READY_TIMEOUT_MS/);

    config.preResultReadyTimeoutMs = previousReadyTimeout;
    config.preResultHoldMs = 0;
    assert.throws(() => validateEnv(), /PRE_RESULT_HOLD_MS/);
  } finally {
    config.preResultReadyTimeoutMs = previousReadyTimeout;
    config.preResultHoldMs = previousHold;
  }
});

test('buildSessionSnapshot returns null player payload for unknown players', () => {
  const snapshot = buildSessionSnapshot({
    session: { sessionId: 's1', stakeAmount: 1000, status: SessionStatus.WAITING_FOR_FIRST_JOIN },
    round: {
      roundId: 'r1',
      roundNumber: 1,
      status: RoundStatus.WAITING_FOR_FIRST_JOIN,
      joinDeadlineAt: null,
      distributionStartedAt: null,
      distributionEndsAt: null,
      swapStartedAt: null,
      swapActionClosesAt: null,
      swapEndsAt: null,
      swapClosedAt: null,
      revealAt: null,
      grossStakeTotal: null,
      feeAmount: null,
      rewardPool: null,
      winnerCount: null
    },
    players: [],
    boxes: [],
    playerId: 'missing'
  });

  assert.equal(snapshot.you, null);
  assert.equal(snapshot.summary.stakeAmount, 1000);
});

test('admin dlq routes list, inspect, resend, and clear items behind control auth', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'open-box-admin-dlq-'));
  const previousDlqDir = config.dlqDir;
  const previousControlToken = config.controlApiToken;
  const previousFetch = globalThis.fetch;
  config.dlqDir = tempDir;
  config.controlApiToken = 'secret-token';

  const app = express();
  app.use(routes);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  t.after(async () => {
    config.dlqDir = previousDlqDir;
    config.controlApiToken = previousControlToken;
    globalThis.fetch = previousFetch;
    await fs.rm(tempDir, { recursive: true, force: true });
    await new Promise((resolve) => server.close(resolve));
  });

  const dlqItemId = '11111111-1111-4111-8111-111111111111';
  await fs.writeFile(
    path.join(tempDir, `${dlqItemId}.json`),
    JSON.stringify({
      dlqItemId,
      failedAt: new Date().toISOString(),
      endpoint: 'http://example.test/webhook',
      eventId: 'event-1',
      eventName: 'round.ended',
      reason: 'Permanent failure with status 401',
      lastResponseStatus: 401,
      deliveryAttempts: [],
      webhookPayload: {
        eventId: 'event-1',
        eventName: 'round.ended',
        eventVersion: 1,
        occurredAt: Date.now(),
        sessionId: 'session-1',
        roundId: 'round-1',
        roundNumber: 1
      }
    }, null, 2)
  );

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;
  globalThis.fetch = async (url, options) => {
    if (typeof url === 'string' && url.startsWith(baseUrl)) {
      return previousFetch(url, options);
    }
    return { ok: true, status: 200 };
  };
  const headers = { authorization: 'Bearer secret-token' };

  const listResponse = await fetch(`${baseUrl}/admin/dlq`, { headers });
  const listPayload = await listResponse.json();
  assert.equal(listResponse.status, 200);
  assert.equal(listPayload.items.length, 1);
  assert.equal(listPayload.items[0].dlqItemId, dlqItemId);

  const getResponse = await fetch(`${baseUrl}/admin/dlq/${dlqItemId}`, { headers });
  const getPayload = await getResponse.json();
  assert.equal(getResponse.status, 200);
  assert.equal(getPayload.eventName, 'round.ended');

  const resendResponse = await fetch(`${baseUrl}/admin/dlq/${dlqItemId}/resend`, {
    method: 'POST',
    headers
  });
  const resendPayload = await resendResponse.json();
  assert.equal(resendResponse.status, 200);
  assert.equal(resendPayload.ok, true);
  assert.equal((await fs.readdir(tempDir)).length, 0);

  await fs.writeFile(
    path.join(tempDir, `${dlqItemId}.json`),
    JSON.stringify({
      dlqItemId,
      failedAt: new Date().toISOString(),
      endpoint: 'http://example.test/webhook',
      eventId: 'event-2',
      eventName: 'session.ended',
      reason: 'Exhausted 3 retry attempts.',
      lastResponseStatus: 503,
      deliveryAttempts: [],
      webhookPayload: {
        eventId: 'event-2',
        eventName: 'session.ended',
        eventVersion: 1,
        occurredAt: Date.now(),
        sessionId: 'session-2',
        roundId: 'round-2',
        roundNumber: 2
      }
    }, null, 2)
  );

  const clearResponse = await fetch(`${baseUrl}/admin/dlq`, {
    method: 'DELETE',
    headers
  });
  const clearPayload = await clearResponse.json();
  assert.equal(clearResponse.status, 200);
  assert.equal(clearPayload.clearedCount, 1);
});
