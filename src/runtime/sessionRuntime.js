import {
  ClientMessageType,
  ParticipationLabel,
  RoundStatus,
  ServerMessageType,
  SessionStatus,
  SwapState,
  WebhookEventType
} from '../shared/protocol.js';
import { CONTAINER_SIZE, getDistributionDurationMs, getSwapActionCloseOffsetMs } from '../shared/twod.js';
import config from '../config.js';
import redisStore from '../store/redisStore.js';
import { buildBoxes } from '../domain/prizes.js';
import { closeSwaps, requestSwap } from '../domain/swaps.js';
import { buildRoundResultsSnapshot, buildSessionSnapshot } from './snapshot.js';
import { createRound, createRoundPlayers, findPlayer } from '../domain/sessionState.js';
import { dispatchWebhook } from '../webhooks/dispatcher.js';
import { notifyMatchmakingSessionClosed } from '../webhooks/matchmakingNotifier.js';
import {
  MINIMUM_PLAYERS_TO_START,
  buildPlayerConnectionPayload,
  buildPlayerJoinedPayload,
  buildRoundCancelledPayload,
  buildRoundEndedPayload,
  buildRoundJoinWindowStartedPayload,
  buildRoundStartedPayload,
  buildRoundSwapMatchedPayload,
  buildSessionEndedPayload,
  buildSessionReplayStartedPayload,
  buildSessionReplayWaitingPayload
} from '../webhooks/payloads.js';
import { send, sendError } from '../ws/wsProtocol.js';

export class SessionRuntime {
  constructor(session) {
    this.session = session;
    this.round = null;
    this.players = [];
    this.boxes = [];
    this.swaps = { queue: [], matched: [], keepers: [] };
    this.connections = new Map();
    this.timers = {
      joinDeadline: null,
      distribution: null,
      swapSoftLock: null,
      swapClose: null,
      preResultReadyTimeout: null,
      finalResultsRelease: null,
      replayEnd: null
    };
  }

  clearTimer(name) {
    if (!this.timers[name]) return;
    clearTimeout(this.timers[name]);
    this.timers[name] = null;
  }

  clearAllTimers() {
    for (const name of Object.keys(this.timers)) {
      this.clearTimer(name);
    }
  }

  async initializeNewRound(round, players) {
    this.clearAllTimers();
    this.round = round;
    this.players = players;
    this.boxes = [];
    this.swaps = { queue: [], matched: [], keepers: [] };
    this.session.currentRoundId = round.roundId;
    await redisStore.setReplayState(this.session.sessionId, null);
    await this.persistVisibleState();
  }

  attachConnection(playerId, ws) {
    this.connections.set(playerId, ws);
    ws.playerId = playerId;
    ws.sessionId = this.session.sessionId;
  }

  detachConnection(playerId) {
    this.connections.delete(playerId);
  }

  getJoinedCount() {
    return this.players.filter((player) => player.hasJoinedRound).length;
  }

  getCurrentBoxNumber(playerId) {
    const box = this.boxes.find((entry) => entry.currentOwnerPlayerId === playerId);
    return box?.boxNumber || null;
  }

  async releasePlayerLocks(playerIds = []) {
    const uniquePlayerIds = [...new Set((playerIds || []).filter(Boolean))];
    await Promise.allSettled(
      uniquePlayerIds.map((playerId) =>
        redisStore.releasePlayerActiveSession(playerId, this.session.sessionId)
      )
    );
  }

  async persist() {
    await redisStore.setSession(this.session);
    await redisStore.setRound(this.round);
    await redisStore.setPlayers(this.session.sessionId, this.players);
    await redisStore.setBoxes(this.session.sessionId, this.round.roundId, this.boxes);
    await redisStore.setSwaps(this.session.sessionId, this.round.roundId, this.swaps);
  }

  async appendEvent(type, payload = {}) {
    await redisStore.pushEvent(this.session.sessionId, {
      type,
      sessionId: this.session.sessionId,
      roundId: this.round?.roundId || null,
      roundNumber: this.round?.roundNumber || null,
      timestamp: Date.now(),
      payload
    });
  }

  broadcast(type, payload = {}, targetPlayerId = null) {
    for (const [playerId, ws] of this.connections.entries()) {
      if (targetPlayerId && playerId !== targetPlayerId) continue;
      send(ws, type, payload);
    }
  }

  async sendSnapshot(playerId) {
    const ws = this.connections.get(playerId);
    if (!ws || !this.round) return;
    send(
      ws,
      ServerMessageType.SESSION_SNAPSHOT,
      buildSessionSnapshot({
        session: this.session,
        round: this.round,
        players: this.players,
        boxes: this.boxes,
        playerId
      })
    );
  }

  bumpSnapshotRevision() {
    this.session.snapshotRevision = (this.session.snapshotRevision || 0) + 1;
  }

  async persistVisibleState() {
    this.bumpSnapshotRevision();
    await this.persist();
  }

  async broadcastSnapshots(targetPlayerIds = null) {
    if (!this.round) return;
    const targetSet = targetPlayerIds
      ? new Set(Array.isArray(targetPlayerIds) ? targetPlayerIds : [targetPlayerIds])
      : null;

    for (const [playerId, ws] of this.connections.entries()) {
      if (targetSet && !targetSet.has(playerId)) continue;
      send(
        ws,
        ServerMessageType.SESSION_SNAPSHOT,
        buildSessionSnapshot({
          session: this.session,
          round: this.round,
          players: this.players,
          boxes: this.boxes,
          playerId
        })
      );
    }
  }

  async markJoinIntent({ playerId, playerName }) {
    const player = findPlayer(this.players, playerId);
    if (!player) return { ok: false, error: 'PLAYER_NOT_REGISTERED' };
    if ([SessionStatus.ENDED, SessionStatus.CANCELLED].includes(this.session.status)) {
      return { ok: false, error: 'SESSION_ENDED' };
    }

    const lateJoinPhase = [
      RoundStatus.DISTRIBUTING,
      RoundStatus.SWAP_OPEN,
      RoundStatus.SWAP_CLOSED,
      RoundStatus.REVEALING,
      RoundStatus.ROUND_ENDED,
      RoundStatus.ROUND_CANCELLED
    ].includes(this.round.status);

    player.playerName = playerName;
    player.lastSeenAt = Date.now();

    if (lateJoinPhase) {
      await this.persistVisibleState();
      await this.broadcastSnapshots(player.playerId);
      return {
        ok: true,
        sessionId: this.session.sessionId,
        roundId: this.round.roundId,
        joinDeadlineAt: this.round.joinDeadlineAt,
        lateJoin: !player.hasJoinedRound
      };
    }

    const wasFirstJoinForRound = !this.round.firstJoinAt;
    if (!player.hasJoinedRound) {
      player.hasJoinedRound = true;
      player.joinedAt = Date.now();
      player.participationLabel = ParticipationLabel.JOINED_ACTIVE;
      this.round.joinedPlayerIdsForRound.push(playerId);
      await dispatchWebhook(
        WebhookEventType.PLAYER_JOINED,
        buildPlayerJoinedPayload({
          eventName: WebhookEventType.PLAYER_JOINED,
          session: this.session,
          round: this.round,
          players: this.players,
          player,
          reason: wasFirstJoinForRound ? 'first_join' : 'joined_current_round'
        })
      );
    }

    if (!this.round.firstJoinAt) {
      this.round.firstJoinAt = Date.now();
      this.round.joinDeadlineAt = config.devWaitForAllPlayers
        ? null
        : this.round.firstJoinAt + config.firstJoinTimeoutMs;
      this.round.status = RoundStatus.JOIN_WINDOW_OPEN;
      this.session.status = SessionStatus.ROUND_ACTIVE;
      this.scheduleJoinDeadline();
      await this.appendEvent('round.join_window_started', { playerId });
      await dispatchWebhook(
        WebhookEventType.ROUND_JOIN_WINDOW_STARTED,
        buildRoundJoinWindowStartedPayload({
          eventName: WebhookEventType.ROUND_JOIN_WINDOW_STARTED,
          session: this.session,
          round: this.round,
          players: this.players,
          player,
          reason: 'first_join'
        })
      );
    }

    await this.persistVisibleState();
    await this.broadcastSnapshots();

    if (this.getJoinedCount() === this.round.expectedPlayerCountForRound) {
      await this.startRound('all_players_joined');
    }

    return {
      ok: true,
      sessionId: this.session.sessionId,
      roundId: this.round.roundId,
      joinDeadlineAt: this.round.joinDeadlineAt
    };
  }

  async handleHello(ws, message) {
    const playerId = message.playerId || message.playerID;
    const playerName = message.playerName || '';
    const player = findPlayer(this.players, playerId);
    if (!player) {
      sendError(ws, 'PLAYER_NOT_REGISTERED', 'Player is not registered for this session');
      return;
    }

    const wasDisconnected = player.participationLabel === ParticipationLabel.DISCONNECTED;
    player.playerName = playerName || player.playerName;
    player.isConnected = true;
    player.lastSeenAt = Date.now();
    player.participationLabel = player.hasJoinedRound
      ? ParticipationLabel.RECONNECTED
      : ParticipationLabel.REGISTERED_ABSENT;

    this.attachConnection(playerId, ws);

    send(ws, ServerMessageType.WELCOME, {
      playerId,
      playerName: player.playerName,
      sessionId: this.session.sessionId,
      roundId: this.round.roundId,
      sessionStatus: this.session.status,
      roundStatus: this.round.status
    });

    await this.persistVisibleState();
    await this.broadcastSnapshots();

    if (wasDisconnected) {
      await dispatchWebhook(
        WebhookEventType.PLAYER_RECONNECTED,
        buildPlayerConnectionPayload({
          eventName: WebhookEventType.PLAYER_RECONNECTED,
          session: this.session,
          round: this.round,
          players: this.players,
          player,
          reason: 'hello'
        })
      );
    }
  }

  scheduleJoinDeadline() {
    this.clearTimer('joinDeadline');

    this.broadcast(ServerMessageType.JOIN_WINDOW_STARTED, {
      sessionId: this.session.sessionId,
      roundId: this.round.roundId,
      roundNumber: this.round.roundNumber,
      joinDeadlineAt: config.devWaitForAllPlayers ? null : this.round.joinDeadlineAt
    });

    if (config.devWaitForAllPlayers || !this.round.joinDeadlineAt) {
      return;
    }

    const delay = Math.max(0, this.round.joinDeadlineAt - Date.now());
    this.timers.joinDeadline = setTimeout(() => {
      this.handleJoinDeadline().catch((error) => console.error(error));
    }, delay);
  }

  async handleJoinDeadline() {
    if (config.devWaitForAllPlayers) return;

    const joinedCount = this.getJoinedCount();
    if (joinedCount < MINIMUM_PLAYERS_TO_START) {
      this.round.status = RoundStatus.ROUND_CANCELLED;
      this.round.roundEndReason = 'joined_below_minimum';
      this.round.endedAt = Date.now();
      this.session.status = SessionStatus.CANCELLED;
      this.session.endedAt = Date.now();
      this.session.endReason = 'joined_below_minimum';
      await this.persistVisibleState();
      await this.appendEvent('round.cancelled', { joinedCount });
      const sessionEndedPayload = buildSessionEndedPayload({
        eventName: WebhookEventType.SESSION_ENDED,
        session: this.session,
        round: this.round
      });
      await dispatchWebhook(
        WebhookEventType.ROUND_CANCELLED,
        buildRoundCancelledPayload({
          eventName: WebhookEventType.ROUND_CANCELLED,
          session: this.session,
          round: this.round,
          players: this.players,
          minimumPlayersRequired: MINIMUM_PLAYERS_TO_START
        })
      );
      await dispatchWebhook(WebhookEventType.SESSION_ENDED, sessionEndedPayload);
      await notifyMatchmakingSessionClosed(sessionEndedPayload);
      this.broadcast(ServerMessageType.SESSION_ENDED, {
        sessionId: this.session.sessionId,
        reason: this.round.roundEndReason
      });
      await this.broadcastSnapshots();
      await this.releasePlayerLocks(this.session.registeredPlayerIds);
      await redisStore.removeActiveSession(this.session.sessionId);
      return;
    }

    await this.startRound('join_deadline_reached');
  }

  async startRound(reason) {
    if (![RoundStatus.JOIN_WINDOW_OPEN, RoundStatus.WAITING_FOR_FIRST_JOIN].includes(this.round.status)) {
      return;
    }

    this.clearTimer('joinDeadline');

    const allocation = buildBoxes({
      registeredPlayerIds: this.round.registeredPlayerIdsForRound,
      stakeAmount: this.session.stakeAmount,
      platformFeeType: this.session.platformFeeType,
      platformFeeValue: this.session.platformFeeValueSnapshot
    });

    this.round.grossStakeTotal = allocation.grossStakeTotal;
    this.round.feeAmount = allocation.feeAmount;
    this.round.rewardPool = allocation.rewardPool;
    this.round.winnerBase = allocation.winnerBase;
    this.round.winnerCount = allocation.winnerCount;
    this.round.auditSeed = allocation.auditSeed;
    this.boxes = allocation.boxes;

    for (const player of this.players) {
      const ownedBox = this.boxes.find((box) => box.initialOwnerPlayerId === player.playerId);
      player.connectedAtStartOfRound = player.isConnected;
      player.assignedBoxId = ownedBox?.boxId || null;
      player.currentBoxId = ownedBox?.boxId || null;
      player.initialBoxId = ownedBox?.boxId || null;
      player.initialBoxNumber = ownedBox?.boxNumber || null;
      player.finalBoxId = null;
      player.finalBoxNumber = null;
      player.finalPrizeAmount = null;
      player.isWinner = null;
      player.swapRequested = false;
      player.swapMatched = false;
      player.swapState = SwapState.NONE;
      player.participationLabel = player.isConnected
        ? ParticipationLabel.JOINED_ACTIVE
        : ParticipationLabel.REGISTERED_ABSENT;
    }

    const distributionStartedAt = Date.now();
    const distributionDurationMs =
      getDistributionDurationMs({
        totalPlayers: this.round.expectedPlayerCountForRound,
        containerSize: CONTAINER_SIZE
      }) + config.distributionBufferMs;

    this.round.status = RoundStatus.DISTRIBUTING;
    this.round.distributionStartedAt = distributionStartedAt;
    this.round.distributionEndsAt = distributionStartedAt + distributionDurationMs;
    this.round.swapStartedAt = null;
    this.round.swapActionClosesAt = null;
    this.round.swapEndsAt = null;
    this.round.swapClosedAt = null;
    this.round.revealAt = null;
    this.round.preResultStartedAt = null;
    this.round.preResultReadyDeadlineAt = null;
    this.round.finalResultsReleaseAt = null;
    this.round.finalResultsSentAt = null;
    this.round.preResultExpectedReadyPlayerIds = [];
    this.round.preResultReadyPlayerIds = [];
    await this.persistVisibleState();
    await this.appendEvent('round.started', { reason });
    await dispatchWebhook(
      WebhookEventType.ROUND_STARTED,
      buildRoundStartedPayload({
        eventName: WebhookEventType.ROUND_STARTED,
        session: this.session,
        round: this.round,
        players: this.players,
        boxes: this.boxes,
        reason
      })
    );

    this.broadcast(ServerMessageType.ROUND_STARTED, {
      roundId: this.round.roundId,
      roundNumber: this.round.roundNumber,
      reason,
      distributionStartedAt: this.round.distributionStartedAt,
      distributionEndsAt: this.round.distributionEndsAt
    });

    for (const player of this.players) {
      this.broadcast(
        ServerMessageType.BOX_ASSIGNED,
        {
          playerId: player.playerId,
          boxNumber: player.initialBoxNumber
        },
        player.playerId
      );
    }

    await this.broadcastSnapshots();

    this.timers.distribution = setTimeout(() => {
      this.openSwapWindow().catch((error) => console.error(error));
    }, Math.max(0, this.round.distributionEndsAt - Date.now()));
  }

  async openSwapWindow() {
    if (this.round.status !== RoundStatus.DISTRIBUTING) return;

    const swapStartedAt = Date.now();
    const swapActionOffsetMs = getSwapActionCloseOffsetMs({
      swapPhaseMs: config.swapPhaseMs,
      softLockPercent: config.swapSoftLockPercent
    });

    this.round.status = RoundStatus.SWAP_OPEN;
    this.round.swapStartedAt = swapStartedAt;
    this.round.swapActionClosesAt = Math.min(
      swapStartedAt + swapActionOffsetMs,
      swapStartedAt + config.swapPhaseMs
    );
    this.round.swapEndsAt = swapStartedAt + config.swapPhaseMs;
    this.round.swapClosedAt = null;
    this.round.revealAt = null;
    await this.persistVisibleState();

    this.broadcast(ServerMessageType.SWAP_WINDOW_OPEN, {
      swapStartedAt: this.round.swapStartedAt,
      swapActionClosesAt: this.round.swapActionClosesAt,
      swapEndsAt: this.round.swapEndsAt,
      revealAt: null
    });
    await this.broadcastSnapshots();

    this.clearTimer('swapSoftLock');
    this.timers.swapSoftLock = setTimeout(() => {
      this.applySwapSoftLock().catch((error) => console.error(error));
    }, Math.max(0, this.round.swapActionClosesAt - Date.now()));

    this.timers.swapClose = setTimeout(() => {
      this.closeSwapWindow().catch((error) => console.error(error));
    }, Math.max(0, this.round.swapEndsAt - Date.now()));
  }

  async handleSwapRequest(playerId) {
    if (this.round.status !== RoundStatus.SWAP_OPEN) {
      return { ok: false, error: 'SWAP_CLOSED' };
    }

    const now = Date.now();
    if (this.round.swapEndsAt && now >= this.round.swapEndsAt) {
      return { ok: false, error: 'SWAP_CLOSED' };
    }
    if (this.round.swapActionClosesAt && now >= this.round.swapActionClosesAt) {
      return { ok: false, error: 'SWAP_SOFT_LOCKED' };
    }

    const result = requestSwap({
      players: this.players,
      boxes: this.boxes,
      swaps: this.swaps,
      playerId
    });
    if (!result.ok) return result;

    await this.persistVisibleState();
    if (result.pending) {
      this.broadcast(ServerMessageType.SWAP_PENDING, { playerId }, playerId);
      await this.broadcastSnapshots();
      return result;
    }

    await dispatchWebhook(
      WebhookEventType.ROUND_SWAP_MATCHED,
      buildRoundSwapMatchedPayload({
        eventName: WebhookEventType.ROUND_SWAP_MATCHED,
        session: this.session,
        round: this.round,
        players: this.players,
        boxes: this.boxes,
        matched: result.matched
      })
    );

    for (const swapPlayerId of [result.matched.firstPlayerId, result.matched.secondPlayerId]) {
      const currentBox = this.boxes.find((box) => box.currentOwnerPlayerId === swapPlayerId);
      this.broadcast(
        ServerMessageType.SWAP_MATCHED,
        {
          playerId: swapPlayerId,
          newBoxNumber: currentBox?.boxNumber || null
        },
        swapPlayerId
      );
    }
    await this.broadcastSnapshots();
    return result;
  }

  async handleKeepBox(playerId) {
    const player = findPlayer(this.players, playerId);
    if (!player) return { ok: false, error: 'PLAYER_NOT_FOUND' };
    if (this.round.status !== RoundStatus.SWAP_OPEN) return { ok: false, error: 'SWAP_CLOSED' };
    if (this.round.swapEndsAt && Date.now() >= this.round.swapEndsAt) return { ok: false, error: 'SWAP_CLOSED' };
    if (player.swapState !== SwapState.NONE) return { ok: false, error: 'SWAP_ALREADY_USED' };

    player.swapState = SwapState.KEPT;
    this.swaps.keepers.push({ playerId, keptAt: Date.now(), auto: false });
    await this.persistVisibleState();
    await this.broadcastSnapshots();
    return { ok: true };
  }

  autoKeepRemainingPlayers() {
    const autoKeptPlayerIds = [];
    for (const player of this.players) {
      if (player.swapState !== SwapState.NONE) continue;
      player.swapState = SwapState.KEPT;
      this.swaps.keepers.push({
        playerId: player.playerId,
        keptAt: Date.now(),
        auto: true
      });
      autoKeptPlayerIds.push(player.playerId);
    }
    return autoKeptPlayerIds;
  }

  resolvePendingSwapsToUnmatched() {
    return closeSwaps({ players: this.players, swaps: this.swaps });
  }

  broadcastSwapUnmatched(playerIds) {
    for (const playerId of playerIds) {
      this.broadcast(ServerMessageType.SWAP_UNMATCHED, { playerId }, playerId);
    }
  }

  async applySwapSoftLock() {
    this.clearTimer('swapSoftLock');
    if (this.round.status !== RoundStatus.SWAP_OPEN) return [];

    const unmatchedPlayerIds = this.resolvePendingSwapsToUnmatched();
    const autoKeptPlayerIds = this.autoKeepRemainingPlayers();
    if (!unmatchedPlayerIds.length && !autoKeptPlayerIds.length) {
      return {
        unmatchedPlayerIds: [],
        autoKeptPlayerIds: []
      };
    }

    await this.persistVisibleState();
    this.broadcastSwapUnmatched(unmatchedPlayerIds);
    await this.broadcastSnapshots();
    return {
      unmatchedPlayerIds,
      autoKeptPlayerIds
    };
  }

  getPreResultExpectedReadyPlayerIds() {
    return this.players
      .filter((player) => player.isConnected)
      .map((player) => player.playerId)
      .sort();
  }

  async enterPreResultBarrier() {
    const now = Date.now();
    this.clearTimer('preResultReadyTimeout');
    this.clearTimer('finalResultsRelease');

    this.round.status = RoundStatus.REVEALING;
    this.round.revealAt = now;
    this.round.preResultStartedAt = now;
    this.round.preResultReadyDeadlineAt = now + config.preResultReadyTimeoutMs;
    this.round.finalResultsReleaseAt = null;
    this.round.finalResultsSentAt = null;
    this.round.preResultExpectedReadyPlayerIds = this.getPreResultExpectedReadyPlayerIds();
    this.round.preResultReadyPlayerIds = [];
    await this.persistVisibleState();

    this.broadcast(ServerMessageType.REVEAL_START, {
      roundId: this.round.roundId,
      roundNumber: this.round.roundNumber,
      revealAt: this.round.revealAt,
      preResultStartedAt: this.round.preResultStartedAt,
      preResultReadyDeadlineAt: this.round.preResultReadyDeadlineAt,
      finalResultsReleaseAt: this.round.finalResultsReleaseAt
    });
    await this.broadcastSnapshots();

    if (!this.round.preResultExpectedReadyPlayerIds.length) {
      await this.resolvePreResultBarrier();
      return;
    }

    this.timers.preResultReadyTimeout = setTimeout(() => {
      this.resolvePreResultBarrier().catch((error) => console.error(error));
    }, Math.max(0, this.round.preResultReadyDeadlineAt - Date.now()));
  }

  async handlePreResultReady(playerId) {
    if (this.round.status !== RoundStatus.REVEALING) {
      return { ok: true, ignored: true };
    }
    if (this.round.finalResultsReleaseAt || this.round.finalResultsSentAt) {
      return { ok: true, ignored: true };
    }
    if (!this.round.preResultExpectedReadyPlayerIds.includes(playerId)) {
      return { ok: true, ignored: true };
    }
    if (this.round.preResultReadyPlayerIds.includes(playerId)) {
      return { ok: true, duplicate: true };
    }

    this.round.preResultReadyPlayerIds = [...this.round.preResultReadyPlayerIds, playerId].sort();
    await this.persistVisibleState();

    if (
      this.round.preResultReadyPlayerIds.length >= this.round.preResultExpectedReadyPlayerIds.length
    ) {
      await this.resolvePreResultBarrier();
    }
    return { ok: true };
  }

  async resolvePreResultBarrier() {
    if (this.round.status !== RoundStatus.REVEALING) return;
    if (this.round.finalResultsReleaseAt || this.round.finalResultsSentAt) return;

    this.clearTimer('preResultReadyTimeout');
    this.round.finalResultsReleaseAt = Date.now() + config.preResultHoldMs;
    await this.persistVisibleState();
    await this.broadcastSnapshots();

    this.timers.finalResultsRelease = setTimeout(() => {
      this.releaseRoundResults().catch((error) => console.error(error));
    }, Math.max(0, this.round.finalResultsReleaseAt - Date.now()));
  }

  finalizePlayerResults() {
    for (const player of this.players) {
      const finalBox = this.boxes.find((box) => box.currentOwnerPlayerId === player.playerId);
      player.finalBoxId = finalBox?.boxId || null;
      player.finalBoxNumber = finalBox?.boxNumber || null;
      player.finalPrizeAmount = finalBox?.rewardAmount ?? 0;
      player.isWinner = !!finalBox?.isWinningBox;
      player.participationLabel = ParticipationLabel.ROUND_COMPLETE;
    }
  }

  async releaseRoundResults() {
    if (this.round.status !== RoundStatus.REVEALING) return;
    if (this.round.finalResultsSentAt) return;

    this.clearTimer('preResultReadyTimeout');
    this.clearTimer('finalResultsRelease');
    this.finalizePlayerResults();

    this.round.finalResultsSentAt = Date.now();
    this.round.status = RoundStatus.ROUND_ENDED;
    this.round.endedAt = this.round.finalResultsSentAt;
    this.session.status = SessionStatus.REPLAY_WAITING;
    await this.persistVisibleState();

    for (const player of this.players) {
      this.broadcast(
        ServerMessageType.PLAYER_RESULT,
        {
          playerId: player.playerId,
          playerName: player.playerName,
          initialBoxNumber: player.initialBoxNumber,
          finalBoxNumber: player.finalBoxNumber,
          wasSwapped: player.initialBoxId !== player.finalBoxId,
          isWinner: player.isWinner,
          prizeAmount: player.finalPrizeAmount
        },
        player.playerId
      );
    }

    const roundResults = buildRoundResultsSnapshot({
      session: this.session,
      round: this.round,
      players: this.players
    });
    this.broadcast(ServerMessageType.ROUND_RESULTS, roundResults);

    const payload = buildRoundEndedPayload({
      eventName: WebhookEventType.ROUND_ENDED,
      session: this.session,
      round: this.round,
      players: this.players,
      boxes: this.boxes,
      swaps: this.swaps
    });
    await dispatchWebhook(WebhookEventType.ROUND_ENDED, payload);
    await dispatchWebhook(
      WebhookEventType.SESSION_REPLAY_WAITING,
      buildSessionReplayWaitingPayload({
        eventName: WebhookEventType.SESSION_REPLAY_WAITING,
        session: this.session,
        round: this.round,
        players: this.players,
        replayWaitMs: config.replayWaitMs,
        replayBufferMs: config.replayBufferMs
      })
    );

    const replayWaitEndsAt = Date.now() + config.replayWaitMs + config.replayBufferMs;
    await redisStore.setReplayState(this.session.sessionId, {
      replayWaitEndsAt,
      roundId: this.round.roundId
    });

    this.broadcast(ServerMessageType.REPLAY_WAITING, {
      replayWaitEndsAt
    });
    await this.broadcastSnapshots();

    this.timers.replayEnd = setTimeout(() => {
      this.endSession('replay_timeout').catch((error) => console.error(error));
    }, Math.max(0, replayWaitEndsAt - Date.now()));
  }

  async closeSwapWindow() {
    if (this.round.status !== RoundStatus.SWAP_OPEN) return;
    this.clearTimer('swapSoftLock');
    this.clearTimer('swapClose');

    const unmatchedPlayerIds = this.resolvePendingSwapsToUnmatched();
    this.autoKeepRemainingPlayers();

    this.round.status = RoundStatus.SWAP_CLOSED;
    this.round.swapClosedAt = Date.now();
    this.round.revealAt = this.round.swapClosedAt;
    await this.persistVisibleState();

    this.broadcastSwapUnmatched(unmatchedPlayerIds);

    this.broadcast(ServerMessageType.SWAP_WINDOW_CLOSED, {
      swapStartedAt: this.round.swapStartedAt,
      swapActionClosesAt: this.round.swapActionClosesAt,
      swapEndsAt: this.round.swapEndsAt,
      swapClosedAt: this.round.swapClosedAt,
      revealAt: this.round.revealAt
    });
    await this.broadcastSnapshots();
    await this.enterPreResultBarrier();
  }

  async revealRound() {
    if (this.round.status !== RoundStatus.SWAP_CLOSED) return;
    await this.enterPreResultBarrier();
  }

  async handleSocketMessage(ws, message) {
    switch (message.type) {
      case ClientMessageType.PONG: {
        const player = findPlayer(this.players, ws.playerId);
        if (player) {
          player.lastSeenAt = Date.now();
          if (!player.isConnected) player.isConnected = true;
          await this.persist();
        }
        return;
      }
      case ClientMessageType.SWAP_REQUEST: {
        const result = await this.handleSwapRequest(ws.playerId);
        if (!result.ok) sendError(ws, result.error, 'Unable to request swap');
        return;
      }
      case ClientMessageType.KEEP_BOX: {
        const result = await this.handleKeepBox(ws.playerId);
        if (!result.ok) sendError(ws, result.error, 'Unable to keep box');
        return;
      }
      case ClientMessageType.PRE_RESULT_READY: {
        await this.handlePreResultReady(ws.playerId);
        return;
      }
      default:
        sendError(ws, 'UNKNOWN_TYPE', `Unknown type ${message.type}`);
    }
  }

  async handleDisconnect(playerId, reason = 'socket_close') {
    const player = findPlayer(this.players, playerId);
    if (!player) return;
    if (!player.isConnected) return;
    player.isConnected = false;
    player.lastSeenAt = Date.now();
    player.participationLabel = ParticipationLabel.DISCONNECTED;
    this.detachConnection(playerId);

    const shouldResolveBarrier =
      this.round?.status === RoundStatus.REVEALING &&
      !this.round.finalResultsReleaseAt &&
      !this.round.finalResultsSentAt;

    if (shouldResolveBarrier) {
      this.round.preResultExpectedReadyPlayerIds = this.round.preResultExpectedReadyPlayerIds.filter(
        (entry) => entry !== playerId
      );
      this.round.preResultReadyPlayerIds = this.round.preResultReadyPlayerIds.filter(
        (entry) => entry !== playerId
      );
    }

    await this.persistVisibleState();
    await this.broadcastSnapshots();
    await dispatchWebhook(
      WebhookEventType.PLAYER_DISCONNECTED,
      buildPlayerConnectionPayload({
        eventName: WebhookEventType.PLAYER_DISCONNECTED,
        session: this.session,
        round: this.round,
        players: this.players,
        player,
        reason
      })
    );

    if (
      shouldResolveBarrier &&
      this.round.preResultReadyPlayerIds.length >= this.round.preResultExpectedReadyPlayerIds.length
    ) {
      await this.resolvePreResultBarrier();
    }
  }

  async handleHeartbeatTimeouts(now) {
    for (const player of this.players) {
      if (!player.isConnected) continue;
      if (!player.lastSeenAt || now - player.lastSeenAt <= config.heartbeatTimeoutMs) continue;
      await this.handleDisconnect(player.playerId, 'heartbeat_timeout');
    }
  }

  async createReplayRound(playerIds) {
    const previousPlayerIds = [...this.session.registeredPlayerIds];
    const removedPlayerIds = previousPlayerIds.filter((playerId) => !playerIds.includes(playerId));
    this.clearAllTimers();
    this.session.status = SessionStatus.WAITING_FOR_FIRST_JOIN;
    this.session.currentExpectedPlayerCount = playerIds.length;
    this.session.roundCount += 1;
    this.session.registeredPlayerIds = [...playerIds];
    const round = createRound({
      sessionId: this.session.sessionId,
      roundNumber: this.session.roundCount,
      playerIds
    });
    const players = createRoundPlayers(playerIds);
    await this.initializeNewRound(round, players);
    await dispatchWebhook(
      WebhookEventType.SESSION_REPLAY_STARTED,
      buildSessionReplayStartedPayload({
        eventName: WebhookEventType.SESSION_REPLAY_STARTED,
        session: this.session,
        round,
        players,
        replayPlayerIds: playerIds
      })
    );
    this.broadcast(ServerMessageType.REPLAY_ACCEPTED, {
      sessionId: this.session.sessionId,
      roundId: round.roundId,
      roundNumber: round.roundNumber
    });
    await this.broadcastSnapshots();
    if (removedPlayerIds.length) {
      await this.releasePlayerLocks(removedPlayerIds);
    }
  }

  async resumeTimers(replayState = null) {
    if (!this.round) return;

    if (this.round.status === RoundStatus.JOIN_WINDOW_OPEN && this.round.joinDeadlineAt) {
      this.scheduleJoinDeadline();
      return;
    }

    if (this.round.status === RoundStatus.DISTRIBUTING && this.round.distributionEndsAt) {
      this.clearTimer('distribution');
      this.timers.distribution = setTimeout(() => {
        this.openSwapWindow().catch((error) => console.error(error));
      }, Math.max(0, this.round.distributionEndsAt - Date.now()));
      return;
    }

    if (this.round.status === RoundStatus.SWAP_OPEN && this.round.swapEndsAt) {
      if (this.round.swapActionClosesAt) {
        this.clearTimer('swapSoftLock');
        if (Date.now() >= this.round.swapActionClosesAt) {
          await this.applySwapSoftLock();
        } else {
          this.timers.swapSoftLock = setTimeout(() => {
            this.applySwapSoftLock().catch((error) => console.error(error));
          }, Math.max(0, this.round.swapActionClosesAt - Date.now()));
        }
      }

      this.clearTimer('swapClose');
      this.timers.swapClose = setTimeout(() => {
        this.closeSwapWindow().catch((error) => console.error(error));
      }, Math.max(0, this.round.swapEndsAt - Date.now()));
      return;
    }

    if (this.round.status === RoundStatus.SWAP_CLOSED) {
      await this.enterPreResultBarrier();
      return;
    }

    if (this.round.status === RoundStatus.REVEALING) {
      if (this.round.finalResultsReleaseAt) {
        this.clearTimer('finalResultsRelease');
        if (Date.now() >= this.round.finalResultsReleaseAt) {
          await this.releaseRoundResults();
        } else {
          this.timers.finalResultsRelease = setTimeout(() => {
            this.releaseRoundResults().catch((error) => console.error(error));
          }, Math.max(0, this.round.finalResultsReleaseAt - Date.now()));
        }
        return;
      }

      if (!this.round.preResultReadyDeadlineAt) {
        await this.enterPreResultBarrier();
        return;
      }

      if (
        this.round.preResultReadyPlayerIds.length >= this.round.preResultExpectedReadyPlayerIds.length ||
        Date.now() >= this.round.preResultReadyDeadlineAt
      ) {
        await this.resolvePreResultBarrier();
        return;
      }

      this.clearTimer('preResultReadyTimeout');
      this.timers.preResultReadyTimeout = setTimeout(() => {
        this.resolvePreResultBarrier().catch((error) => console.error(error));
      }, Math.max(0, this.round.preResultReadyDeadlineAt - Date.now()));
      return;
    }

    if (this.session.status === SessionStatus.REPLAY_WAITING && replayState?.replayWaitEndsAt) {
      this.clearTimer('replayEnd');
      this.timers.replayEnd = setTimeout(() => {
        this.endSession('replay_timeout').catch((error) => console.error(error));
      }, Math.max(0, replayState.replayWaitEndsAt - Date.now()));
    }
  }

  async endSession(reason) {
    this.clearAllTimers();
    this.session.status = SessionStatus.ENDED;
    this.session.endedAt = Date.now();
    this.session.endReason = reason;
    await this.persistVisibleState();
    const payload = buildSessionEndedPayload({
      eventName: WebhookEventType.SESSION_ENDED,
      session: this.session,
      round: this.round
    });
    await dispatchWebhook(WebhookEventType.SESSION_ENDED, payload);
    await notifyMatchmakingSessionClosed(payload);
    this.broadcast(ServerMessageType.SESSION_ENDED, {
      sessionId: this.session.sessionId,
      reason
    });
    await this.broadcastSnapshots();
    await this.releasePlayerLocks(this.session.registeredPlayerIds);
    await redisStore.removeActiveSession(this.session.sessionId);
  }
}
