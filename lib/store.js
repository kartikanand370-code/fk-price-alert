const fs = require('node:fs/promises');
const path = require('node:path');

const KEY = process.env.UPSTASH_REDIS_KEY || 'flipkart-stock-signal:telegram-state';
const FILE = path.join(process.cwd(), 'data', 'telegram-state.json');

function hasRedis() {
  return Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
}

async function redisCommand(command) {
  const response = await fetch(process.env.UPSTASH_REDIS_REST_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(command)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) throw new Error('Persistent state service request failed.');
  return data.result;
}

function emptyState() {
  return { users: {}, updatedAt: '' };
}

async function readState() {
  if (hasRedis()) {
    const value = await redisCommand(['GET', KEY]);
    if (!value) return emptyState();
    try { return JSON.parse(value); } catch { return emptyState(); }
  }
  try {
    return JSON.parse(await fs.readFile(FILE, 'utf8'));
  } catch {
    return emptyState();
  }
}

async function writeState(state) {
  const value = JSON.stringify({ ...state, updatedAt: new Date().toISOString() });
  if (hasRedis()) {
    await redisCommand(['SET', KEY, value]);
    return;
  }
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  await fs.writeFile(FILE, value, 'utf8');
}

module.exports = { readState, writeState, emptyState };
