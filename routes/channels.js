// src/routes/channels.js
const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { isUsernameAvailable } = require('./auth');

const router = express.Router();
router.use(requireAuth);

// ── Helpers ──

function isChannelOwner(channelId, userId) {
  const ch = db.prepare('SELECT owner_id FROM channels WHERE id = ?').get(channelId);
  return ch && ch.owner_id === userId;
}

function isChannelAdmin(channelId, userId) {
  // Owner is always admin
  if (isChannelOwner(channelId, userId)) return true;
  const admin = db
    .prepare('SELECT 1 FROM channel_admins WHERE channel_id = ? AND user_id = ?')
    .get(channelId, userId);
  return Boolean(admin);
}

// ── GET / — List all channels ──

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
      username: c.username,
      photoUrl: c.photo_url,
      owner: { username: c.owner_username, nickname: c.owner_nickname },
      isOwner: c.owner_id === req.userId,
      subscriberCount: c.subscriber_count,
      isSubscribed: Boolean(c.is_subscribed),
      createdAt: c.created_at,
    })),
  });
});

// ── POST / — Create channel ──

/** Создание канала — создатель автоматически становится подписчиком/владельцем. */
router.post('/', (req, res) => {
  const { name, description, username } = req.body || {};
  if (!name || !name.trim() || name.trim().length > 60) {
    return res.status(400).json({ error: 'Название канала: 1-60 символов' });
  }

  if (username) {
    if (!/^[a-zA-Z0-9_]{4,30}$/.test(username)) {
      return res.status(400).json({ error: 'Username: 4-30 символов, латиница/цифры/"_"' });
    }
    if (!isUsernameAvailable(username, null)) {
      return res.status(409).json({ error: 'Username уже занят' });
    }
  }

  const info = db
    .prepare('INSERT INTO channels (name, description, owner_id, username) VALUES (?, ?, ?, ?)')
    .run(name.trim(), description?.trim() || null, req.userId, username || null);

  db.prepare('INSERT INTO channel_subscriptions (channel_id, user_id) VALUES (?, ?)').run(
    info.lastInsertRowid,
    req.userId
  );

  // Owner is always in channel_admins
  db.prepare('INSERT INTO channel_admins (channel_id, user_id, role) VALUES (?, ?, ?)').run(
    info.lastInsertRowid,
    req.userId,
    'owner'
  );

  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({
    channel: {
      id: channel.id,
      name: channel.name,
      description: channel.description,
      username: channel.username,
      photoUrl: channel.photo_url,
      isOwner: true,
      isSubscribed: true,
      subscriberCount: 1,
      createdAt: channel.created_at,
    },
  });
});

// ── PATCH /:id — Update channel (name, description, photo_url) ──

router.patch('/:id', (req, res) => {
  const channelId = Number(req.params.id);
  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
  if (!channel) return res.status(404).json({ error: 'Канал не найден' });

  if (!isChannelOwner(channelId, req.userId)) {
    return res.status(403).json({ error: 'Только владелец может редактировать канал' });
  }

  const { name, description, photo_url } = req.body || {};

  if (name !== undefined) {
    if (!name.trim() || name.trim().length > 60) {
      return res.status(400).json({ error: 'Название канала: 1-60 символов' });
    }
  }

  db.prepare(
    `UPDATE channels SET name = COALESCE(?, name),
                         description = COALESCE(?, description),
                         photo_url = COALESCE(?, photo_url)
     WHERE id = ?`
  ).run(
    name?.trim() || null,
    description !== undefined ? (description?.trim() || null) : null,
    photo_url || null,
    channelId
  );

  const updated = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
  res.json({
    channel: {
      id: updated.id,
      name: updated.name,
      description: updated.description,
      username: updated.username,
      photoUrl: updated.photo_url,
      isOwner: true,
      createdAt: updated.created_at,
    },
  });
});

// ── DELETE /:id — Delete channel ──

router.delete('/:id', (req, res) => {
  const channelId = Number(req.params.id);
  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
  if (!channel) return res.status(404).json({ error: 'Канал не найден' });

  if (!isChannelOwner(channelId, req.userId)) {
    return res.status(403).json({ error: 'Только владелец может удалить канал' });
  }

  db.prepare('DELETE FROM channel_messages WHERE channel_id = ?').run(channelId);
  db.prepare('DELETE FROM channel_subscriptions WHERE channel_id = ?').run(channelId);
  db.prepare('DELETE FROM channel_admins WHERE channel_id = ?').run(channelId);
  db.prepare('DELETE FROM channel_invites WHERE channel_id = ?').run(channelId);
  db.prepare('DELETE FROM channels WHERE id = ?').run(channelId);

  res.json({ ok: true });
});

// ── POST /:id/subscribe ──

router.post('/:id/subscribe', (req, res) => {
  const channelId = Number(req.params.id);
  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
  if (!channel) return res.status(404).json({ error: 'Канал не найден' });

  db.prepare(
    'INSERT OR IGNORE INTO channel_subscriptions (channel_id, user_id) VALUES (?, ?)'
  ).run(channelId, req.userId);

  res.json({ ok: true });
});

// ── DELETE /:id/subscribe ──

router.delete('/:id/subscribe', (req, res) => {
  const channelId = Number(req.params.id);
  db.prepare('DELETE FROM channel_subscriptions WHERE channel_id = ? AND user_id = ?').run(
    channelId,
    req.userId
  );
  res.json({ ok: true });
});

// ── GET /:id/messages — Channel message history ──

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

// ── POST /:id/admins/:userId — Make user admin ──

router.post('/:id/admins/:userId', (req, res) => {
  const channelId = Number(req.params.id);
  const targetUserId = Number(req.params.userId);

  if (!isChannelOwner(channelId, req.userId)) {
    return res.status(403).json({ error: 'Только владелец может назначать админов' });
  }

  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
  if (!channel) return res.status(404).json({ error: 'Канал не найден' });

  // Verify target is a subscriber
  const sub = db
    .prepare('SELECT 1 FROM channel_subscriptions WHERE channel_id = ? AND user_id = ?')
    .get(channelId, targetUserId);
  if (!sub) return res.status(404).json({ error: 'Пользователь не подписчик канала' });

  db.prepare(
    'INSERT OR IGNORE INTO channel_admins (channel_id, user_id, role) VALUES (?, ?, ?)'
  ).run(channelId, targetUserId, 'admin');

  res.json({ ok: true });
});

// ── DELETE /:id/admins/:userId — Remove admin role ──

router.delete('/:id/admins/:userId', (req, res) => {
  const channelId = Number(req.params.id);
  const targetUserId = Number(req.params.userId);

  if (!isChannelOwner(channelId, req.userId)) {
    return res.status(403).json({ error: 'Только владелец может снимать админов' });
  }

  const admin = db
    .prepare('SELECT role FROM channel_admins WHERE channel_id = ? AND user_id = ?')
    .get(channelId, targetUserId);
  if (!admin || admin.role === 'owner') {
    return res.status(400).json({ error: 'Нельзя снять владельца' });
  }

  db.prepare('DELETE FROM channel_admins WHERE channel_id = ? AND user_id = ?').run(
    channelId,
    targetUserId
  );

  res.json({ ok: true });
});

// ── GET /:id/members — List channel members with roles ──

router.get('/:id/members', (req, res) => {
  const channelId = Number(req.params.id);
  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
  if (!channel) return res.status(404).json({ error: 'Канал не найден' });

  const hideMembers = channel.hide_members === 1;
  const canSeeHidden = isChannelAdmin(channelId, req.userId);

  if (hideMembers && !canSeeHidden) {
    // Only return subscriber count, not the list
    const count = db
      .prepare('SELECT COUNT(*) as c FROM channel_subscriptions WHERE channel_id = ?')
      .get(channelId).c;
    return res.json({ members: [], subscriberCount: count, hidden: true });
  }

  const members = db
    .prepare(
      `SELECT cs.user_id as id, u.username, u.nickname, u.avatar_path,
              COALESCE(ca.role, 'subscriber') as role, cs.subscribed_at as joined_at
       FROM channel_subscriptions cs
       JOIN users u ON u.id = cs.user_id
       LEFT JOIN channel_admins ca ON ca.channel_id = cs.channel_id AND ca.user_id = cs.user_id
       WHERE cs.channel_id = ?
       ORDER BY CASE COALESCE(ca.role, 'subscriber')
                  WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
                cs.subscribed_at`
    )
    .all(channelId);

  res.json({
    members: members.map((m) => ({
      id: m.id,
      username: m.username,
      nickname: m.nickname,
      avatarPath: m.avatar_path,
      role: m.role,
      joinedAt: m.joined_at,
    })),
    subscriberCount: members.length,
    hidden: false,
  });
});

// ── POST /:id/invite — Generate/regenerate invite link ──

router.post('/:id/invite', (req, res) => {
  const channelId = Number(req.params.id);

  if (!isChannelAdmin(channelId, req.userId)) {
    return res.status(403).json({ error: 'Только админы могут создавать инвайт-ссылки' });
  }

  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
  if (!channel) return res.status(404).json({ error: 'Канал не найден' });

  // Delete existing invite (regenerate)
  db.prepare('DELETE FROM channel_invites WHERE channel_id = ?').run(channelId);

  const token = crypto.randomBytes(16).toString('hex');
  db.prepare(
    'INSERT INTO channel_invites (channel_id, token, created_by) VALUES (?, ?, ?)'
  ).run(channelId, token, req.userId);

  res.json({ token, inviteLink: `/api/channels/join/${token}` });
});

// ── PATCH /:id/settings — Update moderation settings ──

router.patch('/:id/settings', (req, res) => {
  const channelId = Number(req.params.id);

  if (!isChannelAdmin(channelId, req.userId)) {
    return res.status(403).json({ error: 'Только админы могут менять настройки' });
  }

  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
  if (!channel) return res.status(404).json({ error: 'Канал не найден' });

  const { slow_mode, only_admins_post, hide_members } = req.body || {};

  const sets = [];
  const vals = [];

  if (slow_mode !== undefined) {
    const val = Number(slow_mode);
    if (val < 0) return res.status(400).json({ error: 'slow_mode не может быть отрицательным' });
    sets.push('slow_mode = ?');
    vals.push(val);
  }
  if (only_admins_post !== undefined) {
    sets.push('only_admins_post = ?');
    vals.push(only_admins_post ? 1 : 0);
  }
  if (hide_members !== undefined) {
    sets.push('hide_members = ?');
    vals.push(hide_members ? 1 : 0);
  }

  if (sets.length === 0) {
    return res.status(400).json({ error: 'Укажите хотя бы одну настройку' });
  }

  vals.push(channelId);
  db.prepare(`UPDATE channels SET ${sets.join(', ')} WHERE id = ?`).run(...vals);

  const updated = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
  res.json({
    settings: {
      slowMode: updated.slow_mode || 0,
      onlyAdminsPost: Boolean(updated.only_admins_post),
      hideMembers: Boolean(updated.hide_members),
    },
  });
});

module.exports = router;