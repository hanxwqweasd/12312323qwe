// src/middleware/auth.js
const jwt = require('jsonwebtoken');
const db = require('../db');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error('JWT_SECRET не задан. Смотри .env.example — переменная обязательна.');
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Нет токена авторизации' });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const userId = payload.sub;

    const user = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
    if (!user) {
      return res.status(401).json({ error: 'Пользователь не найден. Войдите заново.' });
    }

    req.userId = userId;
    req.username = payload.username;
    next();
  } catch (e) {
    if (e.name === 'JsonWebTokenError') {
      return res.status(401).json({ error: 'Невалидный или истёкший токен' });
    }
    return res.status(401).json({ error: 'Ошибка авторизации' });
  }
}

function signToken(user) {
  return jwt.sign({ sub: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
}

module.exports = { requireAuth, signToken, JWT_SECRET };
