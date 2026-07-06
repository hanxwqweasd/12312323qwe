// src/routes/channels.js
const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

/** Список ВСЕХ каналов — открытый просмотр/поиск, как публичные каналы Telegram. */
router.get('/', (req, res) => {
  const channels = db
    .prepare(
      `SELECT c.*, u.username as owner_username, u.nickname as owner_nickname,
              (SELECT COUNT(*) FROM channel_subscriptions WHERE channel_id = c.id) as subscriber_count,
              EXISTS(SELECT 1 FROM channel_subscriptions WHERE channel_id = c.id AND user_id = ?) as is_subscribed
       FROM channels c
       JOIN users u ON u.id = c.owner_id
       ORDER BY c.created_at DESC`
    )
    .all(req.userId);

  res.json({
    channels: channels.map((c) => ({
      id: c.id,
      name: c.name,
      description: c.description,
      owner: { username: c.owner_username, nickname: c.owner_nickname },
      isOwner: c.owner_id === req.userId,
      subscriberCount: c.subscriber_count,
      isSubscribed: Boolean(c.is_subscribed),
      createdAt: c.created_at,
    })),
  });
});

/** Создание канала — создатель автоматически становится подписчиком/владельцем. */
router.post('/', (req, res) => {
  const { name, description } = req.body || {};
  if (!name || !name.trim() || name.trim().length > 60) {
    return res.status(400).json({ error: 'Название канала: 1-60 символов' });
  }

  const info = db
    .prepare('INSERT INTO channels (name, description, owner_id) VALUES (?, ?, ?)')
    .run(name.trim(), description?.trim() || null, req.userId);

  db.prepare('INSERT INTO channel_subscriptions (channel_id, user_id) VALUES (?, ?)').run(
    info.lastInsertRowid,
    req.userId
  );

  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({
    channel: {
      id: channel.id,
      name: channel.name,
      description: channel.description,
      isOwner: true,
      isSubscribed: true,
      subscriberCount: 1,
      createdAt: channel.created_at,
    },
  });
});

router.post('/:id/subscribe', (req, res) => {
  const channelId = Number(req.params.id);
  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
  if (!channel) return res.status(404).json({ error: 'Канал не найден' });

  db.prepare(
    'INSERT OR IGNORE INTO channel_subscriptions (channel_id, user_id) VALUES (?, ?)'
  ).run(channelId, req.userId);

  res.json({ ok: true });
});

router.delete('/:id/subscribe', (req, res) => {
  const channelId = Number(req.params.id);
  db.prepare('DELETE FROM channel_subscriptions WHERE channel_id = ? AND user_id = ?').run(
    channelId,
    req.userId
  );
  res.json({ ok: true });
});

/** История сообщений канала — читать может любой (публичное вещание), постить — только владелец (проверка в sockets/index.js). */
router.get('/:id/messages', (req, res) => {
  const channelId = Number(req.params.id);
  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
  if (!channel) return res.status(404).json({ error: 'Канал не найден' });

  const messages = db
    .prepare(
      `SELECT m.*, u.username as sender_username, u.nickname as sender_nickname
       FROM channel_messages m
       JOIN users u ON u.id = m.sender_id
       WHERE m.channel_id = ?
       ORDER BY m.created_at ASC, m.id ASC`
    )
    .all(channelId);

  res.json({
    channel: {
      id: channel.id,
      name: channel.name,
      description: channel.description,
      isOwner: channel.owner_id === req.userId,
    },
    messages: messages.map((m) => ({
      id: m.id,
      text: m.text,
      senderUsername: m.sender_username,
      senderNickname: m.sender_nickname,
      createdAt: m.created_at,
    })),
  });
});

module.exports = router;
