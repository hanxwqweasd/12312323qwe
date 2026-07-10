const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { json } = require('../utils/format');
const router = express.Router();
router.use(requireAuth);

router.get('/settings', (req, res) => {
  let settings = db.prepare('SELECT * FROM user_privacy_settings WHERE user_id = ?').get(req.userId);
  if (!settings) {
    db.prepare('INSERT INTO user_privacy_settings (user_id) VALUES (?)').run(req.userId);
    settings = db.prepare('SELECT * FROM user_privacy_settings WHERE user_id = ?').get(req.userId);
  }
  res.json({ settings });
});

router.put('/settings', (req, res) => {
  const fields = ['hide_phone','hide_online','sealed_sender','strip_media_metadata','protect_forwards','screenshot_guard'];
  db.prepare('INSERT OR IGNORE INTO user_privacy_settings (user_id) VALUES (?)').run(req.userId);
  const sets = [], vals = [];
  for (const f of fields) {
    if (req.body[f] !== undefined) { sets.push(`${f} = ?`); vals.push(req.body[f] ? 1 : 0); }
  }
  if (sets.length) { sets.push('updated_at = datetime(\'now\')'); vals.push(req.userId); db.prepare(`UPDATE user_privacy_settings SET ${sets.join(', ')} WHERE user_id = ?`).run(...vals); }
  res.json({ settings: db.prepare('SELECT * FROM user_privacy_settings WHERE user_id = ?').get(req.userId) });
});

router.post('/secret-chats', (req, res) => {
  const { peerUsername, keyFingerprint, autoDeleteSeconds } = req.body || {};
  const peer = db.prepare('SELECT * FROM users WHERE username = ?').get(peerUsername || '');
  if (!peer) return res.status(404).json({ error: 'Пользователь не найден' });
  const [a, b] = req.userId < peer.id ? [req.userId, peer.id] : [peer.id, req.userId];
  const qrPayload = crypto.randomBytes(24).toString('base64url');
  const info = db.prepare(`INSERT OR IGNORE INTO secret_chats (user_a_id, user_b_id, key_fingerprint, qr_payload, auto_delete_seconds)
    VALUES (?, ?, ?, ?, ?)`).run(a, b, keyFingerprint || crypto.randomBytes(8).toString('hex'), qrPayload, autoDeleteSeconds || null);
  const chat = db.prepare('SELECT * FROM secret_chats WHERE user_a_id = ? AND user_b_id = ? ORDER BY id DESC LIMIT 1').get(a, b);
  res.status(201).json({ secretChat: chat });
});

router.get('/secret-chats', (req, res) => {
  const rows = db.prepare('SELECT * FROM secret_chats WHERE user_a_id = ? OR user_b_id = ? ORDER BY created_at DESC').all(req.userId, req.userId);
  res.json({ secretChats: rows });
});

router.post('/verify-key', (req, res) => {
  const { secretChatId, emojiCode, qrPayload } = req.body || {};
  const chat = db.prepare('SELECT * FROM secret_chats WHERE id = ? AND (user_a_id = ? OR user_b_id = ?)').get(Number(secretChatId), req.userId, req.userId);
  if (!chat) return res.status(404).json({ error: 'Secret chat не найден' });
  const verified = qrPayload ? qrPayload === chat.qr_payload : Boolean(emojiCode);
  res.json({ ok: true, verified, fingerprint: chat.key_fingerprint });
});

router.post('/encrypted-media-meta', (req, res) => {
  const { mediaId, encryptionMeta } = req.body || {};
  const media = db.prepare('SELECT * FROM media_files WHERE id = ? AND owner_id = ?').get(Number(mediaId), req.userId);
  if (!media) return res.status(404).json({ error: 'Файл не найден' });
  db.prepare('UPDATE media_files SET encrypted = 1, encryption_meta_json = ? WHERE id = ?').run(json(encryptionMeta || {}), media.id);
  res.json({ ok: true });
});

module.exports = router;
