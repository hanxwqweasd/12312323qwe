function optionalRequire(name) {
  try { return require(name); } catch (e) { return null; }
}

const pino = optionalRequire('pino');

const fallback = {
  info: (...args) => console.log('[info]', ...args),
  warn: (...args) => console.warn('[warn]', ...args),
  error: (...args) => console.error('[error]', ...args),
  debug: (...args) => { if (process.env.LOG_LEVEL === 'debug') console.log('[debug]', ...args); },
  child: () => fallback,
};

const logger = pino
  ? pino({
      level: process.env.LOG_LEVEL || 'info',
      redact: ['req.headers.authorization', 'password', 'token', '*.token', '*.password'],
      base: { service: 'nyx-server' },
    })
  : fallback;

function httpLogger() {
  const pinoHttp = optionalRequire('pino-http');
  if (!pinoHttp || !pino) {
    return (req, res, next) => next();
  }
  return pinoHttp({ logger });
}

module.exports = { logger, httpLogger, optionalRequire };
