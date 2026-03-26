import config from '../config.js';
import { keyspace } from './keyspace.js';

class RedisStore {
  constructor() {
    this.client = null;
    this.connected = false;
    this.memory = {
      kv: new Map(),
      sets: new Map(),
      lists: new Map()
    };
  }

  get useMemory() {
    return config.storeMode === 'memory';
  }

  async connect() {
    if (this.connected) return;
    if (this.useMemory) {
      this.connected = true;
      return;
    }
    const { createClient } = await import('redis');
    this.client = createClient({
      url: config.redisUrl,
      socket: {
        reconnectStrategy(retries) {
          return Math.min(250 * (2 ** retries), 5000);
        },
        keepAlive: 5000
      }
    });
    this.client.on('ready', () => {
      this.connected = true;
      console.log('[Redis] Ready');
    });
    this.client.on('end', () => {
      this.connected = false;
      console.warn('[Redis] Connection closed');
    });
    this.client.on('reconnecting', () => {
      this.connected = false;
      console.warn('[Redis] Reconnecting');
    });
    this.client.on('error', (error) => {
      this.connected = false;
      console.error('[Redis]', error);
    });
    await this.client.connect();
    this.connected = true;
  }

  async disconnect() {
    if (!this.connected) return;
    if (this.useMemory) {
      this.connected = false;
      return;
    }
    if (this.client?.isOpen) {
      await this.client.quit();
    }
    this.connected = false;
  }

  async setJson(key, value, ttlSec = config.redisKeyTtlSec) {
    if (this.useMemory) {
      this.memory.kv.set(key, JSON.stringify(value));
      return;
    }
    await this.client.set(key, JSON.stringify(value));
    if (ttlSec > 0) {
      await this.client.expire(key, ttlSec);
    }
  }

  async getJson(key) {
    if (this.useMemory) {
      const raw = this.memory.kv.get(key);
      return raw ? JSON.parse(raw) : null;
    }
    const raw = await this.client.get(key);
    return raw ? JSON.parse(raw) : null;
  }

  async pushEvent(sessionId, event) {
    const listKey = keyspace.events(sessionId);
    if (this.useMemory) {
      const list = this.memory.lists.get(listKey) || [];
      list.push(JSON.stringify(event));
      this.memory.lists.set(listKey, list);
      return;
    }
    await this.client.rPush(listKey, JSON.stringify(event));
    if (config.redisKeyTtlSec > 0) {
      await this.client.expire(listKey, config.redisKeyTtlSec);
    }
  }

  async getEvents(sessionId, limit = 200) {
    const listKey = keyspace.events(sessionId);
    if (this.useMemory) {
      const list = this.memory.lists.get(listKey) || [];
      return list
        .slice(Math.max(0, list.length - limit))
        .map((entry) => JSON.parse(entry));
    }
    const start = Math.max(-limit, -10_000);
    const raw = await this.client.lRange(listKey, start, -1);
    return raw.map((entry) => JSON.parse(entry));
  }

  async setSession(session) {
    await this.setJson(keyspace.session(session.sessionId), session);
    if (this.useMemory) {
      const active = this.memory.sets.get(keyspace.activeSessions()) || new Set();
      active.add(session.sessionId);
      this.memory.sets.set(keyspace.activeSessions(), active);
      return;
    }
    await this.client.sAdd(keyspace.activeSessions(), session.sessionId);
  }

  async getSession(sessionId) {
    return this.getJson(keyspace.session(sessionId));
  }

  async setPlayers(sessionId, players) {
    await this.setJson(keyspace.players(sessionId), players);
  }

  async getPlayers(sessionId) {
    return (await this.getJson(keyspace.players(sessionId))) || [];
  }

  async setRound(round) {
    await this.setJson(keyspace.round(round.sessionId, round.roundId), round);
  }

  async getRound(sessionId, roundId) {
    return this.getJson(keyspace.round(sessionId, roundId));
  }

  async setBoxes(sessionId, roundId, boxes) {
    await this.setJson(keyspace.boxes(sessionId, roundId), boxes);
  }

  async getBoxes(sessionId, roundId) {
    return (await this.getJson(keyspace.boxes(sessionId, roundId))) || [];
  }

  async setSwaps(sessionId, roundId, swaps) {
    await this.setJson(keyspace.swaps(sessionId, roundId), swaps);
  }

  async getSwaps(sessionId, roundId) {
    return (
      (await this.getJson(keyspace.swaps(sessionId, roundId))) || {
        queue: [],
        matched: [],
        keepers: []
      }
    );
  }

  async setReplayState(sessionId, replayState) {
    await this.setJson(keyspace.replay(sessionId), replayState);
  }

  async getReplayState(sessionId) {
    return this.getJson(keyspace.replay(sessionId));
  }

  async getPlayerActiveSession(playerId) {
    const key = keyspace.playerLock(playerId);
    if (this.useMemory) {
      return this.memory.kv.get(key) || null;
    }
    return this.client.get(key);
  }

  async claimPlayerActiveSession(playerId, sessionId, ttlSec = config.redisKeyTtlSec) {
    const key = keyspace.playerLock(playerId);

    if (this.useMemory) {
      const existing = this.memory.kv.get(key) || null;
      if (existing && existing !== sessionId) {
        return { ok: false, activeSessionId: existing };
      }
      this.memory.kv.set(key, sessionId);
      return { ok: true, activeSessionId: sessionId };
    }

    const claimed = await this.client.set(
      key,
      sessionId,
      ttlSec > 0 ? { NX: true, EX: ttlSec } : { NX: true }
    );

    if (claimed === 'OK') {
      return { ok: true, activeSessionId: sessionId };
    }

    const existing = await this.client.get(key);
    if (existing === sessionId) {
      if (ttlSec > 0) {
        await this.client.expire(key, ttlSec);
      }
      return { ok: true, activeSessionId: existing };
    }

    return { ok: false, activeSessionId: existing || null };
  }

  async releasePlayerActiveSession(playerId, sessionId = null) {
    const key = keyspace.playerLock(playerId);

    if (this.useMemory) {
      const existing = this.memory.kv.get(key) || null;
      if (sessionId && existing && existing !== sessionId) {
        return false;
      }
      this.memory.kv.delete(key);
      return true;
    }

    if (!sessionId) {
      await this.client.del(key);
      return true;
    }

    const existing = await this.client.get(key);
    if (existing && existing !== sessionId) {
      return false;
    }

    await this.client.del(key);
    return true;
  }

  async removeActiveSession(sessionId) {
    if (this.useMemory) {
      const active = this.memory.sets.get(keyspace.activeSessions()) || new Set();
      active.delete(sessionId);
      this.memory.sets.set(keyspace.activeSessions(), active);
      return;
    }
    await this.client.sRem(keyspace.activeSessions(), sessionId);
  }

  async getActiveSessionIds() {
    if (this.useMemory) {
      return [...(this.memory.sets.get(keyspace.activeSessions()) || new Set())];
    }
    return this.client.sMembers(keyspace.activeSessions());
  }
}

export const redisStore = new RedisStore();
export default redisStore;
