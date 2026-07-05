// src/sockets/index.js
//
// Реальный канал доставки сообщений между людьми. Сервер работает как
// "слепой" релей + персистентное хранилище шифротекста: он никогда не
// видит plaintext (см. схему E2E в db.js и клиентском utils/e2e.js).
//
// Модель комнат: каждый подключённый пользователь состоит в комнате
// `user:<id>`. Отправка сообщения — это (1) запись в БД, (2) emit в
// комнату получателя, если он сейчас онлайн. Если получатель офлайн,
// сообщение всё равно сохранено и будет получено через REST
// GET /messages/with/:username при следующем открытии чата.

const jwt = require('jsonwebtoken');
const db = require('../db');
const { JWT_SECRET } = require('../middleware/auth');
const { getOrCreateConversation, otherParticipantId } = require('../conversations');

function roomFor(userId) {
  return `user:${userId}`;
}

function attachSockets(io) {
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('Нет токена авторизации'));
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      socket.userId = payload.sub;
      socket.username = payload.username;
      next();
    } catch (e) {
      next(new Error('Невалидный токен'));
    }
  });

  io.on('connection', (socket) => {
    socket.join(roomFor(socket.userId));

    // Оповещаем собеседников из существующих разговоров, что пользователь онлайн.
    broadcastPresence(io, socket.userId, true);

    socket.on('message:send', (payload, ack) => {
      try {
        const { toUsername, ciphertext, nonce, messageType = 'text', selfDestructSeconds = null } = payload || {};

        const peer = db.prepare('SELECT * FROM users WHERE username = ?').get(toUsername);
        if (!peer) return ack?.({ ok: false, error: 'Получатель не найден' });
        if (!ciphertext || !nonce) return ack?.({ ok: false, error: 'Сообщение не зашифровано' });

        const conversation = getOrCreateConversation(socket.userId, peer.id);

        const info = db
          .prepare(
            `INSERT INTO messages
               (conversation_id, sender_id, ciphertext, nonce, message_type, self_destruct_seconds)
             VALUES (?, ?, ?, ?, ?, ?)`
          )
          .run(conversation.id, socket.userId, ciphertext, nonce, messageType, selfDestructSeconds);

        const saved = db.prepare('SELECT * FROM messages WHERE id = ?').get(info.lastInsertRowid);

        const wire = {
          id: saved.id,
          conversationId: conversation.id,
          senderId: saved.sender_id,
          senderUsername: socket.username,
          ciphertext: saved.ciphertext,
          nonce: saved.nonce,
          messageType: saved.message_type,
          selfDestructSeconds: saved.self_destruct_seconds,
          createdAt: saved.created_at,
        };

        // Доставляем получателю, если он сейчас онлайн.
        io.to(roomFor(peer.id)).emit('message:new', wire);

        // Отмечаем "доставлено", если хоть один сокет получателя в комнате.
        const recipientRoom = io.sockets.adapter.rooms.get(roomFor(peer.id));
        if (recipientRoom && recipientRoom.size > 0) {
          db.prepare('UPDATE messages SET delivered_at = datetime(\'now\') WHERE id = ?').run(saved.id);
        }

        ack?.({ ok: true, message: wire });
      } catch (e) {
        ack?.({ ok: false, error: 'Внутренняя ошибка сервера' });
      }
    });

    socket.on('message:read', ({ conversationId, messageId }) => {
      const message = db.prepare('SELECT * FROM messages WHERE id = ? AND conversation_id = ?').get(messageId, conversationId);
      if (!message) return;

      db.prepare('UPDATE messages SET read_at = datetime(\'now\') WHERE id = ?').run(messageId);

      const conversation = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId);
      const senderRoom = roomFor(message.sender_id);
      io.to(senderRoom).emit('message:read', { conversationId, messageId });
    });

    /**
     * Настоящее удаление сообщения с сервера (не только локальная отметка
     * "сгорело" на устройстве получателя) — это то, что делает
     * самоуничтожение реальным, а не косметическим на одном экране.
     */
    socket.on('message:burn', ({ conversationId, messageId }) => {
      const message = db.prepare('SELECT * FROM messages WHERE id = ? AND conversation_id = ?').get(messageId, conversationId);
      if (!message) return;

      const conversation = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId);
      if (!conversation) return;

      const isParticipant = conversation.user_a_id === socket.userId || conversation.user_b_id === socket.userId;
      if (!isParticipant) return;

      db.prepare('DELETE FROM messages WHERE id = ?').run(messageId);

      const peerId = otherParticipantId(conversation, socket.userId);
      io.to(roomFor(socket.userId)).emit('message:burned', { conversationId, messageId });
      io.to(roomFor(peerId)).emit('message:burned', { conversationId, messageId });
    });

    socket.on('disconnect', () => {
      broadcastPresence(io, socket.userId, false);
    });
  });
}

function broadcastPresence(io, userId, isOnline) {
  const conversations = db
    .prepare('SELECT * FROM conversations WHERE user_a_id = ? OR user_b_id = ?')
    .all(userId, userId);

  conversations.forEach((c) => {
    const peerId = otherParticipantId(c, userId);
    io.to(roomFor(peerId)).emit('presence:update', { userId, isOnline });
  });
}

module.exports = { attachSockets };
