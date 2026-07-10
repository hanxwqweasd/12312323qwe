const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { json, safeJsonParse } = require('../utils/format');
const router = express.Router();
router.use(requireAuth);

router.get('/state', (req, res) => {
  const counts = {
    conversations: db.prepare('SELECT COUNT(*) as c FROM conversations WHERE user_a_id = ? OR user_b_id = ?').get(req.userId, req.userId).c,
    channels: db.prepare('SELECT COUNT(*) as c FROM channel_subscriptions WHERE user_id = ?').get(req.userId).c,
    groups: db.prepare('SELECT COUNT(*) as c FROM group_members WHERE user_id = ?').get(req.userId).c,
    bots: db.prepare('SELECT COUNT(*) as c FROM bots WHERE owner_id = ?').get(req.userId).c,
    saved: db.prepare('SELECT COUNT(*) as c FROM user_saved_items WHERE user_id = ?').get(req.userId).c,
  };
  const settingsUpdatedAt = db.prepare('SELECT MAX(updated_at) as t FROM user_cloud_settings WHERE user_id = ?').get(req.userId).t;
  res.json({ serverTime: new Date().toISOString(), counts, settingsUpdatedAt });
});

router.get('/settings', (req, res) => {
  const rows = db.prepare('SELECT key, value_json, updated_at FROM user_cloud_settings WHERE user_id = ?').all(req.userId);
  res.json({ settings: Object.fromEntries(rows.map((r) => [r.key, { value: safeJsonParse(r.value_json, null), updatedAt: r.updated_at }])) });
});

router.put('/settings/:key', (req, res) => {
  db.prepare(`INSERT INTO user_cloud_settings (user_id, key, value_json, updated_at) VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(user_id, key) DO UPDATE SET value_json = excluded.value_json, updated_at = datetime('now')`).run(req.userId, req.params.key, json(req.body?.value ?? req.body ?? null));
  res.json({ ok: true });
});

router.get('/full', (req, res) => {
  const channels = db.prepare(`SELECT c.* FROM channels c JOIN channel_subscriptions s ON s.channel_id = c.id WHERE s.user_id = ? AND c.is_deleted = 0`).all(req.userId);
  const groups = db.prepare(`SELECT g.* FROM groups g JOIN group_members m ON m.group_id = g.id WHERE m.user_id = ?`).all(req.userId);
  const bots = db.prepare('SELECT id, username, name, description, token_preview, created_at FROM bots WHERE owner_id = ?').all(req.userId);
  const settings = db.prepare('SELECT key, value_json FROM user_cloud_settings WHERE user_id = ?').all(req.userId);
  res.json({ channels, groups, bots, settings: Object.fromEntries(settings.map((s) => [s.key, safeJsonParse(s.value_json, null)])) });
});

module.exports = router;
