import test from 'node:test';
import assert from 'node:assert/strict';
import redisStore from '../src/store/redisStore.js';
import { sessionRegistry } from '../src/runtime/sessionRegistry.js';
import { createRound, createRoundPlayers, createSessionContainer } from '../src/domain/sessionState.js';
import { RoundStatus } from '../src/shared/protocol.js';
import { clearRuntimeTimers, installRedisStoreStubs } from './helpers/runtimeHarness.js';

function stubRegistryStore(session, round, players, boxes = [], swaps = { queue: [], matched: [], keepers: [] }, replayState = null) {
  const originals = {
    getSession: redisStore.getSession,
    getRound: redisStore.getRound,
    getPlayers: redisStore.getPlayers,
    getBoxes: redisStore.getBoxes,
    getSwaps: redisStore.getSwaps,
    getReplayState: redisStore.getReplayState,
    claimPlayerActiveSession: redisStore.claimPlayerActiveSession
  };

  redisStore.getSession = async () => session;
  redisStore.getRound = async () => round;
  redisStore.getPlayers = async () => players;
  redisStore.getBoxes = async () => boxes;
  redisStore.getSwaps = async () => swaps;
  redisStore.getReplayState = async () => replayState;
  redisStore.claimPlayerActiveSession = async (playerId, sessionId) => ({
    ok: true,
    activeSessionId: sessionId || playerId
  });

  return () => {
    Object.assign(redisStore, originals);
  };
}

test('sessionRegistry.createSession creates and caches a runtime', async (t) => {
  const stub = installRedisStoreStubs();
  const runtime = await sessionRegistry.createSession({
    playerCount: 5,
    stakeAmount: 1000,
    playerIds: ['p1', 'p2', 'p3', 'p4', 'p5'],
    platformFeeType: 'percentage',
    platformFeeValue: 10
  });
  t.after(() => clearRuntimeTimers(runtime));
  t.after(() => {
    sessionRegistry.runtimes.delete(runtime.session.sessionId);
    stub.restore();
  });

  assert.equal(sessionRegistry.get(runtime.session.sessionId), runtime);
  assert.equal(runtime.round.expectedPlayerCountForRound, 5);
});

test('sessionRegistry.createSession rejects players already locked to another active session', async (t) => {
  const stub = installRedisStoreStubs();
  const originalClaim = redisStore.claimPlayerActiveSession;
  redisStore.claimPlayerActiveSession = async (playerId, sessionId) => {
    stub.calls.push(['claimPlayerActiveSession', playerId, sessionId]);
    if (playerId === 'p3') {
      return { ok: false, activeSessionId: 'session-existing' };
    }
    return { ok: true, activeSessionId: sessionId };
  };

  t.after(() => {
    redisStore.claimPlayerActiveSession = originalClaim;
    stub.restore();
  });

  await assert.rejects(
    () =>
      sessionRegistry.createSession({
        playerCount: 5,
        stakeAmount: 1000,
        playerIds: ['p1', 'p2', 'p3', 'p4', 'p5'],
        platformFeeType: 'percentage',
        platformFeeValue: 10
      }),
    (error) => {
      assert.equal(error.code, 'PLAYER_ACTIVE_SESSION_CONFLICT');
      assert.equal(error.playerId, 'p3');
      assert.equal(error.activeSessionId, 'session-existing');
      return true;
    }
  );
});

test('sessionRegistry.hydrateSession rebuilds runtime state from the store', async () => {
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
  round.status = RoundStatus.JOIN_WINDOW_OPEN;
  round.firstJoinAt = Date.now();
  round.joinDeadlineAt = Date.now() + 1000;
  session.currentRoundId = round.roundId;
  const players = createRoundPlayers(session.registeredPlayerIds);

  const restore = stubRegistryStore(session, round, players);
  try {
    sessionRegistry.runtimes.delete(session.sessionId);
    const runtime = await sessionRegistry.hydrateSession(session.sessionId);
    clearTimeout(runtime.timers.joinDeadline);

    assert.equal(runtime.session.sessionId, session.sessionId);
    assert.equal(runtime.round.roundId, round.roundId);
    assert.equal(runtime.players.length, players.length);
    assert.equal(sessionRegistry.get(session.sessionId), runtime);
  } finally {
    restore();
    sessionRegistry.runtimes.delete(session.sessionId);
  }
});

test('sessionRegistry.getOrHydrate returns null for missing sessions', async () => {
  const originals = {
    getSession: redisStore.getSession
  };
  redisStore.getSession = async () => null;

  try {
    const runtime = await sessionRegistry.getOrHydrate('missing-session');
    assert.equal(runtime, null);
  } finally {
    Object.assign(redisStore, originals);
  }
});
