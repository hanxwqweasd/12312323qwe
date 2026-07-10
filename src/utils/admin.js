const db = require('../db');

const ADMIN_USERNAME = process.env.NYX_ADMIN_USERNAME || 'NyxDev';

function currentUser(req) {
  return db.prepare('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL').get(req.userId);
}

function isNyxAdmin(req) {
  const user = currentUser(req);
  return Boolean(user && String(user.username).toLowerCase() === ADMIN_USERNAME.toLowerCase());
}

function requireNyxAdmin(req, res, next) {
  if (!isNyxAdmin(req)) return res.status(403).json({ error: 'Доступ только для администратора NyxDev' });
  return next();
}

module.exports = { ADMIN_USERNAME, currentUser, isNyxAdmin, requireNyxAdmin };
