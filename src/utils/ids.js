import crypto from 'node:crypto';

export const createSessionId = () => crypto.randomUUID();
export const createRoundId = () => crypto.randomUUID();
export const createBoxId = () => crypto.randomUUID();
export const createPhaseToken = () => crypto.randomUUID();
export const createAuditSeed = () => crypto.randomBytes(16).toString('hex');
