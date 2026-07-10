const crypto = require('crypto');
const { logger } = require('./logger');

function requestId() {
  return crypto.randomBytes(8).toString('hex');
}

function applyPerformance(app) {
  app.set('trust proxy', Number(process.env.TRUST_PROXY || 1));
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    const started = process.hrtime.bigint();
    req.id = req.headers['x-request-id'] || requestId();
    res.setHeader('x-request-id', req.id);
    res.setHeader('x-nyx-server', 'nyx-api');
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      const slowMs = Number(process.env.SLOW_REQUEST_MS || 750);
      if (ms >= slowMs) logger.warn({ requestId: req.id, method: req.method, path: req.originalUrl, status: res.statusCode, ms: Math.round(ms) }, 'Slow request');
    });
    next();
  });

  app.use((req, res, next) => {
    const timeoutMs = Number(process.env.REQUEST_TIMEOUT_MS || 30000);
    req.setTimeout(timeoutMs);
    res.setTimeout(timeoutMs);
    next();
  });

  logger.info('Performance middleware initialized');
}

function staticCacheOptions() {
  return {
    maxAge: process.env.STATIC_MAX_AGE || '7d',
    etag: true,
    immutable: process.env.STATIC_IMMUTABLE === 'true',
    fallthrough: true,
  };
}

module.exports = { applyPerformance, staticCacheOptions };
