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
const { canPostToChannel, isGroupMember, isGroupMuted, isGroupBanned } = require('../utils/permissions');
const { json } = require('../utils/format');

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

    socket.on('reaction:add', ({ conversationId, messageId, emoji, isPremium }, ack) => {
      try {
        const message = db.prepare('SELECT * FROM messages WHERE id = ? AND conversation_id = ?').get(Number(messageId), Number(conversationId));
        if (!message) return ack?.({ ok: false, error: 'Сообщение не найдено' });
        const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(Number(conversationId));
        if (!conv || (conv.user_a_id !== socket.userId && conv.user_b_id !== socket.userId)) {
          return ack?.({ ok: false, error: 'Нет доступа' });
        }
        db.prepare(`INSERT OR IGNORE INTO message_reactions (message_id, user_id, emoji, is_premium) VALUES (?, ?, ?, ?)`)
          .run(Number(messageId), socket.userId, emoji, isPremium ? 1 : 0);
        const peerId = otherParticipantId(conv, socket.userId);
        const wire = { messageId: Number(messageId), userId: socket.userId, username: socket.username, emoji, isPremium: Boolean(isPremium) };
        io.to(roomFor(peerId)).emit('reaction:new', wire);
        io.to(roomFor(socket.userId)).emit('reaction:new', wire);
        const reactions = db.prepare('SELECT emoji, COUNT(*) as count FROM message_reactions WHERE message_id = ? GROUP BY emoji').all(Number(messageId));
        ack?.({ ok: true, reactions });
      } catch (e) { ack?.({ ok: false, error: 'Ошибка' }); }
    });

    socket.on('reaction:remove', ({ conversationId, messageId }, ack) => {
      try {
        db.prepare('DELETE FROM message_reactions WHERE message_id = ? AND user_id = ?').run(Number(messageId), socket.userId);
        const message = db.prepare('SELECT * FROM messages WHERE id = ?').get(Number(messageId));
        if (message) {
          const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(message.conversation_id);
          if (conv) {
            const peerId = otherParticipantId(conv, socket.userId);
            io.to(roomFor(peerId)).emit('reaction:removed', { messageId: Number(messageId), userId: socket.userId });
            io.to(roomFor(socket.userId)).emit('reaction:removed', { messageId: Number(messageId), userId: socket.userId });
          }
        }
        ack?.({ ok: true });
      } catch (e) { ack?.({ ok: false, error: 'Ошибка' }); }
    });

    socket.on('disconnect', () => {
      broadcastPresence(io, socket.userId, false);
    });

    // --- Каналы: подключение к комнате канала + вещание сообщений ---

    socket.on('channel:join', ({ channelId }) => {
      socket.join(`channel:${channelId}`);
    });

    socket.on('channel:leave', ({ channelId }) => {
      socket.leave(`channel:${channelId}`);
    });

    socket.on('channel:message:send', ({ channelId, text, media = [], entities = [], silent = false, protectedContent = false, scheduledAt = null }, ack) => {
      try {
        const channel = db.prepare('SELECT * FROM channels WHERE id = ? AND is_deleted = 0').get(Number(channelId));
        if (!channel) return ack?.({ ok: false, error: 'Канал не найден' });
        if (!canPostToChannel(Number(channelId), socket.userId)) return ack?.({ ok: false, error: 'Нет права публиковать' });
        if ((!text || !String(text).trim()) && (!Array.isArray(media) || media.length === 0)) return ack?.({ ok: false, error: 'Пустое сообщение' });
        const isScheduled = Boolean(scheduledAt);
        const info = db.prepare(`INSERT INTO channel_messages (channel_id, sender_id, text, media_json, entities_json, silent, protected_content, scheduled_at, published_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(Number(channelId), socket.userId, String(text || '').trim(), json(media), json(entities), silent ? 1 : 0, protectedContent || channel.protected_content ? 1 : 0, scheduledAt || null, isScheduled ? null : new Date().toISOString());
        const wire = { id: info.lastInsertRowid, channelId: Number(channelId), text: String(text || '').trim(), media, entities, silent: Boolean(silent), senderUsername: socket.username, createdAt: new Date().toISOString(), scheduledAt };
        if (!isScheduled) io.to(`channel:${channelId}`).emit('channel:message:new', wire);
        ack?.({ ok: true, message: wire });
      } catch (e) {
        ack?.({ ok: false, error: 'Внутренняя ошибка сервера' });
      }
    });

    socket.on('group:join', ({ groupId }) => {
      if (isGroupMember(Number(groupId), socket.userId)) socket.join(`group:${groupId}`);
    });

    socket.on('group:leave', ({ groupId }) => socket.leave(`group:${groupId}`));

    socket.on('group:message:send', ({ groupId, text, topicId = null, replyToMessageId = null, media = [], entities = [] }, ack) => {
      try {
        groupId = Number(groupId);
        if (!isGroupMember(groupId, socket.userId)) return ack?.({ ok: false, error: 'Нет доступа к группе' });
        if (isGroupBanned(groupId, socket.userId)) return ack?.({ ok: false, error: 'Вы заблокированы в группе' });
        if (isGroupMuted(groupId, socket.userId)) return ack?.({ ok: false, error: 'Вы временно не можете писать' });
        const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(groupId);
        if (group?.slow_mode_seconds) {
          const last = db.prepare('SELECT created_at FROM group_messages WHERE group_id = ? AND sender_id = ? ORDER BY created_at DESC LIMIT 1').get(groupId, socket.userId);
          if (last && Date.now() - new Date(last.created_at).getTime() < Number(group.slow_mode_seconds) * 1000) {
            return ack?.({ ok: false, error: `Медленный режим: ${group.slow_mode_seconds} сек.` });
          }
        }
        if ((!text || !String(text).trim()) && (!Array.isArray(media) || !media.length)) return ack?.({ ok: false, error: 'Пустое сообщение' });
        const info = db.prepare('INSERT INTO group_messages (group_id, sender_id, text, topic_id, reply_to_message_id, media_json, entities_json) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(groupId, socket.userId, String(text || '').trim(), topicId, replyToMessageId, json(media), json(entities));
        const wire = { id: info.lastInsertRowid, groupId, senderId: socket.userId, senderUsername: socket.username, text: String(text || '').trim(), topicId, replyToMessageId, media, entities, createdAt: new Date().toISOString() };
        io.to(`group:${groupId}`).emit('group:message:new', wire);
        ack?.({ ok: true, message: wire });
      } catch (e) { ack?.({ ok: false, error: 'Внутренняя ошибка сервера' }); }
    });

    // WebRTC call signaling relay for 1:1 calls. Media goes peer-to-peer; server relays only SDP/ICE.
    socket.on('call:invite', ({ toUsername, callId, type, offer }, ack) => {
      const peer = db.prepare('SELECT id, username FROM users WHERE username = ?').get(toUsername);
      if (!peer) return ack?.({ ok: false, error: 'Пользователь не найден' });
      io.to(roomFor(peer.id)).emit('call:incoming', { callId, fromUserId: socket.userId, fromUsername: socket.username, type, offer });
      ack?.({ ok: true });
    });
    socket.on('call:answer', ({ toUsername, callId, answer }, ack) => {
      const peer = db.prepare('SELECT id FROM users WHERE username = ?').get(toUsername);
      if (peer) io.to(roomFor(peer.id)).emit('call:answer', { callId, fromUsername: socket.username, answer });
      ack?.({ ok: true });
    });
    socket.on('call:ice-candidate', ({ toUsername, callId, candidate }, ack) => {
      const peer = db.prepare('SELECT id FROM users WHERE username = ?').get(toUsername);
      if (peer) io.to(roomFor(peer.id)).emit('call:ice-candidate', { callId, fromUsername: socket.username, candidate });
      ack?.({ ok: true });
    });
    socket.on('call:decline', ({ toUsername, callId }, ack) => {
      const peer = db.prepare('SELECT id FROM users WHERE username = ?').get(toUsername);
      if (peer) io.to(roomFor(peer.id)).emit('call:decline', { callId, fromUsername: socket.username });
      ack?.({ ok: true });
    });
    socket.on('call:end', ({ toUsername, callId }, ack) => {
      const peer = db.prepare('SELECT id FROM users WHERE username = ?').get(toUsername);
      if (peer) io.to(roomFor(peer.id)).emit('call:end', { callId, fromUsername: socket.username });
      ack?.({ ok: true });
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
