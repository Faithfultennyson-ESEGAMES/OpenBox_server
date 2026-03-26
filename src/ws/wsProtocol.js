const SOCKET_OPEN = 1;

export function safeSend(ws, payload) {
  if (!ws || ws.readyState !== SOCKET_OPEN) return;
  ws.send(JSON.stringify(payload));
}

export function send(ws, type, payload = {}) {
  safeSend(ws, { type, ...payload });
}

export function sendError(ws, code, message) {
  send(ws, 'ERROR', { code, message });
}
