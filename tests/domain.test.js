import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateFee } from '../src/domain/fees.js';
import {
  allocatePrizeValues,
  allocateRoundEconomy,
  buildBoxes,
  computeWinnerBase,
  computeWinnerCount
} from '../src/domain/prizes.js';
import { closeSwaps, requestSwap } from '../src/domain/swaps.js';

test('calculateFee handles percentage and fixed fees', () => {
  assert.equal(calculateFee({ grossStakeTotal: 1000, platformFeeType: 'percentage', platformFeeValue: 10 }), 100);
  assert.equal(calculateFee({ grossStakeTotal: 1000, platformFeeType: 'fixed', platformFeeValue: 55 }), 55);
});

test('winner base and count follow the odd/even rules', () => {
  assert.equal(computeWinnerBase(10), 10);
  assert.equal(computeWinnerCount(10), 5);
  assert.equal(computeWinnerBase(21), 20);
  assert.equal(computeWinnerCount(21), 10);
  assert.equal(computeWinnerBase(5), 4);
  assert.equal(computeWinnerCount(5), 2);
});

test('allocatePrizeValues preserves the full reward pool', () => {
  const prizes = allocatePrizeValues({ rewardPool: 900, winnerCount: 5 });
  assert.equal(prizes[0], 540);
  assert.equal(prizes.length, 5);
  assert.equal(prizes.reduce((sum, value) => sum + value, 0), 900);
});

test('allocateRoundEconomy uses all registered players', () => {
  const economy = allocateRoundEconomy({
    playerCount: 6,
    stakeAmount: 1000,
    platformFeeType: 'percentage',
    platformFeeValue: 10
  });
  assert.deepEqual(economy, {
    grossStakeTotal: 6000,
    feeAmount: 600,
    rewardPool: 5400,
    winnerBase: 6,
    winnerCount: 3
  });
});

test('buildBoxes creates one unique box per registered player', () => {
  const registeredPlayerIds = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'];
  const result = buildBoxes({
    registeredPlayerIds,
    stakeAmount: 1000,
    platformFeeType: 'percentage',
    platformFeeValue: 10
  });

  assert.equal(result.boxes.length, registeredPlayerIds.length);
  assert.equal(new Set(result.boxes.map((box) => box.boxId)).size, registeredPlayerIds.length);
  assert.equal(new Set(result.boxes.map((box) => box.boxNumber)).size, registeredPlayerIds.length);
  assert.equal(new Set(result.boxes.map((box) => box.initialOwnerPlayerId)).size, registeredPlayerIds.length);
  assert.equal(result.boxes.filter((box) => box.isWinningBox).length, result.winnerCount);
  assert.equal(result.boxes.reduce((sum, box) => sum + box.rewardAmount, 0), result.rewardPool);
});

test('requestSwap pairs FIFO and closeSwaps keeps unmatched players', () => {
  const players = [
    { playerId: 'p1', swapState: 'NONE', swapRequested: false, swapMatched: false, isConnected: true, currentBoxId: 'b1' },
    { playerId: 'p2', swapState: 'NONE', swapRequested: false, swapMatched: false, isConnected: true, currentBoxId: 'b2' },
    { playerId: 'p3', swapState: 'NONE', swapRequested: false, swapMatched: false, isConnected: true, currentBoxId: 'b3' }
  ];
  const boxes = [
    { boxId: 'b1', currentOwnerPlayerId: 'p1' },
    { boxId: 'b2', currentOwnerPlayerId: 'p2' },
    { boxId: 'b3', currentOwnerPlayerId: 'p3' }
  ];
  const swaps = { queue: [], matched: [], keepers: [] };

  const pending = requestSwap({ players, boxes, swaps, playerId: 'p1' });
  assert.equal(pending.pending, true);
  assert.equal(swaps.queue.length, 1);

  const matched = requestSwap({ players, boxes, swaps, playerId: 'p2' });
  assert.equal(matched.pending, false);
  assert.equal(swaps.matched.length, 1);
  assert.equal(players[0].swapState, 'MATCHED');
  assert.equal(players[1].swapState, 'MATCHED');

  requestSwap({ players, boxes, swaps, playerId: 'p3' });
  const unmatched = closeSwaps({ players, swaps });
  assert.deepEqual(unmatched, ['p3']);
  assert.equal(players[2].swapState, 'UNMATCHED');
});
