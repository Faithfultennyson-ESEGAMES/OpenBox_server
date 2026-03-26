import config from '../config.js';
import { signJsonPayload } from '../security/hmac.js';

export async function notifyMatchmakingSessionClosed(payload, fetchImpl = fetch) {
  if (!config.matchmakingServiceUrl || !config.hmacSecret) {
    return { ok: false, skipped: true, reason: 'not_configured' };
  }

  const body = JSON.stringify(payload);
  const signature = signJsonPayload(body);
  const headers = {
    'content-type': 'application/json',
    'x-event-type': payload.eventName || 'session.ended'
  };

  if (payload?.eventId) {
    headers['x-event-id'] = payload.eventId;
  }
  if (signature) {
    headers['x-hub-signature-256'] = signature;
  }

  try {
    const response = await fetchImpl(config.matchmakingServiceUrl, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(config.webhookTimeoutMs)
    });

    if (!response.ok) {
      console.error(
        `[MatchmakingNotifier] Matchmaking callback failed for ${payload?.sessionId || 'unknown'} with status ${response.status}`
      );
    }

    return {
      ok: response.ok,
      status: response.status
    };
  } catch (error) {
    console.error(
      `[MatchmakingNotifier] Failed to send session closure for ${payload?.sessionId || 'unknown'}:`,
      error?.message || error
    );
    return {
      ok: false,
      error: error?.message || 'unknown_error'
    };
  }
}

export default notifyMatchmakingSessionClosed;
