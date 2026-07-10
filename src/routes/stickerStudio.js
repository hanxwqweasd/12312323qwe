const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { json, safeJsonParse } = require('../utils/format');

const router = express.Router();
router.use(requireAuth);

router.get('/packs', (req, res) => {
  const rows = db.prepare('SELECT * FROM sticker_packs WHERE creator_id = ? ORDER BY created_at DESC').all(req.userId);
  const packs = rows.map((p) => ({ ...p, items: db.prepare('SELECT * FROM sticker_pack_items WHERE pack_id = ? ORDER BY sticker_index ASC').all(p.id) }));
  res.json({ packs });
});

router.post('/packs', (req, res) => {
  const { name, isAnimated = true } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Название пака обязательно' });
  const info = db.prepare('INSERT INTO sticker_packs (creator_id, name, is_animated) VALUES (?, ?, ?)').run(req.userId, name, isAnimated ? 1 : 0);
  res.status(201).json({ pack: db.prepare('SELECT * FROM sticker_packs WHERE id = ?').get(info.lastInsertRowid) });
});

router.post('/packs/:id/items', (req, res) => {
  const pack = db.prepare('SELECT * FROM sticker_packs WHERE id = ? AND creator_id = ?').get(Number(req.params.id), req.userId);
  if (!pack) return res.status(404).json({ error: 'Пак не найден' });
  const { emoji = '✨', name, lottieUrl, videoUrl, assetUrl } = req.body || {};
  const count = db.prepare('SELECT COUNT(*) as c FROM sticker_pack_items WHERE pack_id = ?').get(pack.id).c;
  const info = db.prepare('INSERT INTO sticker_pack_items (pack_id, sticker_index, emoji, name, lottie_url) VALUES (?, ?, ?, ?, ?)').run(pack.id, count, emoji, name || null, lottieUrl || videoUrl || assetUrl || null);
  res.status(201).json({ item: db.prepare('SELECT * FROM sticker_pack_items WHERE id = ?').get(info.lastInsertRowid) });
});

router.post('/packs/:id/publish', (req, res) => {
  const pack = db.prepare('SELECT * FROM sticker_packs WHERE id = ? AND creator_id = ?').get(Number(req.params.id), req.userId);
  if (!pack) return res.status(404).json({ error: 'Пак не найден' });
  db.prepare(`INSERT OR REPLACE INTO user_saved_items (user_id, item_type, item_id, payload_json)
    VALUES (?, 'published_sticker_pack', ?, ?)`).run(req.userId, String(pack.id), json({ publishedAt: new Date().toISOString(), moderation: 'pending' }));
  res.json({ ok: true, status: 'published_pending_moderation' });
});

router.get('/marketplace', (req, res) => {
  const rows = db.prepare(`SELECT p.*, u.username, u.nickname FROM sticker_packs p JOIN users u ON u.id = p.creator_id ORDER BY p.created_at DESC LIMIT 100`).all();
  res.json({ packs: rows });
});

router.post('/favorites/:itemId', (req, res) => {
  db.prepare(`INSERT OR IGNORE INTO user_saved_items (user_id, item_type, item_id, payload_json) VALUES (?, 'favorite_sticker', ?, '{}')`).run(req.userId, String(req.params.itemId));
  res.json({ ok: true });
});

router.post('/recent/:itemId', (req, res) => {
  db.prepare(`INSERT OR REPLACE INTO user_saved_items (user_id, item_type, item_id, payload_json) VALUES (?, 'recent_sticker', ?, ?)`).run(req.userId, String(req.params.itemId), json({ usedAt: new Date().toISOString() }));
  res.json({ ok: true });
});

router.get('/premium-emoji/sync', (req, res) => {
  const rows = db.prepare(`SELECT * FROM premium_emoji_purchases WHERE user_id = ? ORDER BY purchased_at DESC`).all(req.userId);
  res.json({ premiumEmoji: rows });
});

router.post('/premium-emoji/purchase', (req, res) => {
  const { premiumEmojiId } = req.body || {};
  if (!premiumEmojiId) return res.status(400).json({ error: 'premiumEmojiId обязателен' });
  db.prepare('INSERT OR IGNORE INTO premium_emoji_purchases (user_id, premium_emoji_id) VALUES (?, ?)').run(req.userId, premiumEmojiId);
  res.json({ ok: true });
});

module.exports = router;
