import config from '../../src/config.js';
import redisStore from '../../src/store/redisStore.js';
import { createRound, createRoundPlayers, createSessionContainer } from '../../src/domain/sessionState.js';
import { SessionRuntime } from '../../src/runtime/sessionRuntime.js';

export function installRedisStoreStubs() {
  const originals = {
    setSession: redisStore.setSession,
    setRound: redisStore.setRound,
    setPlayers: redisStore.setPlayers,
    setBoxes: redisStore.setBoxes,
    setSwaps: redisStore.setSwaps,
    setReplayState: redisStore.setReplayState,
    getReplayState: redisStore.getReplayState,
    getEvents: redisStore.getEvents,
    pushEvent: redisStore.pushEvent,
    removeActiveSession: redisStore.removeActiveSession,
    claimPlayerActiveSession: redisStore.claimPlayerActiveSession,
    releasePlayerActiveSession: redisStore.releasePlayerActiveSession
  };

  const calls = [];
  const noOp = async (...args) => {
    calls.push(args);
  };

  redisStore.setSession = async (...args) => noOp('setSession', ...args);
  redisStore.setRound = async (...args) => noOp('setRound', ...args);
  redisStore.setPlayers = async (...args) => noOp('setPlayers', ...args);
  redisStore.setBoxes = async (...args) => noOp('setBoxes', ...args);
  redisStore.setSwaps = async (...args) => noOp('setSwaps', ...args);
  redisStore.setReplayState = async (...args) => noOp('setReplayState', ...args);
  redisStore.getReplayState = async () => null;
  redisStore.getEvents = async () => [];
  redisStore.pushEvent = async (...args) => noOp('pushEvent', ...args);
  redisStore.removeActiveSession = async (...args) => noOp('removeActiveSession', ...args);
  redisStore.claimPlayerActiveSession = async (...args) => {
    calls.push(['claimPlayerActiveSession', ...args]);
    return { ok: true, activeSessionId: args[1] || null };
  };
  redisStore.releasePlayerActiveSession = async (...args) => noOp('releasePlayerActiveSession', ...args);

  return {
    calls,
    restore() {
      Object.assign(redisStore, originals);
    }
  };
}

export async function createRuntimeFixture({
  playerIds = ['p1', 'p2', 'p3', 'p4', 'p5'],
  stakeAmount = 1000,
  platformFeeType = config.platformFeeType,
  platformFeeValue = config.platformFeeValue
} = {}) {
  const session = createSessionContainer({
    playerCount: playerIds.length,
    stakeAmount,
    playerIds,
    platformFeeType,
    platformFeeValue
  });
  const round = createRound({
    sessionId: session.sessionId,
    roundNumber: 1,
    playerIds
  });
  const players = createRoundPlayers(playerIds);
  session.currentRoundId = round.roundId;

  const runtime = new SessionRuntime(session);
  await runtime.initializeNewRound(round, players);
  return { runtime, session, round, players };
}

export function createFakeSocket() {
  return {
    readyState: 1,
    sent: [],
    send(raw) {
      this.sent.push(JSON.parse(raw));
    }
  };
}

export function clearRuntimeTimers(runtime) {
  Object.entries(runtime.timers).forEach(([name, timer]) => {
    if (name === 'playerReady') {
      for (const entry of timer.values()) clearTimeout(entry);
      return;
    }
    clearTimeout(timer);
  });
}
