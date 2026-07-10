const { logger } = require('../infra/logger');

function notFound(req, res) {
  res.status(404).json({ error: 'Маршрут не найден', path: req.originalUrl });
}

function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);
  const status = err.status || err.statusCode || 500;
  logger.error({ err, requestId: req.id, path: req.originalUrl }, 'Unhandled request error');
  res.status(status).json({
    error: status >= 500 ? 'Внутренняя ошибка сервера' : err.message,
    requestId: req.id || null,
  });
}

module.exports = { notFound, errorHandler };
