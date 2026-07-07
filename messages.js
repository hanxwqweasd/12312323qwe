const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const router = express.Router();
router.use(requireAuth);

// POST / — add reaction { messageId, emoji, isPremium }
router.post('/', (req, res) => {
  const { messageId, emoji, isPremium = 0 } = req.body || {};
  if (!messageId || !emoji) return res.status(400).json({ error: 'messageId и emoji обязательны' });
  const message = db.prepare('SELECT * FROM messages WHERE id = ?').get(Number(messageId));
  if (!message) return res.status(404).json({ error: 'Сообщение не найдено' });
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(message.conversation_id);
  if (!conv || (conv.user_a_id !== req.userId && conv.user_b_id !== req.userId)) {
    return res.status(403).json({ error: 'Нет доступа' });
  }
  db.prepare(`INSERT OR IGNORE INTO message_reactions (message_id, user_id, emoji, is_premium) VALUES (?, ?, ?, ?)`)
    .run(Number(messageId), req.userId, emoji, isPremium ? 1 : 0);
  // Notify via socket if available
  const io = req.app.get('io');
  if (io) {
    const peerId = conv.user_a_id === req.userId ? conv.user_b_id : conv.user_a_id;
    io.to(`user:${peerId}`).emit('reaction:new', { messageId: Number(messageId), userId: req.userId, emoji, isPremium: Boolean(isPremium) });
    io.to(`user:${req.userId}`).emit('reaction:new', { messageId: Number(messageId), userId: req.userId, emoji, isPremium: Boolean(isPremium) });
  }
  const reactions = db.prepare('SELECT emoji, COUNT(*) as count FROM message_reactions WHERE message_id = ? GROUP BY emoji').all(Number(messageId));
  res.json({ ok: true, reactions });
});

// DELETE /:messageId — remove own reaction
router.delete('/:messageId', (req, res) => {
  const messageId = Number(req.params.messageId);
  db.prepare('DELETE FROM message_reactions WHERE message_id = ? AND user_id = ?').run(messageId, req.userId);
  const message = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
  const io = req.app.get('io');
  if (io && message) {
    const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(message.conversation_id);
    if (conv) {
      const peerId = conv.user_a_id === req.userId ? conv.user_b_id : conv.user_a_id;
      io.to(`user:${peerId}`).emit('reaction:removed', { messageId, userId: req.userId });
      io.to(`user:${req.userId}`).emit('reaction:removed', { messageId, userId: req.userId });
    }
  }
  const reactions = db.prepare('SELECT emoji, COUNT(*) as count FROM message_reactions WHERE message_id = ? GROUP BY emoji').all(messageId);
  res.json({ ok: true, reactions });
});

// GET /:messageId — get reactions
router.get('/:messageId', (req, res) => {
  const reactions = db.prepare('SELECT emoji, COUNT(*) as count, GROUP_CONCAT(user_id) as user_ids FROM message_reactions WHERE message_id = ? GROUP BY emoji').all(Number(req.params.messageId));
  res.json({ reactions: reactions.map(r => ({ emoji: r.emoji, count: r.count, userIds: (r.user_ids||'').split(',').map(Number) })) });
});

module.exports = router;