const crypto = require('crypto');
const { optionalRequire, logger } = require('./logger');

function applySecurity(app) {
  const helmet = optionalRequire('helmet');
  const compression = optionalRequire('compression');
  const rateLimit = optionalRequire('express-rate-limit');

  if (helmet) app.use(helmet({ crossOriginResourcePolicy: false }));
  if (compression) app.use(compression());

  if (rateLimit) {
    app.use(rateLimit({
      windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000),
      limit: Number(process.env.RATE_LIMIT_MAX || 240),
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: { error: 'Слишком много запросов. Попробуйте позже.' },
    }));
  }

  app.use(antiSpamMiddleware());
  logger.info('Security middleware initialized');
}

const memoryBuckets = new Map();

function antiSpamMiddleware() {
  const windowMs = Number(process.env.ANTISPAM_WINDOW_MS || 10_000);
  const maxWrites = Number(process.env.ANTISPAM_MAX_WRITES || 35);
  const writeMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
  return (req, res, next) => {
    if (!writeMethods.has(req.method)) return next();
    const key = `${req.userId || 'anon'}:${req.ip}`;
    const now = Date.now();
    const bucket = memoryBuckets.get(key) || [];
    const fresh = bucket.filter((ts) => now - ts < windowMs);
    fresh.push(now);
    memoryBuckets.set(key, fresh);
    if (fresh.length > maxWrites) {
      return res.status(429).json({ error: 'Антиспам: слишком много действий за короткое время' });
    }
    return next();
  };
}

function hashIp(ip) {
  const salt = process.env.IP_HASH_SALT || 'nyx-local-salt';
  return crypto.createHash('sha256').update(`${salt}:${ip || ''}`).digest('hex');
}

module.exports = { applySecurity, antiSpamMiddleware, hashIp };
