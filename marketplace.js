const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const router = express.Router();
router.use(requireAuth);

router.get('/', (req, res) => {
  const devices = db.prepare('SELECT * FROM user_sessions WHERE user_id = ? ORDER BY last_active DESC').all(req.userId);
  res.json({ devices });
});

router.delete('/:deviceId', (req, res) => {
  const device = db.prepare('SELECT * FROM user_sessions WHERE id = ? AND user_id = ?').get(Number(req.params.deviceId), req.userId);
  if (!device) return res.status(404).json({ error: 'Устройство не найдено' });
  if (device.is_current) return res.status(400).json({ error: 'Нельзя завершить текущую сессию' });
  db.prepare('DELETE FROM user_sessions WHERE id = ?').run(Number(req.params.deviceId));
  res.json({ ok: true });
});

router.post('/terminate-others', (req, res) => {
  db.prepare('DELETE FROM user_sessions WHERE user_id = ? AND is_current = 0').run(req.userId);
  res.json({ ok: true });
});

module.exports = router;