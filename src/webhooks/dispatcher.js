import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { WebhookEventType } from '../shared/protocol.js';
import config from '../config.js';
import { signJsonPayload } from '../security/hmac.js';

export const DLQ_DIR = () => config.dlqDir;

function wait(ms) {
  if (!ms || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureDlqDir() {
  await fs.mkdir(DLQ_DIR(), { recursive: true });
}

function buildHeaders(eventType, payload) {
  const body = JSON.stringify(payload);
  const signature = signJsonPayload(body);
  const headers = {
    'content-type': 'application/json',
    'x-event-type': eventType,
    'x-event-id': payload.eventId
  };

  if (signature) {
    headers['x-hub-signature-256'] = signature;
  }

  return { body, headers };
}

async function writeDlqItem(dlqItem) {
  await ensureDlqDir();
  const filePath = path.join(DLQ_DIR(), `${dlqItem.dlqItemId}.json`);
  await fs.writeFile(filePath, JSON.stringify(dlqItem, null, 2));
}

async function moveToDlq({ endpoint, payload, eventType, reason, lastResponseStatus, deliveryAttempts }) {
  const dlqItem = {
    dlqItemId: crypto.randomUUID(),
    failedAt: new Date().toISOString(),
    endpoint,
    eventId: payload.eventId,
    eventName: payload.eventName || eventType,
    reason,
    lastResponseStatus,
    deliveryAttempts,
    webhookPayload: payload
  };

  await writeDlqItem(dlqItem);
  return dlqItem;
}

export async function sendWebhookWithRetry({
  endpoint,
  payload,
  eventType,
  fetchImpl = fetch,
  timeoutMs = config.webhookTimeoutMs,
  retryScheduleMs = config.webhookRetryScheduleMs,
  maxAttempts = config.maxWebhookAttempts,
  persistFailures = true
}) {
  const attempts = Math.max(1, maxAttempts || retryScheduleMs.length + 1);
  const deliveryAttempts = [];
  const { body, headers } = buildHeaders(eventType, payload);

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let response = null;
    let error = null;

    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (caughtError) {
      error = caughtError;
    }

    const status = response?.status ?? null;
    deliveryAttempts.push({
      attemptId: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      statusCode: status,
      error: error?.message || null
    });

    if (response?.ok) {
      return {
        ok: true,
        status,
        attempts: attempt + 1,
        deliveryAttempts
      };
    }

    if (status >= 400 && status < 500) {
      return {
        ok: false,
        status,
        attempts: attempt + 1,
        permanent: true,
        deliveryAttempts,
        ...(persistFailures
          ? {
              dlqItem: await moveToDlq({
                endpoint,
                payload,
                eventType,
                reason: `Permanent failure with status ${status}`,
                lastResponseStatus: status,
                deliveryAttempts
              })
            }
          : {})
      };
    }

    if (attempt < attempts - 1) {
      await wait(retryScheduleMs[attempt] || 0);
    } else {
      return {
        ok: false,
        status,
        attempts,
        deliveryAttempts,
        error: error?.message || null,
        ...(persistFailures
          ? {
              dlqItem: await moveToDlq({
                endpoint,
                payload,
                eventType,
                reason: `Exhausted ${attempts} retry attempts.`,
                lastResponseStatus: status,
                deliveryAttempts
              })
            }
          : {})
      };
    }
  }

  return {
    ok: false,
    status: null,
    attempts: 0,
    deliveryAttempts
  };
}

export async function dispatchWebhook(eventType, payload) {
  if (!Object.values(WebhookEventType).includes(eventType)) {
    console.warn(`[Webhook] Unknown event type ${eventType}`);
  }

  if (!config.webhookEndpoints.length) {
    console.log('[Webhook]', eventType, JSON.stringify(payload));
    return [];
  }

  await ensureDlqDir();

  return Promise.all(
    config.webhookEndpoints.map((endpoint) =>
      sendWebhookWithRetry({
        endpoint,
        payload,
        eventType
      })
    )
  );
}

export async function listDlqItems() {
  try {
    await ensureDlqDir();
    const files = await fs.readdir(DLQ_DIR());
    const items = [];

    for (const file of files.filter((entry) => entry.endsWith('.json'))) {
      const raw = await fs.readFile(path.join(DLQ_DIR(), file), 'utf8');
      const payload = JSON.parse(raw);
      items.push({
        dlqItemId: payload.dlqItemId,
        failedAt: payload.failedAt,
        endpoint: payload.endpoint,
        eventId: payload.eventId,
        eventName: payload.eventName,
        reason: payload.reason,
        lastResponseStatus: payload.lastResponseStatus,
        attemptCount: Array.isArray(payload.deliveryAttempts) ? payload.deliveryAttempts.length : 0
      });
    }

    return items.sort((left, right) => String(right.failedAt).localeCompare(String(left.failedAt)));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

export async function readDlqItem(id) {
  const filePath = path.join(DLQ_DIR(), `${id}.json`);
  const raw = await fs.readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

export async function resendDlqItem(id, fetchImpl = fetch) {
  const item = await readDlqItem(id);
  const result = await sendWebhookWithRetry({
    endpoint: item.endpoint,
    payload: item.webhookPayload,
    eventType: item.eventName,
    fetchImpl,
    persistFailures: false
  });

  if (result.ok) {
    await fs.unlink(path.join(DLQ_DIR(), `${id}.json`));
  }

  return { item, result };
}

export async function clearDlq() {
  try {
    await ensureDlqDir();
    const files = await fs.readdir(DLQ_DIR());
    const jsonFiles = files.filter((file) => file.endsWith('.json'));
    await Promise.all(jsonFiles.map((file) => fs.unlink(path.join(DLQ_DIR(), file))));
    return jsonFiles.length;
  } catch (error) {
    if (error?.code === 'ENOENT') return 0;
    throw error;
  }
}

export async function initWebhookDispatcher() {
  await ensureDlqDir();
}
