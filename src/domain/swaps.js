import { ParticipationLabel, SwapState } from '../shared/protocol.js';

export function requestSwap({ players, boxes, swaps, playerId }) {
  const player = players.find((entry) => entry.playerId === playerId);
  if (!player) return { ok: false, error: 'PLAYER_NOT_FOUND' };
  if (player.swapState !== SwapState.NONE) {
    return { ok: false, error: 'SWAP_ALREADY_USED' };
  }

  player.swapRequested = true;
  player.swapState = SwapState.PENDING;
  swaps.queue.push({ playerId, requestedAt: Date.now() });

  if (swaps.queue.length < 2) {
    return { ok: true, pending: true };
  }

  const first = swaps.queue.shift();
  const second = swaps.queue.shift();
  const firstPlayer = players.find((entry) => entry.playerId === first.playerId);
  const secondPlayer = players.find((entry) => entry.playerId === second.playerId);
  if (!firstPlayer || !secondPlayer) {
    return { ok: false, error: 'SWAP_MATCH_FAILED' };
  }

  const firstBox = boxes.find((box) => box.currentOwnerPlayerId === firstPlayer.playerId);
  const secondBox = boxes.find((box) => box.currentOwnerPlayerId === secondPlayer.playerId);
  if (!firstBox || !secondBox) {
    return { ok: false, error: 'BOX_NOT_FOUND' };
  }

  [firstBox.currentOwnerPlayerId, secondBox.currentOwnerPlayerId] = [
    secondBox.currentOwnerPlayerId,
    firstBox.currentOwnerPlayerId
  ];

  firstPlayer.currentBoxId = secondBox.boxId;
  secondPlayer.currentBoxId = firstBox.boxId;
  firstPlayer.swapState = SwapState.MATCHED;
  secondPlayer.swapState = SwapState.MATCHED;
  firstPlayer.swapMatched = true;
  secondPlayer.swapMatched = true;
  if (firstPlayer.isConnected) firstPlayer.participationLabel = ParticipationLabel.JOINED_ACTIVE;
  if (secondPlayer.isConnected) secondPlayer.participationLabel = ParticipationLabel.JOINED_ACTIVE;

  const matched = {
    matchedAt: Date.now(),
    firstPlayerId: firstPlayer.playerId,
    secondPlayerId: secondPlayer.playerId,
    firstBoxId: firstBox.boxId,
    secondBoxId: secondBox.boxId
  };
  swaps.matched.push(matched);
  return { ok: true, pending: false, matched };
}

export function closeSwaps({ players, swaps }) {
  const unmatched = [];
  for (const queued of swaps.queue) {
    const player = players.find((entry) => entry.playerId === queued.playerId);
    if (!player) continue;
    player.swapState = SwapState.UNMATCHED;
    unmatched.push(player.playerId);
  }
  swaps.queue = [];
  return unmatched;
}
