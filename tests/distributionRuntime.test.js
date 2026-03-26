import test from 'node:test';
import assert from 'node:assert/strict';
import { getVisibleContainerIndexes } from '../../client/public/src/distributionRuntime.js';

test('visible container hydration keeps nearby containers filled and distant containers empty', () => {
  assert.deepEqual(getVisibleContainerIndexes(5, 0, 1), [0, 1]);
  assert.deepEqual(getVisibleContainerIndexes(5, 2, 1), [1, 2, 3]);
  assert.deepEqual(getVisibleContainerIndexes(5, 4, 1), [3, 4]);
});
