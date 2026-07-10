const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const router = express.Router();
router.use(requireAuth);

function like(q) { return `%${String(q || '').trim()}%`; }

router.get('/global', (req, res) => {
  const q = like(req.query.q);
  if (q === '%%') return res.json({ users: [], channels: [], groups: [], bots: [], files: [], messages: [] });
  const users = db.prepare('SELECT id, username, nickname, avatar_path, is_premium, premium_emoji FROM users WHERE username LIKE ? OR nickname LIKE ? LIMIT 20').all(q, q);
  const channels = db.prepare(`SELECT id, name, username, description, photo_url FROM channels WHERE is_deleted = 0 AND visibility = 'public' AND (name LIKE ? OR username LIKE ? OR description LIKE ?) LIMIT 20`).all(q, q, q);
  const groups = db.prepare(`SELECT id, name, username, description, photo_url FROM groups WHERE is_public = 1 AND (name LIKE ? OR username LIKE ? OR description LIKE ?) LIMIT 20`).all(q, q, q);
  const bots = db.prepare('SELECT id, username, name, description FROM bots WHERE username LIKE ? OR name LIKE ? OR description LIKE ? LIMIT 20').all(q, q, q);
  const files = db.prepare('SELECT id, original_name, mime_type, size_bytes, file_path FROM media_files WHERE owner_id = ? AND (original_name LIKE ? OR mime_type LIKE ?) ORDER BY created_at DESC LIMIT 20').all(req.userId, q, q);
  res.json({ users, channels, groups, bots, files: files.map((f) => ({ ...f, url: `/media/${f.file_path}` })) });
});

router.get('/messages', (req, res) => {
  // Direct messages are E2E ciphertext; server cannot search plaintext by design.
  // This endpoint searches non-E2E surfaces: channels and groups.
  const q = like(req.query.q);
  const channelPosts = db.prepare(`SELECT m.id, m.channel_id, c.name as channel_name, m.text, m.created_at FROM channel_messages m JOIN channels c ON c.id = m.channel_id LEFT JOIN channel_subscriptions s ON s.channel_id = c.id AND s.user_id = ? WHERE m.deleted_at IS NULL AND m.scheduled_at IS NULL AND (c.visibility = 'public' OR s.user_id IS NOT NULL) AND m.text LIKE ? ORDER BY m.created_at DESC LIMIT 50`).all(req.userId, q);
  const groupMessages = db.prepare(`SELECT m.id, m.group_id, g.name as group_name, m.text, m.created_at FROM group_messages m JOIN groups g ON g.id = m.group_id JOIN group_members gm ON gm.group_id = g.id AND gm.user_id = ? WHERE m.deleted_at IS NULL AND m.text LIKE ? ORDER BY m.created_at DESC LIMIT 50`).all(req.userId, q);
  res.json({ channelPosts, groupMessages, note: 'Личные сообщения не ищутся сервером, потому что они E2E-зашифрованы.' });
});

module.exports = router;
