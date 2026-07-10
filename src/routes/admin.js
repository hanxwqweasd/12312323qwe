const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { requireNyxAdmin } = require('../utils/admin');
const { safeJsonParse, json, parsePaging } = require('../utils/format');

const router = express.Router();
router.use(requireAuth, requireNyxAdmin);

function like(q) { return `%${String(q || '').trim()}%`; }

router.get('/users', (req, res) => {
  const q = like(req.query.q);
  const rows = db.prepare(`SELECT id, username, nickname, bio, avatar_path, is_premium, nyx_balance, created_at, deleted_at
    FROM users WHERE username LIKE ? OR nickname LIKE ? ORDER BY created_at DESC LIMIT 100`).all(q, q);
  res.json({ users: rows.map((u) => ({ ...u, avatarUrl: u.avatar_path ? `/avatars/${u.avatar_path}` : null })) });
});

router.get('/channels', (req, res) => {
  const q = like(req.query.q);
  const rows = db.prepare(`SELECT c.*, u.username as owner_username, (SELECT COUNT(*) FROM channel_subscriptions s WHERE s.channel_id = c.id) as subscriber_count
    FROM channels c JOIN users u ON u.id = c.owner_id
    WHERE c.name LIKE ? OR c.username LIKE ? OR c.description LIKE ? ORDER BY c.created_at DESC LIMIT 100`).all(q, q, q);
  res.json({ channels: rows });
});

router.get('/bots', (req, res) => {
  const q = like(req.query.q);
  const rows = db.prepare(`SELECT b.id, b.username, b.name, b.description, b.owner_id, u.username as owner_username, b.webhook_url, b.inline_mode, b.is_support_bot, b.created_at
    FROM bots b JOIN users u ON u.id = b.owner_id
    WHERE b.username LIKE ? OR b.name LIKE ? OR b.description LIKE ? ORDER BY b.created_at DESC LIMIT 100`).all(q, q, q);
  res.json({ bots: rows });
});

router.get('/support-tickets', (req, res) => {
  const { limit, offset } = parsePaging(req, 200);
  const rows = db.prepare(`SELECT t.*, u.username, u.nickname FROM support_tickets t JOIN users u ON u.id = t.user_id ORDER BY t.updated_at DESC LIMIT ? OFFSET ?`).all(limit, offset);
  res.json({ tickets: rows });
});

router.get('/reports', (req, res) => {
  const { limit, offset } = parsePaging(req, 200);
  const rows = db.prepare(`SELECT r.*, u.username as reporter_username FROM moderation_reports r JOIN users u ON u.id = r.reporter_id ORDER BY r.created_at DESC LIMIT ? OFFSET ?`).all(limit, offset);
  res.json({ reports: rows });
});

router.patch('/reports/:id', (req, res) => {
  const status = ['new','reviewing','resolved','rejected'].includes(req.body?.status) ? req.body.status : 'resolved';
  db.prepare('UPDATE moderation_reports SET status = ?, resolved_at = datetime(\'now\'), resolved_by = ? WHERE id = ?').run(status, req.userId, Number(req.params.id));
  res.json({ ok: true });
});

router.post('/users/:id/ban', (req, res) => {
  const userId = Number(req.params.id);
  const reason = String(req.body?.reason || 'admin-ban');
  db.prepare(`INSERT INTO moderation_reports (reporter_id, target_type, target_id, reason, details, status, resolved_at, resolved_by)
    VALUES (?, 'user', ?, ?, ?, 'resolved', datetime('now'), ?)`).run(req.userId, String(userId), 'admin_action', reason, req.userId);
  res.json({ ok: true });
});

router.post('/channels/:id/hide', (req, res) => {
  db.prepare('UPDATE channels SET visibility = \'private\', updated_at = datetime(\'now\') WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

router.get('/errors', (req, res) => {
  const rows = db.prepare('SELECT * FROM app_error_reports ORDER BY created_at DESC LIMIT 200').all();
  res.json({ errors: rows.map((r) => ({ ...r, payload: safeJsonParse(r.payload_json, null) })) });
});

router.post('/broadcasts', (req, res) => {
  const title = String(req.body?.title || '').trim();
  const body = String(req.body?.body || '').trim();
  if (!title || !body) return res.status(400).json({ error: 'title и body обязательны' });
  const info = db.prepare('INSERT INTO system_broadcasts (created_by, title, body, payload_json) VALUES (?, ?, ?, ?)').run(req.userId, title, body, json(req.body?.payload || {}));
  const io = req.app.get('io');
  if (io) io.emit('system:broadcast', { id: info.lastInsertRowid, title, body, payload: req.body?.payload || {} });
  res.status(201).json({ ok: true, id: info.lastInsertRowid });
});

module.exports = router;
