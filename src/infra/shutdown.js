const { logger } = require('./logger');
const { getRedis, getRedisSubscriber } = require('./redis');
const { getPool } = require('./postgres');

function setupGracefulShutdown(server) {
  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.warn({ signal }, 'Graceful shutdown started');
    server.close(async () => {
      try {
        const redis = getRedis();
        const sub = getRedisSubscriber();
        if (redis) await redis.quit().catch(() => redis.disconnect());
        if (sub) await sub.quit().catch(() => sub.disconnect());
        const pool = getPool();
        if (pool) await pool.end();
      } catch (err) {
        logger.error({ err }, 'Shutdown cleanup failed');
      } finally {
        logger.warn('Graceful shutdown finished');
        process.exit(0);
      }
    });
    setTimeout(() => process.exit(1), Number(process.env.FORCE_SHUTDOWN_MS || 10000)).unref();
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (err) => logger.error({ err }, 'Unhandled rejection'));
  process.on('uncaughtException', (err) => {
    logger.error({ err }, 'Uncaught exception');
    shutdown('uncaughtException');
  });
}

module.exports = { setupGracefulShutdown };
