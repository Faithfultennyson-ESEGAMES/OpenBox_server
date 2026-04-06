import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import config from '../src/config.js';
import {
  clearDlq,
  dispatchWebhookEndpoint,
  listDlqItems,
  purgeExpiredDlqItems,
  readDlqItem,
  resendDlqItem,
  sendWebhookWithRetry
} from '../src/webhooks/dispatcher.js';
import { notifyMatchmakingSessionClosed } from '../src/webhooks/matchmakingNotifier.js';

async function withTempDlqDir(t) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'open-box-dlq-'));
  const previousDir = config.dlqDir;
  const previousRetention = config.dlqRetentionMs;
  config.dlqDir = tempDir;
  config.dlqRetentionMs = 7 * 24 * 60 * 60 * 1000;
  t.after(async () => {
    config.dlqDir = previousDir;
    config.dlqRetentionMs = previousRetention;
    await fs.rm(tempDir, { recursive: true, force: true });
  });
  return tempDir;
}

function createPayload(overrides = {}) {
  return {
    eventId: 'event-1',
    eventName: 'round.ended',
    eventVersion: 1,
    occurredAt: Date.now(),
    sessionId: 'session-1',
    roundId: 'round-1',
    roundNumber: 1,
    ...overrides
  };
}

test('webhook delivery retries transient failures and succeeds on a later attempt', async (t) => {
  await withTempDlqDir(t);
  let attempts = 0;

  const result = await sendWebhookWithRetry({
    endpoint: 'http://example.test/webhook',
    payload: createPayload(),
    eventType: 'round.ended',
    retryScheduleMs: [0],
    maxAttempts: 2,
    fetchImpl: async () => {
      attempts += 1;
      return {
        ok: attempts >= 2,
        status: attempts >= 2 ? 200 : 503
      };
    }
  });

  assert.equal(result.ok, true);
  assert.equal(attempts, 2);
  assert.deepEqual(await listDlqItems(), []);
});

test('webhook delivery moves permanent 4xx failures to the DLQ', async (t) => {
  await withTempDlqDir(t);
  let attempts = 0;

  const result = await sendWebhookWithRetry({
    endpoint: 'http://example.test/webhook',
    payload: createPayload({ eventId: 'event-401', eventName: 'session.ended' }),
    eventType: 'session.ended',
    retryScheduleMs: [0, 0],
    maxAttempts: 3,
    fetchImpl: async () => {
      attempts += 1;
      return {
        ok: false,
        status: 401
      };
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.permanent, true);
  assert.equal(attempts, 1);

  const items = await listDlqItems();
  assert.equal(items.length, 1);
  assert.equal(items[0].eventName, 'session.ended');
  const stored = await readDlqItem(items[0].dlqItemId);
  assert.equal(stored.eventId, 'event-401');
  assert.equal(stored.lastResponseStatus, 401);
});

test('webhook delivery moves exhausted retries to the DLQ and supports resend and clear', async (t) => {
  await withTempDlqDir(t);

  const result = await sendWebhookWithRetry({
    endpoint: 'http://example.test/webhook',
    payload: createPayload({ eventId: 'event-retry', eventName: 'player.disconnected' }),
    eventType: 'player.disconnected',
    retryScheduleMs: [0],
    maxAttempts: 2,
    fetchImpl: async () => {
      throw new Error('network failed');
    }
  });

  assert.equal(result.ok, false);
  const items = await listDlqItems();
  assert.equal(items.length, 1);

  const resend = await resendDlqItem(items[0].dlqItemId, async () => ({
    ok: true,
    status: 200
  }));
  assert.equal(resend.result.ok, true);
  assert.deepEqual(await listDlqItems(), []);

  await sendWebhookWithRetry({
    endpoint: 'http://example.test/webhook',
    payload: createPayload({ eventId: 'event-clear', eventName: 'player.joined' }),
    eventType: 'player.joined',
    retryScheduleMs: [0],
    maxAttempts: 1,
    fetchImpl: async () => ({ ok: false, status: 422 })
  });

  assert.equal((await listDlqItems()).length, 1);
  assert.equal(await clearDlq(), 1);
  assert.deepEqual(await listDlqItems(), []);
});

test('DLQ retention purges expired items before reads', async (t) => {
  const tempDir = await withTempDlqDir(t);
  config.dlqRetentionMs = 1000;

  await fs.writeFile(
    path.join(tempDir, 'expired.json'),
    JSON.stringify({
      dlqItemId: 'expired',
      failedAt: new Date(Date.now() - 10_000).toISOString(),
      endpoint: 'http://example.test/webhook',
      eventId: 'expired-event',
      eventName: 'session.ended',
      reason: 'expired',
      lastResponseStatus: 500,
      deliveryAttempts: [],
      webhookPayload: createPayload({ eventId: 'expired-event', eventName: 'session.ended' })
    })
  );

  assert.equal(await purgeExpiredDlqItems(), 1);
  assert.deepEqual(await listDlqItems(), []);
});

test('dispatchWebhookEndpoint skips cleanly when endpoint is not configured', async (t) => {
  await withTempDlqDir(t);

  const result = await dispatchWebhookEndpoint({
    endpoint: '',
    payload: createPayload({ eventId: 'skip-event' }),
    eventType: 'round.ended'
  });

  assert.equal(result.ok, false);
  assert.equal(result.skipped, true);
  assert.deepEqual(await listDlqItems(), []);
});

test('notifyMatchmakingSessionClosed uses webhook retry headers and DLQ handling', async (t) => {
  await withTempDlqDir(t);
  const previousMatchmakingUrl = config.matchmakingServiceUrl;
  const previousSecret = config.hmacSecret;
  const previousRetrySchedule = config.webhookRetryScheduleMs;
  const previousMaxAttempts = config.maxWebhookAttempts;
  config.matchmakingServiceUrl = 'http://matchmaking.test/session-closed';
  config.hmacSecret = 'shared-secret';
  config.webhookRetryScheduleMs = [0];
  config.maxWebhookAttempts = 2;

  let attempts = 0;
  let seenHeaders = null;

  t.after(() => {
    config.matchmakingServiceUrl = previousMatchmakingUrl;
    config.hmacSecret = previousSecret;
    config.webhookRetryScheduleMs = previousRetrySchedule;
    config.maxWebhookAttempts = previousMaxAttempts;
  });

  const result = await notifyMatchmakingSessionClosed(
    createPayload({ eventId: 'matchmaking-event', eventName: 'session.ended' }),
    async (_url, options = {}) => {
      attempts += 1;
      seenHeaders = options.headers;
      return { ok: false, status: 503 };
    }
  );

  assert.equal(result.ok, false);
  assert.equal(attempts, 2);
  assert.equal(seenHeaders['x-event-type'], 'session.ended');
  assert.match(seenHeaders['x-hub-signature-256'] || '', /^[a-f0-9]{64}$/);

  const items = await listDlqItems();
  assert.equal(items.length, 1);
  assert.equal(items[0].endpoint, 'http://matchmaking.test/session-closed');
});
