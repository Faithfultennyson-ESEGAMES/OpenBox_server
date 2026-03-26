import 'dotenv/config';
import { createClient } from 'redis';

const redisUrl = process.env.REDIS_URL || '';

if (!redisUrl) {
  console.error('REDIS_URL is required.');
  process.exit(1);
}

const client = createClient({
  url: redisUrl,
  socket: {
    reconnectStrategy(retries) {
      return Math.min(250 * (2 ** retries), 5000);
    },
    keepAlive: 5000
  }
});

client.on('error', (error) => {
  console.error('[Redis]', error);
});

async function collectKeys(pattern) {
  const keys = [];
  for await (const key of client.scanIterator({ MATCH: pattern, COUNT: 100 })) {
    keys.push(key);
  }
  return keys;
}

async function main() {
  await client.connect();

  const keys = await collectKeys('ob:*');
  if (keys.length === 0) {
    console.log('No Open Box Redis keys found.');
    await client.quit();
    return;
  }

  let deleted = 0;
  for (let i = 0; i < keys.length; i += 100) {
    const chunk = keys.slice(i, i + 100);
    deleted += await client.del(chunk);
  }

  console.log(`Deleted ${deleted} Open Box Redis key(s).`);
  await client.quit();
}

main().catch(async (error) => {
  console.error('[clearOpenBoxRedis]', error);
  try {
    if (client.isOpen) {
      await client.quit();
    }
  } catch {
    // Ignore cleanup errors.
  }
  process.exit(1);
});
