import redisStore from '../store/redisStore.js';
import { createRound, createRoundPlayers, createSessionContainer } from '../domain/sessionState.js';
import { SessionRuntime } from './sessionRuntime.js';

class SessionRegistry {
  constructor() {
    this.runtimes = new Map();
  }

  async claimPlayerLocksOrThrow(sessionId, playerIds) {
    const claimedPlayerIds = [];

    for (const playerId of playerIds) {
      const result = await redisStore.claimPlayerActiveSession(playerId, sessionId);
      if (result.ok) {
        claimedPlayerIds.push(playerId);
        continue;
      }

      await Promise.allSettled(
        claimedPlayerIds.map((claimedPlayerId) =>
          redisStore.releasePlayerActiveSession(claimedPlayerId, sessionId)
        )
      );

      const error = new Error(
        `Player ${playerId} is already active in session ${result.activeSessionId || 'unknown'}`
      );
      error.code = 'PLAYER_ACTIVE_SESSION_CONFLICT';
      error.playerId = playerId;
      error.activeSessionId = result.activeSessionId || null;
      throw error;
    }
  }

  async createSession({ playerCount, stakeAmount, playerIds, platformFeeType, platformFeeValue }) {
    const session = createSessionContainer({
      playerCount,
      stakeAmount,
      playerIds,
      platformFeeType,
      platformFeeValue
    });
    await this.claimPlayerLocksOrThrow(session.sessionId, playerIds);
    const round = createRound({
      sessionId: session.sessionId,
      roundNumber: 1,
      playerIds
    });
    const players = createRoundPlayers(playerIds);
    session.currentRoundId = round.roundId;

    const runtime = new SessionRuntime(session);
    await runtime.initializeNewRound(round, players);
    this.runtimes.set(session.sessionId, runtime);
    return runtime;
  }

  async hydrateSession(sessionId) {
    if (this.runtimes.has(sessionId)) return this.runtimes.get(sessionId);
    const session = await redisStore.getSession(sessionId);
    if (!session) return null;
    await this.claimPlayerLocksOrThrow(session.sessionId, session.registeredPlayerIds || []);

    const runtime = new SessionRuntime(session);
    runtime.round = await redisStore.getRound(sessionId, session.currentRoundId);
    runtime.players = await redisStore.getPlayers(sessionId);
    runtime.boxes = await redisStore.getBoxes(sessionId, session.currentRoundId);
    runtime.swaps = await redisStore.getSwaps(sessionId, session.currentRoundId);
    const replayState = await redisStore.getReplayState(sessionId);
    await runtime.resumeTimers(replayState);
    this.runtimes.set(sessionId, runtime);
    return runtime;
  }

  get(sessionId) {
    return this.runtimes.get(sessionId) || null;
  }

  async getOrHydrate(sessionId) {
    return this.get(sessionId) || this.hydrateSession(sessionId);
  }

  async handleHeartbeatTimeouts(now) {
    for (const runtime of this.runtimes.values()) {
      await runtime.handleHeartbeatTimeouts(now);
    }
  }

  values() {
    return [...this.runtimes.values()];
  }
}

export const sessionRegistry = new SessionRegistry();
export default sessionRegistry;
