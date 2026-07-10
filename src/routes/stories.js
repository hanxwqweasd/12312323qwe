const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const router = express.Router();
router.use(requireAuth);

router.post('/', (req, res) => {
  const { mediaUrl, caption, privacy = 'contacts', expiresInHours = 24, authorType = 'user', authorId } = req.body || {};
  if (!mediaUrl) return res.status(400).json({ error: 'mediaUrl обязателен' });
  const realAuthorId = authorType === 'channel' ? Number(authorId) : req.userId;
  if (authorType === 'channel') {
    const ch = db.prepare('SELECT * FROM channels WHERE id = ? AND owner_id = ?').get(realAuthorId, req.userId);
    if (!ch) return res.status(403).json({ error: 'Нет права публиковать сторис от канала' });
  }
  const expiresAt = new Date(Date.now() + Number(expiresInHours || 24) * 3600000).toISOString();
  const info = db.prepare('INSERT INTO stories (author_type, author_id, media_url, caption, privacy, expires_at) VALUES (?, ?, ?, ?, ?, ?)').run(authorType, realAuthorId, mediaUrl, caption || null, privacy, expiresAt);
  res.status(201).json({ story: db.prepare('SELECT * FROM stories WHERE id = ?').get(info.lastInsertRowid) });
});

router.get('/', (req, res) => {
  const rows = db.prepare(`SELECT * FROM stories WHERE expires_at > datetime('now') ORDER BY created_at DESC LIMIT 100`).all();
  res.json({ stories: rows });
});

router.post('/:id/view', (req, res) => {
  const story = db.prepare('SELECT * FROM stories WHERE id = ?').get(Number(req.params.id));
  if (!story) return res.status(404).json({ error: 'Сторис не найдена' });
  db.prepare('INSERT OR IGNORE INTO story_views (story_id, user_id) VALUES (?, ?)').run(story.id, req.userId);
  const views = db.prepare('SELECT COUNT(*) as c FROM story_views WHERE story_id = ?').get(story.id).c;
  res.json({ ok: true, views });
});

router.post('/:id/reactions', (req, res) => {
  const { emoji } = req.body || {};
  if (!emoji) return res.status(400).json({ error: 'emoji обязателен' });
  const story = db.prepare('SELECT * FROM stories WHERE id = ?').get(Number(req.params.id));
  if (!story) return res.status(404).json({ error: 'Сторис не найдена' });
  db.prepare('INSERT OR IGNORE INTO story_reactions (story_id, user_id, emoji) VALUES (?, ?, ?)').run(story.id, req.userId, emoji);
  res.json({ ok: true });
});

router.get('/:id/views', (req, res) => {
  const story = db.prepare('SELECT * FROM stories WHERE id = ?').get(Number(req.params.id));
  if (!story) return res.status(404).json({ error: 'Сторис не найдена' });
  if (story.author_type === 'user' && story.author_id !== req.userId) return res.status(403).json({ error: 'Нет доступа' });
  const rows = db.prepare('SELECT v.*, u.username, u.nickname FROM story_views v JOIN users u ON u.id = v.user_id WHERE v.story_id = ? ORDER BY v.viewed_at DESC').all(story.id);
  res.json({ views: rows });
});

module.exports = router;
