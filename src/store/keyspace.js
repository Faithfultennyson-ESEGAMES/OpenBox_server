export const keyspace = {
  session: (sessionId) => `ob:session:${sessionId}`,
  players: (sessionId) => `ob:session:${sessionId}:players`,
  round: (sessionId, roundId) => `ob:session:${sessionId}:round:${roundId}`,
  boxes: (sessionId, roundId) => `ob:session:${sessionId}:round:${roundId}:boxes`,
  swaps: (sessionId, roundId) => `ob:session:${sessionId}:round:${roundId}:swaps`,
  events: (sessionId) => `ob:session:${sessionId}:events`,
  replay: (sessionId) => `ob:session:${sessionId}:replay`,
  playerLock: (playerId) => `ob:player:${playerId}:active-session`,
  activeSessions: () => 'ob:sessions:active'
};
