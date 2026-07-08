const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const router = express.Router();
router.use(requireAuth);

// GET / — get business settings + quick replies
router.get('/', (req, res) => {
  const settings = db.prepare('SELECT * FROM business_settings WHERE user_id = ?').get(req.userId);
  const quickReplies = db.prepare('SELECT * FROM quick_replies WHERE user_id = ? ORDER BY created_at ASC').all(req.userId);
  res.json({ settings: settings || {}, quickReplies });
});

// PATCH / — upsert business settings
router.patch('/', (req, res) => {
  const fields = ['working_hours_enabled','working_hours_from','working_hours_to','working_hours_timezone','working_hours_weekdays','auto_reply_enabled','auto_reply_message','auto_reply_delay_seconds','auto_reply_once','business_name','business_category','business_description','business_email','business_website','business_phone'];
  const existing = db.prepare('SELECT user_id FROM business_settings WHERE user_id = ?').get(req.userId);
  if (existing) {
    const sets = [];
    const vals = [];
    for (const f of fields) {
      if (req.body[f] !== undefined) { sets.push(`${f} = ?`); vals.push(req.body[f]); }
    }
    if (sets.length > 0) { vals.push(req.userId); db.prepare(`UPDATE business_settings SET ${sets.join(', ')} WHERE user_id = ?`).run(...vals); }
  } else {
    db.prepare(`INSERT INTO business_settings (user_id, ${fields.join(', ')}) VALUES (?, ${fields.map(()=>'?').join(', ')})`).run(req.userId, ...fields.map(f => req.body[f] ?? null));
  }
  const updated = db.prepare('SELECT * FROM business_settings WHERE user_id = ?').get(req.userId);
  res.json({ ok: true, settings: updated });
});

// POST /quick-replies — add
router.post('/quick-replies', (req, res) => {
  const { shortcut, message } = req.body || {};
  if (!shortcut || !message) return res.status(400).json({ error: 'shortcut и message обязательны' });
  const info = db.prepare('INSERT INTO quick_replies (user_id, shortcut, message) VALUES (?, ?, ?)').run(req.userId, shortcut, message);
  const qr = db.prepare('SELECT * FROM quick_replies WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ ok: true, quickReply: qr });
});

// DELETE /quick-replies/:id
router.delete('/quick-replies/:id', (req, res) => {
  const qr = db.prepare('SELECT * FROM quick_replies WHERE id = ? AND user_id = ?').get(Number(req.params.id), req.userId);
  if (!qr) return res.status(404).json({ error: 'Быстрый ответ не найден' });
  db.prepare('DELETE FROM quick_replies WHERE id = ?').get(Number(req.params.id));
  res.json({ ok: true });
});

module.exports = router;