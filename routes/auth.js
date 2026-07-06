// src/routes/auth.js
//
// Аутентификация без телефона: username + password (обычный вход) ИЛИ
// восстановление доступа через доказательство владения seed-фразой —
// клиент детерминированно выводит из seed пару ключей Ed25519
// (sign) + X25519 (box, для E2E) ещё на этапе регистрации
// (см. клиентский utils/e2e.js). Восстановление устроено как
// challenge-response: сервер никогда не видит и не хранит seed —
// только публичный ключ подписи, и просит доказать владение приватным
// ключом, подписав одноразовый nonce.

const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const nacl = require('tweetnacl');
const naclUtil = require('tweetnacl-util');

const db = require('../db');
const { signToken } = require('../middleware/auth');

const router = express.Router();

const USERNAME_RE = /^[a-zA-Z0-9_]{4,30}$/;
const RECOVERY_CHALLENGE_TTL_MS = 5 * 60 * 1000;

function publicUser(row) {
  return { id: row.id, username: row.username, nickname: row.nickname };
}

router.post('/register', async (req, res) => {
  const { username, password, nickname, referralCode, signPublicKey, boxPublicKey } = req.body || {};

  if (!USERNAME_RE.test(username || '')) {
    return res.status(400).json({ error: 'Username: 4-30 символов, латиница/цифры/"_"' });
  }
  if (!password || password.length < 8) {
    return res.status(400).json({ error: 'Пароль минимум 8 символов' });
  }
  if (!signPublicKey || !boxPublicKey) {
    return res.status(400).json({ error: 'Отсутствуют криптографические публичные ключи' });
  }

  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) {
    return res.status(409).json({ error: 'Username уже занят' });
  }

  const passwordHash = await bcrypt.hash(password, 12);

  const info = db
    .prepare(
      `INSERT INTO users (username, nickname, password_hash, sign_public_key, box_public_key, referral_code)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(username, nickname || username, passwordHash, signPublicKey, boxPublicKey, referralCode || null);

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  const token = signToken(user);

  res.status(201).json({ token, user: publicUser(user) });
});

router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username || '');
  if (!user) return res.status(401).json({ error: 'Неверный username или пароль' });

  const ok = await bcrypt.compare(password || '', user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Неверный username или пароль' });

  const token = signToken(user);
  res.json({ token, user: publicUser(user) });
});

/**
 * Шаг 1 восстановления: клиент просит nonce для username, который он
 * предположительно контролирует (доказав это на следующем шаге подписью).
 */
router.post('/recover/challenge', (req, res) => {
  const { username } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username || '');
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

  const nonce = crypto.randomBytes(32).toString('base64');
  const expiresAt = new Date(Date.now() + RECOVERY_CHALLENGE_TTL_MS).toISOString();

  db.prepare(
    `INSERT INTO recovery_challenges (username, nonce, expires_at) VALUES (?, ?, ?)
     ON CONFLICT(username) DO UPDATE SET nonce = excluded.nonce, expires_at = excluded.expires_at`
  ).run(username, nonce, expiresAt);

  res.json({ nonce });
});

/**
 * Шаг 2: клиент подписывает nonce приватным ключом Ed25519, выведенным
 * из seed-фразы, и присылает подпись. Сервер проверяет её публичным
 * ключом, сохранённым при регистрации — если сходится, значит клиент
 * действительно владеет исходной seed-фразой.
 */
router.post('/recover/verify', (req, res) => {
  const { username, signature, newPassword } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username || '');
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

  const challenge = db.prepare('SELECT * FROM recovery_challenges WHERE username = ?').get(username);
  if (!challenge || new Date(challenge.expires_at).getTime() < Date.now()) {
    return res.status(400).json({ error: 'Challenge истёк, запросите новый' });
  }

  let isValidSignature = false;
  try {
    isValidSignature = nacl.sign.detached.verify(
      naclUtil.decodeBase64(challenge.nonce),
      naclUtil.decodeBase64(signature || ''),
      naclUtil.decodeBase64(user.sign_public_key)
    );
  } catch (e) {
    isValidSignature = false;
  }

  if (!isValidSignature) {
    return res.status(401).json({ error: 'Подпись не подтверждает владение seed-фразой' });
  }

  db.prepare('DELETE FROM recovery_challenges WHERE username = ?').run(username);

  if (newPassword) {
    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'Новый пароль минимум 8 символов' });
    }
    // Синхронный bcrypt здесь ок — это редкая операция восстановления, не хотпас.
    const passwordHash = bcrypt.hashSync(newPassword, 12);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, user.id);
  }

  const token = signToken(user);
  res.json({ token, user: publicUser(user) });
});

module.exports = router;
