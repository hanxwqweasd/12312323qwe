const { logger, optionalRequire } = require('./logger');
const IORedis = optionalRequire('ioredis');

let redis = null;
let subscriber = null;

function isRedisEnabled() {
  return !!process.env.REDIS_URL;
}

function createRedisConnection(role = 'default') {
  if (!isRedisEnabled() || !IORedis) return null;
  const connection = new IORedis(process.env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    lazyConnect: false,
  });
  connection.on('error', (err) => logger.warn({ err, role }, 'Redis connection error'));
  return connection;
}

function getRedis() {
  if (!isRedisEnabled()) return null;
  if (!IORedis) {
    logger.warn('Redis requested but ioredis is not installed. Run npm install.');
    return null;
  }
  if (!redis) redis = createRedisConnection('main');
  return redis;
}

function getRedisSubscriber() {
  if (!isRedisEnabled()) return null;
  if (!IORedis) return null;
  if (!subscriber) subscriber = createRedisConnection('subscriber');
  return subscriber;
}

async function redisReady() {
  const r = getRedis();
  if (!r) return { enabled: false, ok: false, reason: 'redis_disabled' };
  const started = Date.now();
  try {
    const pong = await r.ping();
    return { enabled: true, ok: pong === 'PONG', latencyMs: Date.now() - started };
  } catch (err) {
    return { enabled: true, ok: false, error: err.message };
  }
}

module.exports = { isRedisEnabled, getRedis, getRedisSubscriber, redisReady, createRedisConnection };
