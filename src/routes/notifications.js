const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const router = express.Router();
router.use(requireAuth);

router.post('/push-token', (req, res) => {
  const { token, platform, deviceName } = req.body || {};
  if (!token) return res.status(400).json({ error: 'push token обязателен' });
  db.prepare(`INSERT INTO push_tokens (user_id, token, platform, device_name) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, token) DO UPDATE SET last_seen = datetime('now'), platform = excluded.platform, device_name = excluded.device_name`)
    .run(req.userId, token, platform || null, deviceName || null);
  res.json({ ok: true });
});

router.delete('/push-token', (req, res) => {
  db.prepare('DELETE FROM push_tokens WHERE user_id = ? AND token = ?').run(req.userId, req.body?.token || '');
  res.json({ ok: true });
});

router.get('/settings', (req, res) => {
  const rows = db.prepare('SELECT * FROM notification_settings WHERE user_id = ?').all(req.userId);
  res.json({ settings: rows });
});

router.put('/settings/:scopeType/:scopeId', (req, res) => {
  const { mutedUntil, sound = 'default', showPreview = true, mentionsOnly = false } = req.body || {};
  db.prepare(`INSERT INTO notification_settings (user_id, scope_type, scope_id, muted_until, sound, show_preview, mentions_only, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(user_id, scope_type, scope_id) DO UPDATE SET muted_until = excluded.muted_until, sound = excluded.sound, show_preview = excluded.show_preview, mentions_only = excluded.mentions_only, updated_at = datetime('now')`)
    .run(req.userId, req.params.scopeType, req.params.scopeId, mutedUntil || null, sound, showPreview ? 1 : 0, mentionsOnly ? 1 : 0);
  res.json({ ok: true });
});

module.exports = router;
