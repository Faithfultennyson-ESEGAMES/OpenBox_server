import { RoundStatus } from '../shared/protocol.js';

function sortRoundResults(left, right) {
  if (left.isWinner !== right.isWinner) return left.isWinner ? -1 : 1;
  if (right.prizeAmount !== left.prizeAmount) return right.prizeAmount - left.prizeAmount;
  if ((left.finalBoxNumber || 0) !== (right.finalBoxNumber || 0)) {
    return (left.finalBoxNumber || 0) - (right.finalBoxNumber || 0);
  }
  return String(left.playerId).localeCompare(String(right.playerId));
}

export function buildRoundResultsSnapshot({ session, round, players }) {
  const completedPlayers = players
    .filter((entry) => entry.finalPrizeAmount != null)
    .map((entry) => ({
      playerId: entry.playerId,
      playerName: entry.playerName,
      initialBoxNumber: entry.initialBoxNumber,
      finalBoxNumber: entry.finalBoxNumber,
      wasSwapped: entry.initialBoxId !== entry.finalBoxId,
      isWinner: !!entry.isWinner,
      prizeAmount: entry.finalPrizeAmount
    }))
    .sort(sortRoundResults);

  return {
    sessionId: session.sessionId,
    snapshotRevision: session.snapshotRevision || 0,
    roundId: round.roundId,
    roundNumber: round.roundNumber,
    allPlayers: completedPlayers,
    winnerList: completedPlayers.filter((entry) => entry.isWinner),
    loserList: completedPlayers.filter((entry) => !entry.isWinner),
    grossStakeTotal: round.grossStakeTotal,
    feeAmount: round.feeAmount,
    rewardPool: round.rewardPool,
    winnerBase: round.winnerBase,
    winnerCount: round.winnerCount
  };
}

export function buildSessionSnapshot({ session, round, players, boxes, playerId }) {
  const player = players.find((entry) => entry.playerId === playerId) || null;
  const currentBox = player ? boxes.find((box) => box.boxId === player.currentBoxId) : null;
  const revealDone = [RoundStatus.ROUND_ENDED, RoundStatus.ROUND_CANCELLED].includes(round.status);

  return {
    sessionId: session.sessionId,
    snapshotRevision: session.snapshotRevision || 0,
    roundId: round.roundId,
    roundNumber: round.roundNumber,
    sessionStatus: session.status,
    sessionEndReason: session.endReason || null,
    roundStatus: round.status,
    roundEndReason: round.roundEndReason || null,
    expectedPlayerCount: round.expectedPlayerCountForRound,
    joinedPlayerCount: round.joinedPlayerIdsForRound?.length || 0,
    serverTime: Date.now(),
    joinDeadlineAt: round.joinDeadlineAt,
    distributionStartedAt: round.distributionStartedAt,
    distributionEndsAt: round.distributionEndsAt,
    swapStartedAt: round.swapStartedAt,
    swapActionClosesAt: round.swapActionClosesAt,
    swapEndsAt: round.swapEndsAt,
    swapClosedAt: round.swapClosedAt,
    revealAt: round.revealAt,
    preResultStartedAt: round.preResultStartedAt,
    preResultReadyDeadlineAt: round.preResultReadyDeadlineAt,
    finalResultsReleaseAt: round.finalResultsReleaseAt,
    roundResults: revealDone ? buildRoundResultsSnapshot({ session, round, players }) : null,
    you: player
        ? {
          playerId: player.playerId,
          playerName: player.playerName,
          hasJoinedRound: !!player.hasJoinedRound,
          initialBoxNumber: player.initialBoxNumber,
          currentBoxNumber: currentBox ? currentBox.boxNumber : null,
          swapState: player.swapState,
          hasRevealOccurred: revealDone,
          result:
            revealDone && player.finalPrizeAmount != null
              ? {
                  playerId: player.playerId,
                  playerName: player.playerName,
                  initialBoxNumber: player.initialBoxNumber,
                  finalBoxNumber: player.finalBoxNumber,
                  wasSwapped: player.initialBoxId !== player.finalBoxId,
                  isWinner: !!player.isWinner,
                  prizeAmount: player.finalPrizeAmount
                }
              : null
        }
      : null,
    summary: {
      stakeAmount: session.stakeAmount,
      grossStakeTotal: round.grossStakeTotal,
      feeAmount: round.feeAmount,
      rewardPool: round.rewardPool,
      winnerCount: round.winnerCount
    }
  };
}
