// src/routes/messages.js
const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { getOrCreateConversation, otherParticipantId } = require('../conversations');

const router = express.Router();
router.use(requireAuth);

const MEDIA_DIR = path.join(__dirname, '..', '..', 'data', 'media');
fs.mkdirSync(MEDIA_DIR, { recursive: true });

const mediaUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, MEDIA_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || '';
      cb(null, `${req.userId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
    },
  }),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 МБ — фото/короткое видео/кружок
});

/**
 * Загрузка вложения (фото/видео/видео-кружок) для чата.
 *
 * ЧЕСТНО ПРО ШИФРОВАНИЕ: в отличие от текста сообщений (см. utils/e2e.js на
 * клиенте — там настоящий E2E через nacl.box), сами файлы вложений здесь
 * хранятся на сервере НЕ зашифрованными. Полное сквозное шифрование бинарных
 * файлов потребовало бы шифровать/дешифровать поток байт на клиенте перед
 * загрузкой и после скачивания — сейчас это не сделано, и не хочу называть
 * эту часть E2E, если это не так. URL файла условно-приватный
 * (непредсказуемое имя), но не защищён токеном доступа — для продакшена
 * стоит добавить подписанные ссылки с истечением срока действия.
 */
router.post('/upload', (req, res) => {
  mediaUpload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'Файл не получен' });

    const attachmentType = req.file.mimetype.startsWith('video/') ? 'video' : 'photo';
    res.json({
      attachmentPath: req.file.filename,
      attachmentType,
      url: `/media/${req.file.filename}`,
    });
  });
});

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
