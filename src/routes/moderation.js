const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const router = express.Router();
router.use(requireAuth);

router.post('/reports', (req, res) => {
  const targetType = String(req.body?.targetType || req.body?.target_type || '').trim();
  const targetId = String(req.body?.targetId || req.body?.target_id || '').trim();
  const reason = String(req.body?.reason || '').trim();
  const details = String(req.body?.details || '').trim();
  if (!['user','channel','group','bot','message','story','file'].includes(targetType)) return res.status(400).json({ error: 'Неверный тип жалобы' });
  if (!targetId) return res.status(400).json({ error: 'Не указан объект жалобы' });
  if (!reason) return res.status(400).json({ error: 'Укажите причину жалобы' });
  const info = db.prepare(`INSERT INTO moderation_reports (reporter_id, target_type, target_id, reason, details)
    VALUES (?, ?, ?, ?, ?)`).run(req.userId, targetType, targetId, reason, details || null);
  res.status(201).json({ ok: true, reportId: info.lastInsertRowid });
});

router.post('/block/:username', (req, res) => {
  const user = db.prepare('SELECT id, username, nickname FROM users WHERE username = ? AND deleted_at IS NULL').get(req.params.username);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  if (user.id === req.userId) return res.status(400).json({ error: 'Нельзя заблокировать себя' });
  db.prepare('INSERT OR IGNORE INTO user_blocks (blocker_id, blocked_user_id) VALUES (?, ?)').run(req.userId, user.id);
  res.json({ ok: true, blocked: user });
});

router.delete('/block/:username', (req, res) => {
  const user = db.prepare('SELECT id FROM users WHERE username = ?').get(req.params.username);
  if (user) db.prepare('DELETE FROM user_blocks WHERE blocker_id = ? AND blocked_user_id = ?').run(req.userId, user.id);
  res.json({ ok: true });
});

router.get('/blocks', (req, res) => {
  const rows = db.prepare(`SELECT u.id, u.username, u.nickname, u.avatar_path, b.created_at
    FROM user_blocks b JOIN users u ON u.id = b.blocked_user_id WHERE b.blocker_id = ? ORDER BY b.created_at DESC`).all(req.userId);
  res.json({ users: rows.map((u) => ({ ...u, avatarUrl: u.avatar_path ? `/avatars/${u.avatar_path}` : null })) });
});

router.post('/hide', (req, res) => {
  const targetType = String(req.body?.targetType || '').trim();
  const targetId = String(req.body?.targetId || '').trim();
  if (!targetType || !targetId) return res.status(400).json({ error: 'targetType и targetId обязательны' });
  db.prepare('INSERT OR REPLACE INTO hidden_content (user_id, target_type, target_id) VALUES (?, ?, ?)').run(req.userId, targetType, targetId);
  res.json({ ok: true });
});

module.exports = router;
