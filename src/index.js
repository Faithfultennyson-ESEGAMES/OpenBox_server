import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import config from './config.js';
import { validateEnv } from './config/validateEnv.js';
import redisStore from './store/redisStore.js';
import sessionRegistry from './runtime/sessionRegistry.js';
import routes from './http/routes.js';
import { ClientMessageType, ServerMessageType } from './shared/protocol.js';
import { sendError } from './ws/wsProtocol.js';
import { initWebhookDispatcher } from './webhooks/dispatcher.js';

const app = express();
app.set('trust proxy', true);

function setNoStoreHeaders(res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
}

app.use((req, res, next) => {
  const requestOrigin = req.get('origin') || '';
  const allowOrigin = config.clientOrigins.length > 0
    ? config.clientOrigins.includes(requestOrigin)
    : !!requestOrigin;

  if (allowOrigin && requestOrigin) {
    res.setHeader('Access-Control-Allow-Origin', requestOrigin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }

  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Hub-Signature-256');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  next();
});
app.use(express.json());

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientRoot = path.resolve(__dirname, '../../client/public');

app.use('/src', express.static(path.join(clientRoot, 'src'), {
  etag: false,
  lastModified: false,
  setHeaders: setNoStoreHeaders
}));
app.use('/assets', express.static(path.join(clientRoot, 'assets'), {
  etag: false,
  lastModified: false,
  setHeaders: setNoStoreHeaders
}));
app.use(routes);
app.use((error, req, res, next) => {
  console.error('[HTTP]', error);
  if (res.headersSent) {
    next(error);
    return;
  }

  res.status(500).json({
    error: error?.message || 'Internal server error'
  });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', async (ws, req) => {
  if (config.clientOrigins.length > 0 && req.headers.origin && !config.clientOrigins.includes(req.headers.origin)) {
    ws.close(1008, 'Origin not allowed');
    return;
  }

  ws.on('message', async (raw) => {
    try {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        sendError(ws, 'BAD_JSON', 'Invalid JSON');
        return;
      }

      if (message.type === ClientMessageType.HELLO) {
        const runtime = await sessionRegistry.getOrHydrate(message.sessionId || message.sessionID);
        if (!runtime) {
          sendError(ws, 'SESSION_NOT_FOUND', 'Session not found');
          return;
        }
        await runtime.handleHello(ws, message);
        return;
      }

      if (!ws.sessionId || !ws.playerId) {
        sendError(ws, 'AUTH_REQUIRED', 'Send HELLO first');
        return;
      }

      const runtime = await sessionRegistry.getOrHydrate(ws.sessionId);
      if (!runtime) {
        sendError(ws, 'SESSION_NOT_FOUND', 'Session not found');
        return;
      }
      await runtime.handleSocketMessage(ws, message);
    } catch (error) {
      console.error('[WS:message]', error);
      sendError(ws, 'SERVER_ERROR', error?.message || 'Server error');
    }
  });

  ws.on('close', async () => {
    try {
      if (!ws.sessionId || !ws.playerId) return;
      const runtime = await sessionRegistry.getOrHydrate(ws.sessionId);
      if (runtime) {
        await runtime.handleDisconnect(ws.playerId);
      }
    } catch (error) {
      console.error('[WS:close]', error);
    }
  });
});

setInterval(() => {
  for (const runtime of sessionRegistry.values()) {
    runtime.broadcast(ServerMessageType.PING, {});
  }
}, config.heartbeatIntervalMs);

setInterval(() => {
  sessionRegistry.handleHeartbeatTimeouts(Date.now()).catch((error) => console.error(error));
}, config.heartbeatIntervalMs);

process.on('unhandledRejection', (error) => {
  console.error('[Process:unhandledRejection]', error);
});

process.on('uncaughtException', (error) => {
  console.error('[Process:uncaughtException]', error);
});

async function main() {
  validateEnv();
  await initWebhookDispatcher();
  await redisStore.connect();
  for (const sessionId of await redisStore.getActiveSessionIds()) {
    await sessionRegistry.hydrateSession(sessionId);
  }

  server.listen(config.port, () => {
    console.log(`Open Box server listening on ${config.port}`);
  });
}

main().catch((error) => {
  console.error('[Startup]', error);
  process.exit(1);
});
