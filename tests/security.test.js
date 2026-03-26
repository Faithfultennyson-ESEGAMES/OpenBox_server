import test from 'node:test';
import assert from 'node:assert/strict';
import config from '../src/config.js';
import { signJsonPayload } from '../src/security/hmac.js';

test('signJsonPayload returns null when HMAC secret is not configured', () => {
  const previous = config.hmacSecret;
  config.hmacSecret = '';
  assert.equal(signJsonPayload({ ok: true }), null);
  config.hmacSecret = previous;
});

test('signJsonPayload returns a stable sha256 hex signature when configured', () => {
  const previous = config.hmacSecret;
  config.hmacSecret = 'secret-test-value';
  const one = signJsonPayload({ ok: true, sessionId: 's1' });
  const two = signJsonPayload({ ok: true, sessionId: 's1' });
  assert.match(one, /^[a-f0-9]{64}$/);
  assert.equal(one, two);
  config.hmacSecret = previous;
});

