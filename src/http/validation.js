export function validateStartPayload(body) {
  const playerCount = Number.parseInt(body?.playerCount, 10);
  const stakeAmount = Number.parseFloat(body?.stakeAmount);
  const playerIds = Array.isArray(body?.playerIds) ? body.playerIds.map(String) : [];

  if (!Number.isFinite(playerCount) || playerCount < 5 || playerCount > 50) {
    return { ok: false, error: 'playerCount must be between 5 and 50' };
  }
  if (playerIds.length !== playerCount) {
    return { ok: false, error: 'playerIds length must match playerCount' };
  }
  if (new Set(playerIds).size !== playerIds.length) {
    return { ok: false, error: 'playerIds must be unique' };
  }
  if (!Number.isFinite(stakeAmount) || stakeAmount <= 0) {
    return { ok: false, error: 'stakeAmount must be a positive number' };
  }

  return { ok: true, playerCount, stakeAmount, playerIds };
}
