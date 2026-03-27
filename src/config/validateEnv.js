import config from '../config.js';

export function validateEnv() {
  const requiredPositiveInts = [
    ['FIRST_JOIN_TIMEOUT_MS', config.firstJoinTimeoutMs],
    ['READY_CHECK_TIMEOUT_MS', config.readyCheckTimeoutMs],
    ['DISTRIBUTION_BUFFER_MS', config.distributionBufferMs],
    ['SWAP_PHASE_MS', config.swapPhaseMs],
    ['PRE_RESULT_READY_TIMEOUT_MS', config.preResultReadyTimeoutMs],
    ['PRE_RESULT_HOLD_MS', config.preResultHoldMs],
    ['REPLAY_WAIT_MS', config.replayWaitMs],
    ['REPLAY_BUFFER_MS', config.replayBufferMs],
    ['HEARTBEAT_INTERVAL_MS', config.heartbeatIntervalMs],
    ['HEARTBEAT_TIMEOUT_MS', config.heartbeatTimeoutMs],
    ['WEBHOOK_TIMEOUT_MS', config.webhookTimeoutMs],
    ['MAX_WEBHOOK_ATTEMPTS', config.maxWebhookAttempts]
  ];

  for (const [name, value] of requiredPositiveInts) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`Invalid ${name}. Expected a positive integer.`);
    }
  }

  if (config.storeMode !== 'memory' && !config.redisUrl) {
    throw new Error('REDIS_URL is required.');
  }

  if (!['redis', 'memory'].includes(config.storeMode)) {
    throw new Error('STORE_MODE must be either "redis" or "memory".');
  }

  if (!['percentage', 'fixed'].includes(config.platformFeeType)) {
    throw new Error('PLATFORM_FEE_TYPE must be either "percentage" or "fixed".');
  }

  if (!Number.isFinite(config.platformFeeValue) || config.platformFeeValue < 0) {
    throw new Error('PLATFORM_FEE_VALUE must be a non-negative number.');
  }

  if (!Number.isFinite(config.swapSoftLockPercent) || config.swapSoftLockPercent < 0 || config.swapSoftLockPercent > 100) {
    throw new Error('SWAP_SOFT_LOCK_PERCENT must be between 0 and 100.');
  }

  if (!Array.isArray(config.webhookRetryScheduleMs) || config.webhookRetryScheduleMs.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error('RETRY_SCHEDULE_MS must be a comma-separated list of non-negative integers.');
  }
}
