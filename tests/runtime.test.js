import test from 'node:test';
import assert from 'node:assert/strict';
import config from '../src/config.js';
import { RoundStatus, ServerMessageType, SessionStatus, SwapState } from '../src/shared/protocol.js';
import {
  clearRuntimeTimers,
  createFakeSocket,
  createRuntimeFixture,
  installRedisStoreStubs
} from './helpers/runtimeHarness.js';

function withStubbedStore(t) {
  const stub = installRedisStoreStubs();
  t.after(() => stub.restore());
  return stub;
}

function withConfigOverride(t, key, value) {
  const previous = config[key];
  config[key] = value;
  t.after(() => {
    config[key] = previous;
  });
}

function withWebhookCapture(t) {
  const events = [];
  const previousFetch = globalThis.fetch;
  const previousEndpoints = config.webhookEndpoints;
  const previousRetrySchedule = config.webhookRetryScheduleMs;
  const previousMaxAttempts = config.maxWebhookAttempts;

  config.webhookEndpoints = ['http://webhook.test/events'];
  config.webhookRetryScheduleMs = [0];
  config.maxWebhookAttempts = 1;
  globalThis.fetch = async (_url, options = {}) => {
    events.push(JSON.parse(options.body));
    return { ok: true, status: 200 };
  };

  t.after(() => {
    config.webhookEndpoints = previousEndpoints;
    config.webhookRetryScheduleMs = previousRetrySchedule;
    config.maxWebhookAttempts = previousMaxAttempts;
    globalThis.fetch = previousFetch;
  });

  return events;
}

async function joinPlayers(runtime, playerIds) {
  for (const playerId of playerIds) {
    await runtime.markJoinIntent({ playerId, playerName: playerId });
  }
}

async function readyPlayers(runtime, playerIds) {
  for (const playerId of playerIds) {
    await runtime.handleRoundReady(playerId);
  }
}

async function joinAndReadyAll(runtime, playerIds) {
  await joinPlayers(runtime, playerIds);
  assert.equal(runtime.round.status, RoundStatus.READY_CHECK);
  await readyPlayers(runtime, playerIds);
}

test('first join intent starts the join window countdown', async (t) => {
  withStubbedStore(t);
  withConfigOverride(t, 'devWaitForAllPlayers', false);
  const { runtime } = await createRuntimeFixture();
  t.after(() => clearRuntimeTimers(runtime));

  const result = await runtime.markJoinIntent({ playerId: 'p1', playerName: 'Alice' });

  assert.equal(result.ok, true);
  assert.equal(runtime.round.status, RoundStatus.JOIN_WINDOW_OPEN);
  assert.equal(runtime.session.status, SessionStatus.ROUND_ACTIVE);
  assert.equal(runtime.round.joinedPlayerIdsForRound.length, 1);
  assert.ok(runtime.round.joinDeadlineAt > runtime.round.firstJoinAt);
});

test('join deadline below minimum cancels the session', async (t) => {
  const stub = withStubbedStore(t);
  withConfigOverride(t, 'devWaitForAllPlayers', false);
  const { runtime } = await createRuntimeFixture({ playerIds: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'] });
  t.after(() => clearRuntimeTimers(runtime));

  for (const playerId of ['p1', 'p2', 'p3', 'p4']) {
    await runtime.markJoinIntent({ playerId, playerName: playerId.toUpperCase() });
  }

  await runtime.handleJoinDeadline();

  assert.equal(runtime.round.status, RoundStatus.ROUND_CANCELLED);
  assert.equal(runtime.session.status, SessionStatus.CANCELLED);
  assert.equal(runtime.session.endReason, 'joined_below_minimum');
  assert.equal(stub.calls.some((entry) => entry[0] === 'removeActiveSession'), true);
  assert.equal(stub.calls.some((entry) => entry[0] === 'releasePlayerActiveSession'), true);
});

test('dev wait mode keeps the join window open until all players join, then enters ready check before distributing', async (t) => {
  withStubbedStore(t);
  withConfigOverride(t, 'devWaitForAllPlayers', true);
  const { runtime } = await createRuntimeFixture();
  t.after(() => clearRuntimeTimers(runtime));

  const result = await runtime.markJoinIntent({ playerId: 'p1', playerName: 'Alice' });

  assert.equal(result.ok, true);
  assert.equal(runtime.round.status, RoundStatus.JOIN_WINDOW_OPEN);
  assert.equal(runtime.round.joinDeadlineAt, null);
  assert.equal(runtime.timers.joinDeadline, null);

  await joinPlayers(runtime, ['p2', 'p3', 'p4', 'p5']);
  assert.equal(runtime.round.status, RoundStatus.READY_CHECK);
  await readyPlayers(runtime, ['p1', 'p2', 'p3', 'p4', 'p5']);
  assert.equal(runtime.round.status, RoundStatus.DISTRIBUTING);
  assert.ok(runtime.round.distributionStartedAt > 0);
  assert.ok(runtime.round.distributionEndsAt > runtime.round.distributionStartedAt);
});

test('join success enters ready check and then distributing with 2D timestamps', async (t) => {
  withStubbedStore(t);
  withConfigOverride(t, 'devWaitForAllPlayers', false);
  const { runtime } = await createRuntimeFixture();
  t.after(() => clearRuntimeTimers(runtime));

  await runtime.handleHello(createFakeSocket(), { playerId: 'p1', playerName: 'Alice' });
  await runtime.handleHello(createFakeSocket(), { playerId: 'p2', playerName: 'Bob' });

  await joinPlayers(runtime, ['p1', 'p2', 'p3', 'p4', 'p5']);
  assert.equal(runtime.round.status, RoundStatus.READY_CHECK);
  assert.equal(runtime.round.readyPlayerIdsForRound.length, 0);
  await readyPlayers(runtime, ['p1', 'p2', 'p3', 'p4', 'p5']);
  assert.equal(runtime.round.status, RoundStatus.DISTRIBUTING);
  assert.equal(runtime.round.grossStakeTotal, 5000);
  assert.ok(runtime.round.distributionStartedAt > 0);
  assert.ok(runtime.round.distributionEndsAt > runtime.round.distributionStartedAt);
  assert.equal(runtime.round.swapStartedAt, null);
});

test('late join intent after round start is accepted without mutating joined count', async (t) => {
  withStubbedStore(t);
  const { runtime } = await createRuntimeFixture({ playerIds: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'] });
  t.after(() => clearRuntimeTimers(runtime));

  await joinPlayers(runtime, ['p1', 'p2', 'p3', 'p4', 'p5']);
  await runtime.startRound('test');

  const joinedCountBefore = runtime.getJoinedCount();
  const result = await runtime.markJoinIntent({ playerId: 'p6', playerName: 'Late Player' });

  assert.equal(result.ok, true);
  assert.equal(result.lateJoin, true);
  assert.equal(runtime.getJoinedCount(), joinedCountBefore);
  assert.equal(runtime.players.find((player) => player.playerId === 'p6').playerName, 'Late Player');
});

test('startRound counts absent registered players in the economy and assignment', async (t) => {
  withStubbedStore(t);
  const { runtime } = await createRuntimeFixture({ playerIds: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'] });
  t.after(() => clearRuntimeTimers(runtime));

  await joinPlayers(runtime, ['p1', 'p2', 'p3', 'p4', 'p5']);
  await runtime.startRound('test');

  assert.equal(runtime.round.status, RoundStatus.DISTRIBUTING);
  assert.equal(runtime.round.grossStakeTotal, 6000);
  assert.equal(runtime.players.length, 6);
  assert.equal(runtime.boxes.length, 6);

  const absent = runtime.players.find((player) => player.playerId === 'p6');
  assert.equal(absent.hasJoinedRound, false);
  assert.ok(absent.assignedBoxId);
  assert.ok(absent.currentBoxId);
});

test('handleHello sends welcome and snapshot for registered players', async (t) => {
  withStubbedStore(t);
  const { runtime } = await createRuntimeFixture();
  t.after(() => clearRuntimeTimers(runtime));

  const ws = createFakeSocket();
  await runtime.handleHello(ws, { playerId: 'p1', playerName: 'Alice' });

  assert.equal(ws.sent[0].type, ServerMessageType.WELCOME);
  assert.equal(ws.sent[1].type, ServerMessageType.SESSION_SNAPSHOT);
  assert.equal(runtime.connections.get('p1'), ws);
});

test('join intents rebroadcast fresh snapshots to already connected clients', async (t) => {
  withStubbedStore(t);
  const { runtime } = await createRuntimeFixture();
  t.after(() => clearRuntimeTimers(runtime));

  const ws1 = createFakeSocket();
  const ws2 = createFakeSocket();
  await runtime.handleHello(ws1, { playerId: 'p1', playerName: 'Alice' });
  await runtime.handleHello(ws2, { playerId: 'p2', playerName: 'Bob' });
  ws1.sent = [];
  ws2.sent = [];

  await runtime.markJoinIntent({ playerId: 'p1', playerName: 'Alice' });
  await runtime.markJoinIntent({ playerId: 'p2', playerName: 'Bob' });

  const snapshots = ws1.sent.filter((entry) => entry.type === ServerMessageType.SESSION_SNAPSHOT);
  assert.equal(snapshots.length >= 2, true);
  assert.equal(snapshots[0].joinedPlayerCount, 1);
  assert.equal(snapshots.at(-1).joinedPlayerCount, 2);
  assert.equal(snapshots.at(-1).snapshotRevision > snapshots[0].snapshotRevision, true);
});

test('swap window computes the soft lock cutoff from total swap time and percent', async (t) => {
  withStubbedStore(t);
  withConfigOverride(t, 'swapPhaseMs', 1000);
  withConfigOverride(t, 'swapSoftLockPercent', 30);
  const { runtime } = await createRuntimeFixture();
  t.after(() => clearRuntimeTimers(runtime));

  await joinAndReadyAll(runtime, ['p1', 'p2', 'p3', 'p4', 'p5']);
  await runtime.openSwapWindow();

  assert.equal(runtime.round.status, RoundStatus.SWAP_OPEN);
  assert.equal(runtime.round.swapActionClosesAt - runtime.round.swapStartedAt, 700);
  assert.equal(runtime.round.swapEndsAt - runtime.round.swapStartedAt, 1000);
});

test('swap flow supports pending, matched, and keep states', async (t) => {
  withStubbedStore(t);
  const { runtime } = await createRuntimeFixture();
  t.after(() => clearRuntimeTimers(runtime));

  await joinAndReadyAll(runtime, ['p1', 'p2', 'p3', 'p4', 'p5']);
  await runtime.openSwapWindow();

  const pending = await runtime.handleSwapRequest('p1');
  assert.equal(pending.pending, true);
  assert.equal(runtime.players.find((player) => player.playerId === 'p1').swapState, SwapState.PENDING);

  const matched = await runtime.handleSwapRequest('p2');
  assert.equal(matched.ok, true);
  assert.equal(runtime.players.find((player) => player.playerId === 'p1').swapState, SwapState.MATCHED);
  assert.equal(runtime.players.find((player) => player.playerId === 'p2').swapState, SwapState.MATCHED);

  const kept = await runtime.handleKeepBox('p3');
  assert.equal(kept.ok, true);
  assert.equal(runtime.players.find((player) => player.playerId === 'p3').swapState, SwapState.KEPT);
});

test('matched swap broadcasts the success outcome and snapshot box number', async (t) => {
  withStubbedStore(t);
  const { runtime } = await createRuntimeFixture();
  t.after(() => clearRuntimeTimers(runtime));

  const ws1 = createFakeSocket();
  const ws2 = createFakeSocket();
  await runtime.handleHello(ws1, { playerId: 'p1', playerName: 'Alice' });
  await runtime.handleHello(ws2, { playerId: 'p2', playerName: 'Bob' });

  await joinAndReadyAll(runtime, ['p1', 'p2', 'p3', 'p4', 'p5']);
  const initialP1Box = runtime.players.find((player) => player.playerId === 'p1').currentBoxId;
  const initialP2Box = runtime.players.find((player) => player.playerId === 'p2').currentBoxId;
  await runtime.openSwapWindow();
  ws1.sent = [];
  ws2.sent = [];

  await runtime.handleSwapRequest('p1');
  await runtime.handleSwapRequest('p2');

  assert.equal(runtime.players.find((player) => player.playerId === 'p1').swapState, SwapState.MATCHED);
  assert.equal(runtime.players.find((player) => player.playerId === 'p2').swapState, SwapState.MATCHED);
  assert.notEqual(runtime.players.find((player) => player.playerId === 'p1').currentBoxId, initialP1Box);
  assert.notEqual(runtime.players.find((player) => player.playerId === 'p2').currentBoxId, initialP2Box);

  const p1MatchMessage = ws1.sent.find((entry) => entry.type === ServerMessageType.SWAP_MATCHED);
  const p2MatchMessage = ws2.sent.find((entry) => entry.type === ServerMessageType.SWAP_MATCHED);
  assert.ok(p1MatchMessage);
  assert.ok(p2MatchMessage);
  assert.ok(p1MatchMessage.newBoxNumber != null);
  assert.ok(p2MatchMessage.newBoxNumber != null);

  const p1Snapshot = ws1.sent.filter((entry) => entry.type === ServerMessageType.SESSION_SNAPSHOT).at(-1);
  const p2Snapshot = ws2.sent.filter((entry) => entry.type === ServerMessageType.SESSION_SNAPSHOT).at(-1);
  assert.equal(p1Snapshot.you.swapState, SwapState.MATCHED);
  assert.equal(p2Snapshot.you.swapState, SwapState.MATCHED);
  assert.equal(p1Snapshot.you.currentBoxNumber, p1MatchMessage.newBoxNumber);
  assert.equal(p2Snapshot.you.currentBoxNumber, p2MatchMessage.newBoxNumber);
});

test('soft lock resolves pending swaps to unmatched and auto-keeps untouched players', async (t) => {
  withStubbedStore(t);
  const { runtime } = await createRuntimeFixture();
  t.after(() => clearRuntimeTimers(runtime));

  await joinAndReadyAll(runtime, ['p1', 'p2', 'p3', 'p4', 'p5']);
  await runtime.openSwapWindow();
  await runtime.handleSwapRequest('p1');
  const result = await runtime.applySwapSoftLock();

  assert.deepEqual(result.unmatchedPlayerIds, ['p1']);
  assert.deepEqual(result.autoKeptPlayerIds.sort(), ['p2', 'p3', 'p4', 'p5']);
  assert.equal(runtime.players.find((player) => player.playerId === 'p1').swapState, SwapState.UNMATCHED);
  assert.equal(runtime.players.filter((player) => player.swapState === SwapState.KEPT).length, 4);
  assert.equal(runtime.players.some((player) => player.swapState === SwapState.PENDING), false);
});

test('swap request still fails after the soft-lock cutoff', async (t) => {
  withStubbedStore(t);
  const { runtime } = await createRuntimeFixture();
  t.after(() => clearRuntimeTimers(runtime));

  await joinAndReadyAll(runtime, ['p1', 'p2', 'p3', 'p4', 'p5']);
  await runtime.openSwapWindow();
  runtime.round.swapActionClosesAt = Date.now() - 1;

  const swapResult = await runtime.handleSwapRequest('p1');

  assert.equal(swapResult.ok, false);
  assert.equal(swapResult.error, 'SWAP_SOFT_LOCKED');
});

test('closeSwapWindow preserves unmatched soft-lock outcomes and ends the swap window', async (t) => {
  withStubbedStore(t);
  const { runtime } = await createRuntimeFixture();
  t.after(() => clearRuntimeTimers(runtime));

  await joinAndReadyAll(runtime, ['p1', 'p2', 'p3', 'p4', 'p5']);
  await runtime.openSwapWindow();
  await runtime.handleSwapRequest('p1');
  await runtime.applySwapSoftLock();
  await runtime.closeSwapWindow();

  assert.equal(runtime.players.find((player) => player.playerId === 'p1').swapState, SwapState.UNMATCHED);
  assert.equal(runtime.players.filter((player) => player.swapState === SwapState.KEPT).length, 4);
  assert.equal(runtime.players.some((player) => player.swapState === SwapState.PENDING), false);
  assert.equal(runtime.round.status, RoundStatus.REVEALING);
  assert.ok(runtime.round.swapClosedAt > 0);
  assert.ok(runtime.round.revealAt >= runtime.round.swapClosedAt);
  assert.ok(runtime.round.preResultStartedAt >= runtime.round.swapClosedAt);
  assert.ok(runtime.round.finalResultsReleaseAt >= runtime.round.preResultStartedAt);
});

test('soft lock broadcasts the no-match outcome before reveal starts', async (t) => {
  withStubbedStore(t);
  const { runtime } = await createRuntimeFixture();
  t.after(() => clearRuntimeTimers(runtime));

  const ws = createFakeSocket();
  await runtime.handleHello(ws, { playerId: 'p1', playerName: 'Alice' });

  await joinAndReadyAll(runtime, ['p1', 'p2', 'p3', 'p4', 'p5']);
  await runtime.openSwapWindow();
  ws.sent = [];

  await runtime.handleSwapRequest('p1');
  await runtime.applySwapSoftLock();

  const unmatchedMessage = ws.sent.find((entry) => entry.type === ServerMessageType.SWAP_UNMATCHED);
  const unmatchedIndex = ws.sent.findIndex((entry) => entry.type === ServerMessageType.SWAP_UNMATCHED);
  const latestSnapshot = ws.sent.filter((entry) => entry.type === ServerMessageType.SESSION_SNAPSHOT).at(-1);

  assert.ok(unmatchedMessage);
  assert.ok(unmatchedIndex >= 0);
  assert.equal(runtime.round.status, RoundStatus.SWAP_OPEN);
  assert.equal(latestSnapshot.you.swapState, SwapState.UNMATCHED);
});

test('swap end does not change already-settled unmatched outcomes after soft lock', async (t) => {
  withStubbedStore(t);
  const { runtime } = await createRuntimeFixture();
  t.after(() => clearRuntimeTimers(runtime));

  const ws = createFakeSocket();
  await runtime.handleHello(ws, { playerId: 'p1', playerName: 'Alice' });

  await joinAndReadyAll(runtime, ['p1', 'p2', 'p3', 'p4', 'p5']);
  await runtime.openSwapWindow();
  ws.sent = [];

  await runtime.handleSwapRequest('p1');
  await runtime.applySwapSoftLock();
  const unmatchedMessagesBeforeClose = ws.sent.filter((entry) => entry.type === ServerMessageType.SWAP_UNMATCHED).length;

  await runtime.closeSwapWindow();

  const unmatchedMessagesAfterClose = ws.sent.filter((entry) => entry.type === ServerMessageType.SWAP_UNMATCHED).length;
  assert.equal(runtime.players.find((player) => player.playerId === 'p1').swapState, SwapState.UNMATCHED);
  assert.equal(unmatchedMessagesAfterClose, unmatchedMessagesBeforeClose);
});

test('entering reveal starts the pre-result barrier immediately and counts only connected clients', async (t) => {
  withStubbedStore(t);
  const { runtime } = await createRuntimeFixture();
  t.after(() => clearRuntimeTimers(runtime));

  const ws = createFakeSocket();
  await runtime.handleHello(ws, { playerId: 'p1', playerName: 'Alice' });

  await joinAndReadyAll(runtime, ['p1', 'p2', 'p3', 'p4', 'p5']);
  await runtime.openSwapWindow();
  await runtime.closeSwapWindow();

  assert.equal(runtime.round.status, RoundStatus.REVEALING);
  assert.deepEqual(runtime.round.preResultExpectedReadyPlayerIds, ['p1']);
  assert.deepEqual(runtime.round.preResultReadyPlayerIds, []);
  assert.equal(runtime.round.finalResultsReleaseAt, null);
  assert.equal(ws.sent.some((entry) => entry.type === ServerMessageType.REVEAL_START), true);
  assert.equal(ws.sent.some((entry) => entry.type === ServerMessageType.ROUND_RESULTS), false);
});

test('duplicate PRE_RESULT_READY is idempotent and release waits for the configured hold', async (t) => {
  withStubbedStore(t);
  withConfigOverride(t, 'preResultHoldMs', 25);
  const { runtime } = await createRuntimeFixture();
  t.after(() => clearRuntimeTimers(runtime));

  const ws = createFakeSocket();
  await runtime.handleHello(ws, { playerId: 'p1', playerName: 'Alice' });

  await joinAndReadyAll(runtime, ['p1', 'p2', 'p3', 'p4', 'p5']);
  await runtime.openSwapWindow();
  await runtime.closeSwapWindow();

  const readyResult = await runtime.handlePreResultReady('p1');
  const duplicateResult = await runtime.handlePreResultReady('p1');

  assert.equal(readyResult.ok, true);
  assert.equal(duplicateResult.ok, true);
  assert.deepEqual(runtime.round.preResultReadyPlayerIds, ['p1']);
  assert.ok(runtime.round.finalResultsReleaseAt >= Date.now());
  assert.equal(ws.sent.some((entry) => entry.type === ServerMessageType.ROUND_RESULTS), false);

  runtime.round.finalResultsReleaseAt = Date.now() - 1;
  await runtime.resumeTimers();

  assert.equal(runtime.round.status, RoundStatus.ROUND_ENDED);
  assert.equal(runtime.session.status, SessionStatus.REPLAY_WAITING);
  assert.equal(runtime.players.every((player) => player.finalBoxNumber != null), true);
  assert.equal(runtime.players.every((player) => player.finalPrizeAmount != null), true);

  const roundResultsMessage = ws.sent.filter((entry) => entry.type === ServerMessageType.ROUND_RESULTS).at(-1);
  assert.equal(roundResultsMessage.allPlayers.length, runtime.players.length);
  assert.deepEqual(Object.keys(roundResultsMessage.allPlayers[0]).sort(), [
    'finalBoxNumber',
    'initialBoxNumber',
    'isWinner',
    'playerId',
    'playerName',
    'prizeAmount',
    'wasSwapped'
  ]);
});

test('disconnect during the pre-result barrier removes the player from the blocking set', async (t) => {
  withStubbedStore(t);
  const { runtime } = await createRuntimeFixture();
  t.after(() => clearRuntimeTimers(runtime));

  const ws = createFakeSocket();
  await runtime.handleHello(ws, { playerId: 'p1', playerName: 'Alice' });

  await joinAndReadyAll(runtime, ['p1', 'p2', 'p3', 'p4', 'p5']);
  await runtime.openSwapWindow();
  await runtime.closeSwapWindow();
  await runtime.handleDisconnect('p1');

  assert.deepEqual(runtime.round.preResultExpectedReadyPlayerIds, []);
  assert.deepEqual(runtime.round.preResultReadyPlayerIds, []);
  assert.ok(runtime.round.finalResultsReleaseAt != null);
});

test('pre-result timeout falls back to release even if some clients never report ready', async (t) => {
  withStubbedStore(t);
  const { runtime } = await createRuntimeFixture();
  t.after(() => clearRuntimeTimers(runtime));

  const ws = createFakeSocket();
  await runtime.handleHello(ws, { playerId: 'p1', playerName: 'Alice' });

  await joinAndReadyAll(runtime, ['p1', 'p2', 'p3', 'p4', 'p5']);
  await runtime.openSwapWindow();
  await runtime.closeSwapWindow();

  runtime.round.preResultReadyDeadlineAt = Date.now() - 1;
  await runtime.resumeTimers();

  assert.ok(runtime.round.finalResultsReleaseAt != null);

  runtime.round.finalResultsReleaseAt = Date.now() - 1;
  await runtime.resumeTimers();

  assert.equal(runtime.round.status, RoundStatus.ROUND_ENDED);
  assert.equal(ws.sent.some((entry) => entry.type === ServerMessageType.ROUND_RESULTS), true);
});

test('createReplayRound reuses the session and creates a new round', async (t) => {
  withStubbedStore(t);
  const { runtime } = await createRuntimeFixture({ playerIds: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'] });
  t.after(() => clearRuntimeTimers(runtime));

  const originalSessionId = runtime.session.sessionId;
  const originalRoundId = runtime.round.roundId;
  await runtime.createReplayRound(['p1', 'p2', 'p3', 'p4', 'p5']);

  assert.equal(runtime.session.sessionId, originalSessionId);
  assert.notEqual(runtime.round.roundId, originalRoundId);
  assert.equal(runtime.round.expectedPlayerCountForRound, 5);
  assert.equal(runtime.session.currentExpectedPlayerCount, 5);
  assert.equal(runtime.session.status, SessionStatus.WAITING_FOR_FIRST_JOIN);
});

test('createReplayRound releases locks for players excluded from replay', async (t) => {
  const stub = withStubbedStore(t);
  const { runtime } = await createRuntimeFixture({ playerIds: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'] });
  t.after(() => clearRuntimeTimers(runtime));

  await runtime.createReplayRound(['p1', 'p2', 'p3', 'p4', 'p5']);

  assert.equal(runtime.session.registeredPlayerIds.includes('p6'), false);
  assert.equal(
    stub.calls.some(
      (entry) => entry[0] === 'releasePlayerActiveSession' && entry[1] === 'p6' && entry[2] === runtime.session.sessionId
    ),
    true
  );
});

test('heartbeat timeout disconnects stale players', async (t) => {
  withStubbedStore(t);
  const { runtime } = await createRuntimeFixture();
  t.after(() => clearRuntimeTimers(runtime));

  const stalePlayer = runtime.players.find((player) => player.playerId === 'p1');
  stalePlayer.isConnected = true;
  stalePlayer.lastSeenAt = Date.now() - (config.heartbeatTimeoutMs + 500);

  await runtime.handleHeartbeatTimeouts(Date.now());

  assert.equal(stalePlayer.isConnected, false);
});

test('join and connection lifecycle emit normalized webhook events', async (t) => {
  withStubbedStore(t);
  const events = withWebhookCapture(t);
  const { runtime } = await createRuntimeFixture();
  t.after(() => clearRuntimeTimers(runtime));

  await runtime.markJoinIntent({ playerId: 'p1', playerName: 'Alice' });

  assert.equal(events.some((entry) => entry.eventName === 'player.joined'), true);
  assert.equal(events.some((entry) => entry.eventName === 'round.join_window_started'), true);

  await runtime.handleHello(createFakeSocket(), { playerId: 'p1', playerName: 'Alice' });
  await runtime.handleDisconnect('p1', 'socket_close');
  await runtime.handleHello(createFakeSocket(), { playerId: 'p1', playerName: 'Alice' });

  assert.equal(events.some((entry) => entry.eventName === 'player.disconnected'), true);
  assert.equal(events.some((entry) => entry.eventName === 'player.reconnected'), true);
});

test('endSession marks the session ended and clears active index', async (t) => {
  const stub = withStubbedStore(t);
  const { runtime } = await createRuntimeFixture();
  t.after(() => clearRuntimeTimers(runtime));

  await runtime.endSession('manual_end');

  assert.equal(runtime.session.status, SessionStatus.ENDED);
  assert.equal(runtime.session.endReason, 'manual_end');
  assert.equal(stub.calls.some((entry) => entry[0] === 'removeActiveSession'), true);
  assert.equal(stub.calls.some((entry) => entry[0] === 'releasePlayerActiveSession'), true);
});
