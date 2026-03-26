import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getSwapTimerSourceKey,
  getSwapTimerView,
  seedSwapTimerFromSnapshot,
  seedSwapTimerFromWindowOpen
} from '../../client/public/src/swapTimer.js';

function createSnapshot(overrides = {}) {
  const base = {
    roundId: 'round-1',
    roundStatus: 'SWAP_OPEN',
    swapStartedAt: 2_000,
    swapActionClosesAt: 11_100,
    swapEndsAt: 15_000,
    serverTime: 2_000,
    clientReceivedAt: 2_000
  };

  return {
    ...base,
    ...overrides
  };
}

test('swap timer seeds a positive local deadline from swap open', () => {
  const seeded = seedSwapTimerFromSnapshot(createSnapshot(), 2_000);

  assert.equal(seeded.totalMs, 13_000);
  assert.equal(seeded.deadlineAtClientMs, 15_000);
});

test('swap timer view counts down from the local seeded deadline', () => {
  const snapshot = createSnapshot();
  const seeded = seedSwapTimerFromSnapshot(snapshot, 2_000);

  const atStart = getSwapTimerView(seeded, snapshot, 2_001);
  const oneSecondLater = getSwapTimerView(seeded, snapshot, 3_001);
  const lateSwap = getSwapTimerView(seeded, snapshot, 11_001);

  assert.equal(atStart.remainingSeconds, 13);
  assert.equal(oneSecondLater.remainingSeconds, 12);
  assert.equal(lateSwap.remainingSeconds, 4);
});

test('swap window open event seeds a full local countdown without relying on snapshot clock fields', () => {
  const seeded = seedSwapTimerFromWindowOpen({
    roundId: 'round-1',
    swapStartedAt: 2_000,
    swapActionClosesAt: 11_100,
    swapEndsAt: 15_000
  }, 50_000);

  const atStart = getSwapTimerView(seeded, null, 50_001);
  const oneSecondLater = getSwapTimerView(seeded, null, 51_001);

  assert.equal(seeded.totalMs, 13_000);
  assert.equal(atStart.remainingSeconds, 13);
  assert.equal(oneSecondLater.remainingSeconds, 12);
});

test('swap timer source key ignores snapshot-only fields so primed timers survive render restarts', () => {
  const seeded = seedSwapTimerFromWindowOpen({
    roundId: 'round-1',
    swapStartedAt: 2_000,
    swapActionClosesAt: 11_100,
    swapEndsAt: 15_000
  }, 50_000);

  const snapshotTimerSource = {
    swapStartedAt: 2_000,
    swapActionClosesAt: 11_100,
    swapEndsAt: 15_000,
    revealAt: 16_000
  };

  assert.equal(getSwapTimerSourceKey(seeded), getSwapTimerSourceKey(snapshotTimerSource));
});

test('swap timer soft lock still follows the server cutoff timestamp', () => {
  const snapshot = createSnapshot();
  const seeded = seedSwapTimerFromSnapshot(snapshot, 2_000);

  assert.equal(getSwapTimerView(seeded, snapshot, 11_099).softLocked, false);
  assert.equal(getSwapTimerView(seeded, snapshot, 11_100).softLocked, true);
});

test('swap timer falls back to inactive when swap timestamps are missing', () => {
  const seeded = seedSwapTimerFromSnapshot({}, 5_000);
  const view = getSwapTimerView(seeded, {}, 5_000);

  assert.equal(view.active, false);
  assert.equal(view.remainingSeconds, 0);
});

test('swap timer view falls back to authoritative timestamps when the local deadline seed is missing', () => {
  const view = getSwapTimerView({
    totalMs: 0,
    deadlineAtClientMs: null,
    swapStartedAt: 2_000,
    swapActionClosesAt: 11_100,
    swapEndsAt: 15_000
  }, createSnapshot(), 3_001);

  assert.equal(view.active, true);
  assert.equal(view.remainingSeconds, 12);
});

test('swap timer view can render directly from snapshot timerSource fields', () => {
  const view = getSwapTimerView({
    swapStartedAt: 2_000,
    swapActionClosesAt: 11_100,
    swapEndsAt: 15_000
  }, createSnapshot(), 11_001);

  assert.equal(view.active, true);
  assert.equal(view.remainingSeconds, 4);
});
