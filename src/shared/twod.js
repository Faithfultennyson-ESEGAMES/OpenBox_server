export const CONTAINER_SIZE = 12;

export const TWO_D_DISTRIBUTION_TIMINGS = Object.freeze({
  introMs: 400,
  scanPauseMs: 480,
  playerPauseMs: 900,
  selectDelayMs: 600,
  boxPopStepMs: 55,
  boxPopLeadMs: 100,
  boxPopTailMs: 250,
  foundBeatMs: 700,
  preFlyMs: 120,
  flyMs: 540,
  stageBeatMs: 1000,
  fadeBeatMs: 300,
  fadeOutMs: 350
});

export function clampPlayerCount(playerCount) {
  return Math.max(5, Math.min(50, Number(playerCount || 0)));
}

export function buildContainers(totalPlayers, containerSize = CONTAINER_SIZE) {
  const safePlayers = clampPlayerCount(totalPlayers);
  const safeSize = Math.max(1, Number(containerSize || CONTAINER_SIZE));
  const labels = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const containers = [];

  for (let start = 1; start <= safePlayers; start += safeSize) {
    const end = Math.min(start + safeSize - 1, safePlayers);
    const boxes = Array.from({ length: end - start + 1 }, (_, index) => start + index);
    containers.push({
      id: containers.length,
      label: labels[containers.length] || String(containers.length + 1),
      start,
      end,
      boxes,
      count: boxes.length
    });
  }

  return containers;
}

export function findContainerIndex(containers, boxNumber) {
  const safeBox = Number(boxNumber || 0);
  return containers.findIndex((container) => safeBox >= container.start && safeBox <= container.end);
}

export function getDistributionDurationMs({ totalPlayers, containerSize = CONTAINER_SIZE }) {
  const containers = buildContainers(totalPlayers, containerSize);
  const lastContainer = containers.at(-1) || { count: containerSize };
  const timings = TWO_D_DISTRIBUTION_TIMINGS;

  return (
    timings.introMs +
    Math.max(0, containers.length - 1) * timings.scanPauseMs +
    timings.playerPauseMs +
    timings.selectDelayMs +
    (lastContainer.count * timings.boxPopStepMs + timings.boxPopLeadMs + timings.boxPopTailMs) +
    timings.foundBeatMs +
    timings.preFlyMs +
    timings.flyMs +
    timings.stageBeatMs +
    timings.fadeBeatMs +
    timings.fadeOutMs
  );
}

export function getSwapActionCloseOffsetMs({ swapPhaseMs, softLockPercent }) {
  const safePhaseMs = Math.max(1, Number(swapPhaseMs || 0));
  const percent = Math.max(0, Math.min(100, Number(softLockPercent || 0)));
  const remainingFraction = percent / 100;
  return Math.round(safePhaseMs * (1 - remainingFraction));
}
