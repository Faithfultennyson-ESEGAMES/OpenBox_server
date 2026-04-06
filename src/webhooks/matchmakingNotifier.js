import config from '../config.js';
import { dispatchWebhookEndpoint } from './dispatcher.js';

export async function notifyMatchmakingSessionClosed(payload, fetchImpl = fetch) {
  if (!config.matchmakingServiceUrl || !config.hmacSecret) {
    return { ok: false, skipped: true, reason: 'not_configured' };
  }
  const result = await dispatchWebhookEndpoint({
    endpoint: config.matchmakingServiceUrl,
    payload,
    eventType: payload?.eventName || 'session.ended',
    fetchImpl
  });

  if (!result.ok && !result.skipped) {
    console.error(
      `[MatchmakingNotifier] Matchmaking callback failed for ${payload?.sessionId || 'unknown'}:`,
      result.error || result.reason || result.status || 'unknown_error'
    );
  }

  return result;
}

export default notifyMatchmakingSessionClosed;
