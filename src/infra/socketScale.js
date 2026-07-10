const { logger, optionalRequire } = require('./logger');
const { getRedis, getRedisSubscriber } = require('./redis');

function applySocketScaling(io) {
  const adapterPkg = optionalRequire('@socket.io/redis-adapter');
  const pub = getRedis();
  const sub = getRedisSubscriber();
  if (!adapterPkg || !pub || !sub) {
    logger.info('Socket.io Redis adapter disabled; single instance mode');
    return { enabled: false };
  }
  io.adapter(adapterPkg.createAdapter(pub, sub));
  logger.info('Socket.io Redis adapter enabled for horizontal scaling');
  return { enabled: true };
}

module.exports = { applySocketScaling };
