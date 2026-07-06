// src/routes/users.js
const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const AVATAR_DIR = path.join(__dirname, '..', '..', 'data', 'avatars');
fs.mkdirSync(AVATAR_DIR, { recursive: true });

const avatarUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, AVATAR_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || '.jpg';
      cb(null, `user-${req.userId}-${Date.now()}${ext}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 МБ — достаточно для аватара
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Аватар должен быть изображением'));
    }
    cb(null, true);
  },
});

const USERNAME_RE = /^[a-zA-Z0-9_]{4,30}$/;

router.use(requireAuth);

function avatarUrl(avatarPath) {
  if (!avatarPath) return null;
  return `/avatars/${path.basename(avatarPath)}`;
}

function publicProfile(user) {
  return {
    id: user.id,
    username: user.username,
    nickname: user.nickname,
    bio: user.bio,
    avatarUrl: avatarUrl(user.avatar_path),
    isPremium: Boolean(user.is_premium),
    premiumEmoji: user.premium_emoji,
  };
}

/** Точный поиск по username — старт нового чата без адресной книги/телефона. */
router.get('/lookup/:username', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(req.params.username);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  res.json({ ...publicProfile(user), boxPublicKey: user.box_public_key });
});

router.get('/me', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  res.json({ user: { ...publicProfile(user), nyxBalance: user.nyx_balance, referralCode: user.referral_code } });
});

/** Смена никнейма, статуса (bio) и premium-оформления — не влияет на username/переписки. */
router.patch('/me', (req, res) => {
  const { nickname, bio, isPremium, premiumEmoji } = req.body || {};

  if (nickname !== undefined) {
    if (!nickname.trim() || nickname.trim().length > 40) {
      return res.status(400).json({ error: 'Никнейм: 1-40 символов' });
    }
    db.prepare('UPDATE users SET nickname = ? WHERE id = ?').run(nickname.trim(), req.userId);
  }
  if (bio !== undefined) {
    if (bio.length > 200) return res.status(400).json({ error: 'Статус: до 200 символов' });
    db.prepare('UPDATE users SET bio = ? WHERE id = ?').run(bio, req.userId);
  }
  if (isPremium !== undefined) {
    // ВАЖНО: здесь нет реальной оплаты — это демо-переключатель, чтобы можно
    // было протестировать premium-оформление (золотое кольцо аватара,
    // эмодзi статуса). Настоящий продукт должен проверять реальную покупку
    // (App Store/Play Billing или Stripe) перед установкой этого флага.
    db.prepare('UPDATE users SET is_premium = ? WHERE id = ?').run(isPremium ? 1 : 0, req.userId);
  }
  if (premiumEmoji !== undefined) {
    db.prepare('UPDATE users SET premium_emoji = ? WHERE id = ?').run(premiumEmoji, req.userId);
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  res.json({ user: publicProfile(user) });
});

/**
 * Смена username. ВАЖНО (ограничение, о котором стоит знать): у других
 * пользователей локальный список чатов на клиенте ключуется по username —
 * после смены их экран чатов покажет старое имя до тех пор, пока они не
 * откроют этот чат заново (сервер внутри всегда работает по user id, так
 * что сама переписка не потеряется — устареет только подпись в списке).
 */
router.patch('/me/username', (req, res) => {
  const { username } = req.body || {};
  if (!USERNAME_RE.test(username || '')) {
    return res.status(400).json({ error: 'Username: 4-30 символов, латиница/цифры/"_"' });
  }

  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing && existing.id !== req.userId) {
    return res.status(409).json({ error: 'Username уже занят' });
  }

  db.prepare('UPDATE users SET username = ? WHERE id = ?').run(username, req.userId);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  res.json({ user: publicProfile(user) });
});

router.post('/me/avatar', (req, res) => {
  avatarUpload.single('avatar')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'Файл не получен' });

    const prev = db.prepare('SELECT avatar_path FROM users WHERE id = ?').get(req.userId);
    db.prepare('UPDATE users SET avatar_path = ? WHERE id = ?').run(req.file.filename, req.userId);

    if (prev?.avatar_path) {
      const oldPath = path.join(AVATAR_DIR, prev.avatar_path);
      fs.unlink(oldPath, () => {});
    }

    res.json({ avatarUrl: avatarUrl(req.file.filename) });
  });
});

module.exports = router;
module.exports.avatarUpload = avatarUpload;
