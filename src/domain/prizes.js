import { calculateFee } from './fees.js';
import { createAuditSeed, createBoxId } from '../utils/ids.js';
import { makeSeededRng, shuffleWithSeed } from '../utils/random.js';

export function computeWinnerBase(playerCount) {
  return playerCount % 2 === 0 ? playerCount : playerCount - 1;
}

export function computeWinnerCount(playerCount) {
  return Math.floor(computeWinnerBase(playerCount) / 2);
}

export function allocateRoundEconomy({ playerCount, stakeAmount, platformFeeType, platformFeeValue }) {
  const grossStakeTotal = playerCount * stakeAmount;
  const feeAmount = calculateFee({ grossStakeTotal, platformFeeType, platformFeeValue });
  const rewardPool = Math.max(0, grossStakeTotal - feeAmount);
  const winnerBase = computeWinnerBase(playerCount);
  const winnerCount = computeWinnerCount(playerCount);
  return { grossStakeTotal, feeAmount, rewardPool, winnerBase, winnerCount };
}

export function allocatePrizeValues({ rewardPool, winnerCount }) {
  if (winnerCount <= 0) return [];
  if (winnerCount === 1) return [rewardPool];

  const majorPrize = Number((rewardPool * 0.6).toFixed(2));
  const remainder = Number((rewardPool - majorPrize).toFixed(2));
  const secondaryValue = Number((remainder / (winnerCount - 1)).toFixed(2));
  const prizes = [majorPrize];

  for (let index = 1; index < winnerCount; index += 1) {
    prizes.push(secondaryValue);
  }

  const allocated = prizes.reduce((sum, value) => sum + value, 0);
  const delta = Number((rewardPool - allocated).toFixed(2));
  prizes[prizes.length - 1] = Number((prizes[prizes.length - 1] + delta).toFixed(2));
  return prizes;
}

export function buildBoxes({ registeredPlayerIds, stakeAmount, platformFeeType, platformFeeValue }) {
  const playerCount = registeredPlayerIds.length;
  const auditSeed = createAuditSeed();
  const economy = allocateRoundEconomy({
    playerCount,
    stakeAmount,
    platformFeeType,
    platformFeeValue
  });

  const prizeValues = allocatePrizeValues({
    rewardPool: economy.rewardPool,
    winnerCount: economy.winnerCount
  });

  const rewards = [
    ...prizeValues.map((rewardAmount) => ({
      rewardAmount,
      isWinningBox: rewardAmount > 0
    })),
    ...Array.from({ length: playerCount - prizeValues.length }, () => ({
      rewardAmount: 0,
      isWinningBox: false
    }))
  ];

  const rng = makeSeededRng(auditSeed);
  const shuffledRewards = shuffleWithSeed(rewards, rng);
  const shuffledOwners = shuffleWithSeed(registeredPlayerIds, rng);

  const boxes = shuffledRewards.map((reward, index) => ({
    boxId: createBoxId(),
    boxNumber: index + 1,
    rewardAmount: Number(reward.rewardAmount.toFixed(2)),
    isWinningBox: reward.isWinningBox,
    initialOwnerPlayerId: shuffledOwners[index],
    currentOwnerPlayerId: shuffledOwners[index]
  }));

  return {
    auditSeed,
    boxes,
    ...economy
  };
}
