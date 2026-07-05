// src/routes/users.js
const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth);

/** Точный поиск по username — старт нового чата без адресной книги/телефона. */
router.get('/lookup/:username', (req, res) => {
  const user = db
    .prepare('SELECT id, username, nickname, box_public_key, sign_public_key FROM users WHERE username = ?')
    .get(req.params.username);

  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

  res.json({
    id: user.id,
    username: user.username,
    nickname: user.nickname,
    boxPublicKey: user.box_public_key,
  });
});

router.get('/me', (req, res) => {
  const user = db.prepare('SELECT id, username, nickname, referral_code FROM users WHERE id = ?').get(req.userId);
  res.json({ user });
});

module.exports = router;
