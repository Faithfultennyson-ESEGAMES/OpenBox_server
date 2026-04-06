import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildContainers,
  CONTAINER_SIZE,
  findContainerIndex,
  getDistributionDurationMs,
  getSwapActionCloseOffsetMs
} from '../src/shared/twod.js';

test('container builder uses 12-box groups and only renders the required container count', () => {
  assert.equal(buildContainers(2, CONTAINER_SIZE).length, 1);
  assert.deepEqual(buildContainers(2, CONTAINER_SIZE)[0], {
    id: 0,
    label: 'A',
    start: 1,
    end: 2,
    boxes: [1, 2],
    count: 2
  });
  assert.equal(buildContainers(12, CONTAINER_SIZE).length, 1);
  assert.equal(buildContainers(24, CONTAINER_SIZE).length, 2);
  assert.equal(buildContainers(50, CONTAINER_SIZE).length, 5);
  assert.deepEqual(buildContainers(24, CONTAINER_SIZE)[1], {
    id: 1,
    label: 'B',
    start: 13,
    end: 24,
    boxes: [13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24],
    count: 12
  });
});

test('findContainerIndex locates the player container for early, middle, and late boxes', () => {
  const containers = buildContainers(50, CONTAINER_SIZE);
  assert.equal(findContainerIndex(containers, 3), 0);
  assert.equal(findContainerIndex(containers, 24), 1);
  assert.equal(findContainerIndex(containers, 40), 3);
  assert.equal(findContainerIndex(containers, 50), 4);
});

test('distribution duration grows with the number of containers', () => {
  const duration12 = getDistributionDurationMs({ totalPlayers: 12, containerSize: CONTAINER_SIZE });
  const duration24 = getDistributionDurationMs({ totalPlayers: 24, containerSize: CONTAINER_SIZE });
  const duration50 = getDistributionDurationMs({ totalPlayers: 50, containerSize: CONTAINER_SIZE });

  assert.equal(duration24 > duration12, true);
  assert.equal(duration50 > duration24, true);
});

test('soft lock offset uses the final percent of the swap timer', () => {
  assert.equal(getSwapActionCloseOffsetMs({ swapPhaseMs: 30000, softLockPercent: 30 }), 21000);
  assert.equal(getSwapActionCloseOffsetMs({ swapPhaseMs: 10000, softLockPercent: 0 }), 10000);
  assert.equal(getSwapActionCloseOffsetMs({ swapPhaseMs: 10000, softLockPercent: 100 }), 0);
});
