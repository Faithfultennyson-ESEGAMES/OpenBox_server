import crypto from 'node:crypto';
import config from '../config.js';

export function signJsonPayload(payload) {
  if (!config.hmacSecret) return null;
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return crypto.createHmac('sha256', config.hmacSecret).update(body).digest('hex');
}
