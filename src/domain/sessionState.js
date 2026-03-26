import { ParticipationLabel, RoundStatus, SessionStatus, SwapState } from '../shared/protocol.js';
import { createRoundId, createSessionId } from '../utils/ids.js';

export function createSessionContainer({ playerCount, stakeAmount, playerIds, platformFeeType, platformFeeValue }) {
  return {
    sessionId: createSessionId(),
    status: SessionStatus.WAITING_FOR_FIRST_JOIN,
    snapshotRevision: 0,
    initialExpectedPlayerCount: playerCount,
    currentExpectedPlayerCount: playerCount,
    stakeAmount,
    platformFeeType,
    platformFeeValueSnapshot: platformFeeValue,
    registeredPlayerIds: [...playerIds],
    roundCount: 1,
    currentRoundId: null,
    createdAt: Date.now(),
    endedAt: null,
    endReason: null
  };
}

export function createRound({ sessionId, roundNumber, playerIds }) {
  return {
    roundId: createRoundId(),
    sessionId,
    roundNumber,
    status: RoundStatus.WAITING_FOR_FIRST_JOIN,
    expectedPlayerCountForRound: playerIds.length,
    registeredPlayerIdsForRound: [...playerIds],
    joinedPlayerIdsForRound: [],
    gatePlayerIdsForRound: [],
    firstJoinAt: null,
    joinDeadlineAt: null,
    distributionStartedAt: null,
    distributionEndsAt: null,
    swapStartedAt: null,
    swapActionClosesAt: null,
    swapClosedAt: null,
    swapEndsAt: null,
    revealAt: null,
    preResultStartedAt: null,
    preResultReadyDeadlineAt: null,
    finalResultsReleaseAt: null,
    finalResultsSentAt: null,
    preResultExpectedReadyPlayerIds: [],
    preResultReadyPlayerIds: [],
    endedAt: null,
    grossStakeTotal: null,
    feeAmount: null,
    rewardPool: null,
    winnerBase: null,
    winnerCount: null,
    auditSeed: null,
    roundEndReason: null
  };
}

export function createRoundPlayers(playerIds) {
  return playerIds.map((playerId) => ({
    playerId,
    playerName: null,
    isRegistered: true,
    hasJoinedRound: false,
    isConnected: false,
    joinedAt: null,
    lastSeenAt: null,
    assignedBoxId: null,
    currentBoxId: null,
    swapState: SwapState.NONE,
    finalPrizeAmount: null,
    isWinner: null,
    participationLabel: ParticipationLabel.REGISTERED_ABSENT,
    connectedAtStartOfRound: false,
    initialBoxId: null,
    initialBoxNumber: null,
    finalBoxId: null,
    finalBoxNumber: null,
    swapRequested: false,
    swapMatched: false
  }));
}

export function findPlayer(players, playerId) {
  return players.find((player) => player.playerId === playerId) || null;
}
