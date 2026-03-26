import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyLocalKeep,
  applyLocalSwap,
  applyServerEvent,
  applyServerSnapshot,
  createDefaultSwapFlow,
  startSwapChoice
} from '../../client/public/src/swapFlow.js';

function createSnapshot(overrides = {}) {
  const base = {
    roundId: 'round-1',
    roundStatus: 'SWAP_OPEN',
    swapStartedAt: 10_000,
    swapActionClosesAt: 19_100,
    swapEndsAt: 23_000,
    swapClosedAt: null,
    revealAt: 24_000,
    you: {
      currentBoxNumber: 30,
      initialBoxNumber: 30,
      swapState: 'NONE'
    }
  };

  return {
    ...base,
    ...overrides,
    you: {
      ...base.you,
      ...(overrides.you || {})
    }
  };
}

test('swap flow keeps local keep locked immediately and through open-phase snapshots', () => {
  const snapshot = createSnapshot();
  const choice = startSwapChoice(snapshot, createDefaultSwapFlow());
  const locked = applyLocalKeep(choice, snapshot, 12_000);
  const reconciled = applyServerSnapshot(locked, snapshot, 12_100);

  assert.equal(choice.phase, 'choice');
  assert.equal(locked.phase, 'locked');
  assert.equal(locked.selectedBox, 30);
  assert.equal(locked.pendingAction, 'keep');
  assert.ok(locked.fxUntilMs > 12_000);
  assert.equal(reconciled.phase, 'locked');
  assert.equal(reconciled.selectedBox, 30);
  assert.equal(reconciled.pendingAction, 'keep');
});

test('swap flow resolves a pending local swap to no_match when the window closes without a match', () => {
  const openSnapshot = createSnapshot();
  const waiting = applyLocalSwap(startSwapChoice(openSnapshot), openSnapshot, 12_000);
  const closedSnapshot = createSnapshot({
    roundStatus: 'SWAP_CLOSED',
    swapClosedAt: 23_000
  });
  const resolved = applyServerSnapshot(waiting, closedSnapshot, 23_100);

  assert.equal(waiting.phase, 'waiting');
  assert.equal(resolved.phase, 'no_match');
  assert.equal(resolved.selectedBox, 30);
  assert.equal(resolved.pendingAction, null);
  assert.ok(resolved.fxUntilMs > 23_100);
});

test('swap flow preserves the original box and matched box during found transition', () => {
  const openSnapshot = createSnapshot();
  const waiting = applyLocalSwap(startSwapChoice(openSnapshot), openSnapshot, 12_000);
  const matchedSnapshot = createSnapshot({
    you: {
      currentBoxNumber: 44,
      initialBoxNumber: 30,
      swapState: 'MATCHED'
    }
  });
  const found = applyServerEvent(waiting, matchedSnapshot, 'SWAP_MATCHED', 15_000, {
    newBoxNumber: 44
  });

  assert.equal(found.phase, 'found');
  assert.equal(found.selectedBox, 30);
  assert.equal(found.matchedBox, 44);
  assert.equal(found.pendingAction, null);
  assert.ok(found.fxUntilMs > 15_000);
});

test('swap flow clears stale local state when a new round opens', () => {
  const roundOne = createSnapshot();
  const waiting = applyLocalSwap(startSwapChoice(roundOne), roundOne, 12_000);
  const roundTwo = createSnapshot({
    roundId: 'round-2',
    you: {
      currentBoxNumber: 12,
      initialBoxNumber: 12,
      swapState: 'NONE'
    }
  });
  const nextChoice = applyServerSnapshot(waiting, roundTwo, 30_000);

  assert.equal(nextChoice.roundId, 'round-2');
  assert.equal(nextChoice.phase, 'choice');
  assert.equal(nextChoice.selectedBox, 12);
  assert.equal(nextChoice.pendingAction, null);
  assert.equal(nextChoice.queued, false);
});
