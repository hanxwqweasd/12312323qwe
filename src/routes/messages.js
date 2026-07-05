// src/routes/messages.js
const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { getOrCreateConversation, otherParticipantId } = require('../conversations');

const router = express.Router();
router.use(requireAuth);

/** Список разговоров текущего пользователя с последним сообщением для превью. */
router.get('/conversations', (req, res) => {
  const rows = db
    .prepare(
      `SELECT c.id as conversation_id, c.user_a_id, c.user_b_id
       FROM conversations c
       WHERE c.user_a_id = ? OR c.user_b_id = ?`
    )
    .all(req.userId, req.userId);

  const conversations = rows.map((row) => {
    const peerId = otherParticipantId(row, req.userId);
    const peer = db.prepare('SELECT id, username, nickname, box_public_key FROM users WHERE id = ?').get(peerId);
    const lastMessage = db
      .prepare(
        `SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`
      )
      .get(row.conversation_id);
    const unreadCount = db
      .prepare(
        `SELECT COUNT(*) as cnt FROM messages
         WHERE conversation_id = ? AND sender_id != ? AND read_at IS NULL`
      )
      .get(row.conversation_id, req.userId).cnt;

    return {
      conversationId: row.conversation_id,
      peer: {
        id: peer.id,
        username: peer.username,
        nickname: peer.nickname,
        boxPublicKey: peer.box_public_key,
      },
      lastMessage: lastMessage
        ? {
            id: lastMessage.id,
            ciphertext: lastMessage.ciphertext,
            nonce: lastMessage.nonce,
            messageType: lastMessage.message_type,
            senderId: lastMessage.sender_id,
            createdAt: lastMessage.created_at,
          }
        : null,
      unreadCount,
    };
  });

  res.json({ conversations });
});

/** Полная история сообщений с конкретным пользователем (по username). */
router.get('/with/:username', (req, res) => {
  const peer = db.prepare('SELECT * FROM users WHERE username = ?').get(req.params.username);
  if (!peer) return res.status(404).json({ error: 'Пользователь не найден' });

  const conversation = getOrCreateConversation(req.userId, peer.id);

  const messages = db
    .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, id ASC')
    .all(conversation.id);

  res.json({
    conversationId: conversation.id,
    peer: { id: peer.id, username: peer.username, nickname: peer.nickname, boxPublicKey: peer.box_public_key },
    messages: messages.map((m) => ({
      id: m.id,
      senderId: m.sender_id,
      ciphertext: m.ciphertext,
      nonce: m.nonce,
      messageType: m.message_type,
      selfDestructSeconds: m.self_destruct_seconds,
      deliveredAt: m.delivered_at,
      readAt: m.read_at,
      createdAt: m.created_at,
    })),
  });
});

module.exports = router;
