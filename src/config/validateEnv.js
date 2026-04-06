import config from '../config.js';

export function validateEnv() {
  const requiredPositiveInts = [
    ['FIRST_JOIN_TIMEOUT_MS', config.firstJoinTimeoutMs],
    ['READY_CHECK_TIMEOUT_MS', config.readyCheckTimeoutMs],
    ['DISTRIBUTION_LEAD_MS', config.distributionLeadMs],
    ['SWAP_PHASE_MS', config.swapPhaseMs],
    ['CALC_DELAY_MS', config.calcDelayMs],
    ['REPLAY_WAIT_MS', config.replayWaitMs],
    ['REPLAY_BUFFER_MS', config.replayBufferMs],
    ['HEARTBEAT_INTERVAL_MS', config.heartbeatIntervalMs],
    ['HEARTBEAT_TIMEOUT_MS', config.heartbeatTimeoutMs],
    ['WEBHOOK_TIMEOUT_MS', config.webhookTimeoutMs],
    ['MAX_WEBHOOK_ATTEMPTS', config.maxWebhookAttempts],
    ['DLQ_RETENTION_MS', config.dlqRetentionMs],
    ['DLQ_SWEEP_INTERVAL_MS', config.dlqSweepIntervalMs]
  ];

  for (const [name, value] of requiredPositiveInts) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`Invalid ${name}. Expected a positive integer.`);
    }
  }

  if (!['redis', 'memory'].includes(config.storeMode)) {
    throw new Error('STORE_MODE must be either "redis" or "memory".');
  }

  if (config.storeMode !== 'memory' && !config.redisUrl) {
    throw new Error('REDIS_URL is required.');
  }

  if (!['percentage', 'fixed'].includes(config.platformFeeType)) {
    throw new Error('PLATFORM_FEE_TYPE must be either "percentage" or "fixed".');
  }

  if (!Number.isFinite(config.platformFeeValue) || config.platformFeeValue < 0) {
    throw new Error('PLATFORM_FEE_VALUE must be a non-negative number.');
  }

  if (
    !Number.isFinite(config.swapSoftLockPercent)
    || config.swapSoftLockPercent < 0
    || config.swapSoftLockPercent > 100
  ) {
    throw new Error('SWAP_SOFT_LOCK_PERCENT must be between 0 and 100.');
  }

  if (
    !Array.isArray(config.webhookRetryScheduleMs)
    || config.webhookRetryScheduleMs.some((value) => !Number.isFinite(value) || value < 0)
  ) {
    throw new Error('RETRY_SCHEDULE_MS must be a comma-separated list of non-negative integers.');
  }
}
