export const SessionStatus = Object.freeze({
  CREATED: 'CREATED',
  WAITING_FOR_FIRST_JOIN: 'WAITING_FOR_FIRST_JOIN',
  ROUND_ACTIVE: 'ROUND_ACTIVE',
  REPLAY_WAITING: 'REPLAY_WAITING',
  ENDED: 'ENDED',
  CANCELLED: 'CANCELLED'
});

export const RoundStatus = Object.freeze({
  WAITING_FOR_FIRST_JOIN: 'WAITING_FOR_FIRST_JOIN',
  JOIN_WINDOW_OPEN: 'JOIN_WINDOW_OPEN',
  READY_CHECK: 'READY_CHECK',
  DISTRIBUTING: 'DISTRIBUTING',
  SWAP_OPEN: 'SWAP_OPEN',
  SWAP_CLOSED: 'SWAP_CLOSED',
  REVEALING: 'REVEALING',
  ROUND_ENDED: 'ROUND_ENDED',
  ROUND_CANCELLED: 'ROUND_CANCELLED'
});

export const SwapState = Object.freeze({
  NONE: 'NONE',
  KEPT: 'KEPT',
  PENDING: 'PENDING',
  MATCHED: 'MATCHED',
  UNMATCHED: 'UNMATCHED'
});

export const ParticipationLabel = Object.freeze({
  REGISTERED_ABSENT: 'REGISTERED_ABSENT',
  JOINED_ACTIVE: 'JOINED_ACTIVE',
  DISCONNECTED: 'DISCONNECTED',
  RECONNECTED: 'RECONNECTED',
  ROUND_COMPLETE: 'ROUND_COMPLETE'
});

export const ClientMessageType = Object.freeze({
  HELLO: 'hello',
  PONG: 'pong',
  ROUND_READY: 'ready_up',
  SWAP_REQUEST: 'swap_request',
  KEEP_BOX: 'keep_box',
  TIMER_END: 'timer_end',
  LEADERBOARD_REQUEST: 'leaderboard_request'
});

export const ServerMessageType = Object.freeze({
  WELCOME: 'welcome',
  READY_STATUS: 'ready_status',
  SESSION_INIT: 'session_init',
  REPLAY_STARTED: 'replay_started',
  SWAP_RESULT: 'swap_result',
  SOFTLOCK: 'softlock',
  ROUND_RESULT: 'round_result',
  LEADERBOARD_DATA: 'leaderboard_data',
  ERROR: 'error',
  PING: 'ping'
});

export const WebhookEventType = Object.freeze({
  SESSION_CREATED: 'session.created',
  PLAYER_JOINED: 'player.joined',
  PLAYER_DISCONNECTED: 'player.disconnected',
  PLAYER_RECONNECTED: 'player.reconnected',
  ROUND_JOIN_WINDOW_STARTED: 'round.join_window_started',
  ROUND_STARTED: 'round.started',
  ROUND_CANCELLED: 'round.cancelled',
  ROUND_SWAP_MATCHED: 'round.swap_matched',
  ROUND_ENDED: 'round.ended',
  SESSION_REPLAY_WAITING: 'session.replay_waiting',
  SESSION_REPLAY_STARTED: 'session.replay_started',
  SESSION_ENDED: 'session.ended'
});
