const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { json, safeJsonParse, parsePaging } = require('../utils/format');
const router = express.Router();
router.use(requireAuth);

router.get('/', (req, res) => {
  const { limit, offset } = parsePaging(req, 100);
  const rows = db.prepare('SELECT * FROM saved_items_v2 WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?').all(req.userId, limit, offset);
  res.json({ items: rows.map((r) => ({ ...r, source: safeJsonParse(r.source_json, null) })) });
});

router.post('/', (req, res) => {
  const type = String(req.body?.type || req.body?.itemType || 'note').trim();
  const allowed = ['message','note','link','file','photo','video','voice','audio','sticker','story'];
  if (!allowed.includes(type)) return res.status(400).json({ error: 'Неверный тип избранного' });
  const info = db.prepare(`INSERT INTO saved_items_v2 (user_id, item_type, title, text, file_url, mime_type, source_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(req.userId, type, req.body?.title || null, req.body?.text || null, req.body?.fileUrl || null, req.body?.mimeType || null, json(req.body?.source || {}));
  const row = db.prepare('SELECT * FROM saved_items_v2 WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ item: { ...row, source: safeJsonParse(row.source_json, null) } });
});

router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM saved_items_v2 WHERE id = ? AND user_id = ?').run(Number(req.params.id), req.userId);
  res.json({ ok: true });
});

module.exports = router;
