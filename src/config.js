import path from 'node:path';
import { fileURLToPath } from 'node:url';

try {
  await import('dotenv/config');
} catch {
  // Tests and minimal runtime checks can run without dotenv installed.
}

const toInt = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const toFloat = (value, fallback) => {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const normalizeOrigin = (value) => {
  if (!value) return '';
  try {
    return new URL(value).origin;
  } catch {
    return value;
  }
};

const parseOrigins = (value) =>
  String(value || '')
    .split(',')
    .map((entry) => normalizeOrigin(entry.trim()))
    .filter(Boolean);

const parseWebhookEndpoints = (value) =>
  String(value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

const parseCsvInts = (value, fallback = []) => {
  const entries = String(value || '')
    .split(',')
    .map((entry) => Number.parseInt(entry.trim(), 10))
    .filter((entry) => Number.isFinite(entry));
  return entries.length ? entries : fallback;
};

const toBool = (value, fallback = false) => {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const config = {
  port: toInt(process.env.PORT, 3100),
  storeMode: (process.env.STORE_MODE || 'redis').toLowerCase(),
  clientOrigin: parseOrigins(process.env.CLIENT_ORIGIN || '')[0] || '',
  clientOrigins: parseOrigins(process.env.CLIENT_ORIGIN || ''),
  controlApiToken: process.env.CONTROL_API_TOKEN || '',
  redisUrl: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
  redisKeyTtlSec: toInt(process.env.REDIS_KEY_TTL_SEC, 86400),
  devWaitForAllPlayers: toBool(process.env.DEV_WAIT_FOR_ALL_PLAYERS, false),
  firstJoinTimeoutMs: toInt(process.env.FIRST_JOIN_TIMEOUT_MS, 30000),
  readyCheckTimeoutMs: toInt(process.env.READY_CHECK_TIMEOUT_MS, 10000),
  distributionBufferMs: toInt(process.env.DISTRIBUTION_BUFFER_MS, 1500),
  swapPhaseMs: toInt(process.env.SWAP_PHASE_MS, 30000),
  swapSoftLockPercent: toInt(process.env.SWAP_SOFT_LOCK_PERCENT, 30),
  preResultReadyTimeoutMs: toInt(process.env.PRE_RESULT_READY_TIMEOUT_MS, 2500),
  preResultHoldMs: toInt(process.env.PRE_RESULT_HOLD_MS, 500),
  replayWaitMs: toInt(process.env.REPLAY_WAIT_MS, 30000),
  replayBufferMs: toInt(process.env.REPLAY_BUFFER_MS, 5000),
  heartbeatIntervalMs: toInt(process.env.HEARTBEAT_INTERVAL_MS, 3000),
  heartbeatTimeoutMs: toInt(process.env.HEARTBEAT_TIMEOUT_MS, 9000),
  hmacSecret: process.env.HMAC_SECRET || '',
  matchmakingServiceUrl: process.env.MATCHMAKING_SERVICE_URL || '',
  webhookEndpoints: parseWebhookEndpoints(process.env.WEBHOOK_ENDPOINTS),
  webhookTimeoutMs: toInt(process.env.WEBHOOK_TIMEOUT_MS, 5000),
  maxWebhookAttempts: toInt(process.env.MAX_WEBHOOK_ATTEMPTS, 3),
  webhookRetryScheduleMs: parseCsvInts(process.env.RETRY_SCHEDULE_MS, [1000, 3000]),
  dlqDir: process.env.DLQ_DIR || path.resolve(__dirname, '../dlq'),
  platformFeeType: (process.env.PLATFORM_FEE_TYPE || 'percentage').toLowerCase(),
  platformFeeValue: toFloat(process.env.PLATFORM_FEE_VALUE, 10)
};

export default config;
