// src/routes/channels.js
// Telegram-like channels backend: server-side channels, subscribers,
// public/private visibility, admins/rights, reactions, comments, views,
// scheduled posts, pins, protected content and audit history.

const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { isUsernameAvailable } = require('./auth');
const { safeJsonParse, json, parsePaging, toBool } = require('../utils/format');
const { logChannel } = require('../utils/audit');
const {
  channelRole,
  isChannelAdmin,
  canManageChannel,
  canPostToChannel,
  isChannelBanned,
} = require('../utils/permissions');

const router = express.Router();
router.use(requireAuth);

const USERNAME_RE = /^[a-zA-Z0-9_]{4,30}$/;

function countSubscribers(channelId) {
  return db.prepare('SELECT COUNT(*) as c FROM channel_subscriptions WHERE channel_id = ?').get(channelId).c;
}

function channelStats(channelId) {
  return {
    subscribers: countSubscribers(channelId),
    posts: db.prepare('SELECT COUNT(*) as c FROM channel_messages WHERE channel_id = ? AND deleted_at IS NULL AND scheduled_at IS NULL').get(channelId).c,
    views: db.prepare(`SELECT COUNT(*) as c FROM channel_post_views v JOIN channel_messages m ON m.id = v.message_id WHERE m.channel_id = ?`).get(channelId).c,
    reactions: db.prepare(`SELECT COUNT(*) as c FROM channel_post_reactions r JOIN channel_messages m ON m.id = r.message_id WHERE m.channel_id = ?`).get(channelId).c,
  };
}

function formatChannel(row, userId, includeStats = false) {
  if (!row) return null;
  const role = channelRole(row.id, userId);
  const base = {
    id: row.id,
    name: row.name,
    description: row.description,
    username: row.username,
    visibility: row.visibility || 'public',
    isPublic: (row.visibility || 'public') === 'public',
    photoUrl: row.photo_url,
    slowMode: row.slow_mode || 0,
    onlyAdminsPost: Boolean(row.only_admins_post),
    hideMembers: Boolean(row.hide_members),
    protectedContent: Boolean(row.protected_content),
    linkedDiscussionGroupId: row.linked_discussion_group_id,
    signaturesEnabled: Boolean(row.signatures_enabled),
    defaultReactionEnabled: Boolean(row.default_reaction_enabled),
    autoDeleteSeconds: row.auto_delete_seconds,
    ownerId: row.owner_id,
    isOwner: role === 'owner',
    isAdmin: role === 'owner' || role === 'admin',
    isSubscribed: !!role,
    myRole: role,
    subscriberCount: Number(row.subscriber_count ?? countSubscribers(row.id)),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (includeStats) base.stats = channelStats(row.id);
  if (row.owner_username) base.owner = { username: row.owner_username, nickname: row.owner_nickname };
  return base;
}

function formatPost(row, userId) {
  if (!row) return null;
  const reactions = db.prepare(`SELECT emoji, COUNT(*) as count FROM channel_post_reactions WHERE message_id = ? GROUP BY emoji ORDER BY count DESC`).all(row.id);
  const myReactions = db.prepare(`SELECT emoji FROM channel_post_reactions WHERE message_id = ? AND user_id = ?`).all(row.id, userId).map((r) => r.emoji);
  const views = db.prepare('SELECT COUNT(*) as c FROM channel_post_views WHERE message_id = ?').get(row.id).c;
  const comments = db.prepare('SELECT COUNT(*) as c FROM channel_post_comments WHERE message_id = ? AND deleted_at IS NULL').get(row.id).c;
  const isPinned = Boolean(db.prepare('SELECT 1 FROM channel_pins WHERE message_id = ?').get(row.id));
  return {
    id: row.id,
    channelId: row.channel_id,
    text: row.text,
    media: safeJsonParse(row.media_json, []),
    entities: safeJsonParse(row.entities_json, []),
    silent: Boolean(row.silent),
    protectedContent: Boolean(row.protected_content),
    scheduledAt: row.scheduled_at,
    publishedAt: row.published_at,
    createdAt: row.created_at,
    sender: row.sender_username ? { id: row.sender_id, username: row.sender_username, nickname: row.sender_nickname } : undefined,
    views,
    commentsCount: comments,
    reactions: reactions.map((r) => ({ emoji: r.emoji, count: r.count, selected: myReactions.includes(r.emoji) })),
    isPinned,
    editHistory: safeJsonParse(row.edit_history_json, []),
  };
}

function requireChannel(req, res) {
  const id = Number(req.params.id || req.params.channelId);
  const channel = db.prepare('SELECT * FROM channels WHERE id = ? AND is_deleted = 0').get(id);
  if (!channel) {
    res.status(404).json({ error: 'Канал не найден' });
    return null;
  }
  return channel;
}

function emitChannel(req, channelId, event, payload) {
  const io = req.app.get('io');
  if (io) io.to(`channel:${channelId}`).emit(event, payload);
}

router.get('/', (req, res) => {
  const { limit, offset } = parsePaging(req);
  const q = String(req.query.q || '').trim();
  const where = [`c.is_deleted = 0`, `(c.visibility = 'public' OR EXISTS(SELECT 1 FROM channel_subscriptions cs WHERE cs.channel_id = c.id AND cs.user_id = ?))`];
  const params = [req.userId];
  if (q) {
    where.push('(c.name LIKE ? OR c.username LIKE ? OR c.description LIKE ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  params.push(req.userId, limit, offset);
  const rows = db.prepare(`
    SELECT c.*, u.username as owner_username, u.nickname as owner_nickname,
           (SELECT COUNT(*) FROM channel_subscriptions WHERE channel_id = c.id) as subscriber_count,
           EXISTS(SELECT 1 FROM channel_subscriptions WHERE channel_id = c.id AND user_id = ?) as is_subscribed
    FROM channels c JOIN users u ON u.id = c.owner_id
    WHERE ${where.join(' AND ')}
    ORDER BY c.created_at DESC LIMIT ? OFFSET ?`).all(...params);
  res.json({ channels: rows.map((c) => formatChannel(c, req.userId)) });
});

router.get('/mine', (req, res) => {
  const rows = db.prepare(`
    SELECT c.*, (SELECT COUNT(*) FROM channel_subscriptions WHERE channel_id = c.id) as subscriber_count
    FROM channels c
    JOIN channel_subscriptions s ON s.channel_id = c.id
    WHERE s.user_id = ? AND c.is_deleted = 0
    ORDER BY c.created_at DESC`).all(req.userId);
  res.json({ channels: rows.map((c) => formatChannel(c, req.userId)) });
});

router.post('/', (req, res) => {
  const { name, description, username, visibility = 'public', protectedContent, linkedDiscussionGroupId } = req.body || {};
  if (!name || !name.trim() || name.trim().length > 80) return res.status(400).json({ error: 'Название канала: 1-80 символов' });
  if (!['public', 'private'].includes(visibility)) return res.status(400).json({ error: 'visibility должен быть public/private' });
  if (username) {
    if (!USERNAME_RE.test(username)) return res.status(400).json({ error: 'Username: 4-30 символов, латиница/цифры/_' });
    if (!isUsernameAvailable(username, null)) return res.status(409).json({ error: 'Username уже занят' });
  }
  const info = db.prepare(`INSERT INTO channels (name, description, owner_id, username, visibility, protected_content, linked_discussion_group_id, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`).run(name.trim(), description?.trim() || null, req.userId, username || null, visibility, protectedContent ? 1 : 0, linkedDiscussionGroupId || null);
  const channelId = info.lastInsertRowid;
  db.prepare('INSERT INTO channel_subscriptions (channel_id, user_id) VALUES (?, ?)').run(channelId, req.userId);
  db.prepare('INSERT OR IGNORE INTO channel_admins (channel_id, user_id, role) VALUES (?, ?, ?)').run(channelId, req.userId, 'owner');
  db.prepare(`INSERT OR REPLACE INTO channel_admin_rights (channel_id, user_id, can_post, can_edit, can_delete, can_manage_subscribers, can_manage_admins, can_manage_settings, can_view_stats)
    VALUES (?, ?, 1, 1, 1, 1, 1, 1, 1)`).run(channelId, req.userId);
  logChannel(channelId, req.userId, 'channel.created', 'channel', channelId, { name, visibility });
  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
  res.status(201).json({ channel: formatChannel(channel, req.userId, true) });
});

router.get('/join/:token', (req, res) => {
  const invite = db.prepare('SELECT * FROM channel_invites WHERE token = ?').get(req.params.token);
  if (!invite) return res.status(404).json({ error: 'Инвайт не найден' });
  const channel = db.prepare('SELECT * FROM channels WHERE id = ? AND is_deleted = 0').get(invite.channel_id);
  if (!channel) return res.status(404).json({ error: 'Канал не найден' });
  if (invite.expires_at && new Date(invite.expires_at).getTime() < Date.now()) return res.status(410).json({ error: 'Инвайт истёк' });
  if (isChannelBanned(channel.id, req.userId)) return res.status(403).json({ error: 'Вы заблокированы в канале' });
  db.prepare('INSERT OR IGNORE INTO channel_subscriptions (channel_id, user_id) VALUES (?, ?)').run(channel.id, req.userId);
  logChannel(channel.id, req.userId, 'subscriber.joined_by_invite', 'user', req.userId, { token: req.params.token });
  res.json({ ok: true, channel: formatChannel(channel, req.userId) });
});

router.get('/:id', (req, res) => {
  const channel = requireChannel(req, res); if (!channel) return;
  const role = channelRole(channel.id, req.userId);
  if (channel.visibility === 'private' && !role) return res.status(403).json({ error: 'Приватный канал' });
  res.json({ channel: formatChannel(channel, req.userId, role === 'owner' || role === 'admin') });
});

router.patch('/:id', (req, res) => {
  const channel = requireChannel(req, res); if (!channel) return;
  if (!canManageChannel(channel.id, req.userId, 'can_manage_settings')) return res.status(403).json({ error: 'Нет права редактировать канал' });
  const allowed = {
    name: 'name', description: 'description', username: 'username', photoUrl: 'photo_url', photo_url: 'photo_url',
    visibility: 'visibility', protectedContent: 'protected_content', linkedDiscussionGroupId: 'linked_discussion_group_id',
    slowMode: 'slow_mode', onlyAdminsPost: 'only_admins_post', hideMembers: 'hide_members', signaturesEnabled: 'signatures_enabled',
    defaultReactionEnabled: 'default_reaction_enabled', autoDeleteSeconds: 'auto_delete_seconds'
  };
  const sets = [], vals = [];
  for (const [input, column] of Object.entries(allowed)) {
    if (req.body[input] === undefined) continue;
    let value = req.body[input];
    if (input === 'name') {
      if (!String(value).trim() || String(value).trim().length > 80) return res.status(400).json({ error: 'Название канала: 1-80 символов' });
      value = String(value).trim();
    }
    if (input === 'username') {
      value = value ? String(value).trim() : null;
      if (value && !USERNAME_RE.test(value)) return res.status(400).json({ error: 'Username: 4-30 символов, латиница/цифры/_' });
      if (value && value !== channel.username && !isUsernameAvailable(value, null)) return res.status(409).json({ error: 'Username уже занят' });
    }
    if (input === 'visibility' && !['public', 'private'].includes(value)) return res.status(400).json({ error: 'visibility должен быть public/private' });
    if (['protectedContent','onlyAdminsPost','hideMembers','signaturesEnabled','defaultReactionEnabled'].includes(input)) value = toBool(value) ? 1 : 0;
    sets.push(`${column} = ?`); vals.push(value ?? null);
  }
  if (!sets.length) return res.status(400).json({ error: 'Нет изменений' });
  sets.push('updated_at = datetime(\'now\')'); vals.push(channel.id);
  db.prepare(`UPDATE channels SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  logChannel(channel.id, req.userId, 'channel.updated', 'channel', channel.id, req.body);
  const updated = db.prepare('SELECT * FROM channels WHERE id = ?').get(channel.id);
  emitChannel(req, channel.id, 'channel:updated', { channel: formatChannel(updated, req.userId) });
  res.json({ channel: formatChannel(updated, req.userId, true) });
});

router.delete('/:id', (req, res) => {
  const channel = requireChannel(req, res); if (!channel) return;
  if (channel.owner_id !== req.userId) return res.status(403).json({ error: 'Только владелец может удалить канал' });
  db.prepare('UPDATE channels SET is_deleted = 1, updated_at = datetime(\'now\') WHERE id = ?').run(channel.id);
  logChannel(channel.id, req.userId, 'channel.deleted', 'channel', channel.id);
  emitChannel(req, channel.id, 'channel:deleted', { channelId: channel.id });
  res.json({ ok: true });
});

router.post('/:id/subscribe', (req, res) => {
  const channel = requireChannel(req, res); if (!channel) return;
  if (isChannelBanned(channel.id, req.userId)) return res.status(403).json({ error: 'Вы заблокированы в канале' });
  if (channel.visibility === 'private') {
    db.prepare(`INSERT OR REPLACE INTO channel_join_requests (channel_id, user_id, status) VALUES (?, ?, 'pending')`).run(channel.id, req.userId);
    return res.json({ ok: true, joinRequest: 'pending' });
  }
  db.prepare('INSERT OR IGNORE INTO channel_subscriptions (channel_id, user_id) VALUES (?, ?)').run(channel.id, req.userId);
  logChannel(channel.id, req.userId, 'subscriber.joined', 'user', req.userId);
  emitChannel(req, channel.id, 'channel:subscriber:new', { channelId: channel.id, userId: req.userId });
  res.json({ ok: true });
});

router.delete('/:id/subscribe', (req, res) => {
  const channel = requireChannel(req, res); if (!channel) return;
  if (channel.owner_id === req.userId) return res.status(400).json({ error: 'Владелец не может отписаться от своего канала' });
  db.prepare('DELETE FROM channel_subscriptions WHERE channel_id = ? AND user_id = ?').run(channel.id, req.userId);
  db.prepare('DELETE FROM channel_admins WHERE channel_id = ? AND user_id = ?').run(channel.id, req.userId);
  logChannel(channel.id, req.userId, 'subscriber.left', 'user', req.userId);
  res.json({ ok: true });
});

router.get('/:id/messages', (req, res) => {
  const channel = requireChannel(req, res); if (!channel) return;
  const role = channelRole(channel.id, req.userId);
  if (channel.visibility === 'private' && !role) return res.status(403).json({ error: 'Приватный канал' });
  const { limit, offset } = parsePaging(req);
  const includeScheduled = req.query.scheduled === '1' && isChannelAdmin(channel.id, req.userId);
  const rows = db.prepare(`SELECT m.*, u.username as sender_username, u.nickname as sender_nickname
    FROM channel_messages m JOIN users u ON u.id = m.sender_id
    WHERE m.channel_id = ? AND m.deleted_at IS NULL ${includeScheduled ? '' : 'AND m.scheduled_at IS NULL'}
    ORDER BY COALESCE(m.published_at, m.created_at) ASC, m.id ASC LIMIT ? OFFSET ?`).all(channel.id, limit, offset);
  res.json({ channel: formatChannel(channel, req.userId), messages: rows.map((m) => formatPost(m, req.userId)) });
});

router.post('/:id/messages', (req, res) => {
  const channel = requireChannel(req, res); if (!channel) return;
  if (!canPostToChannel(channel.id, req.userId)) return res.status(403).json({ error: 'Нет права публиковать' });
  const { text = '', media = [], entities = [], silent = false, protectedContent, scheduledAt } = req.body || {};
  if (!String(text).trim() && (!Array.isArray(media) || !media.length)) return res.status(400).json({ error: 'Пустая публикация' });
  const scheduled = scheduledAt ? new Date(scheduledAt) : null;
  const info = db.prepare(`INSERT INTO channel_messages (channel_id, sender_id, text, media_json, entities_json, silent, protected_content, scheduled_at, published_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(channel.id, req.userId, String(text).trim(), json(media), json(entities), silent ? 1 : 0, protectedContent ?? channel.protected_content ? 1 : 0, scheduled ? scheduled.toISOString() : null, scheduled ? null : new Date().toISOString());
  const row = db.prepare(`SELECT m.*, u.username as sender_username, u.nickname as sender_nickname FROM channel_messages m JOIN users u ON u.id = m.sender_id WHERE m.id = ?`).get(info.lastInsertRowid);
  const post = formatPost(row, req.userId);
  logChannel(channel.id, req.userId, scheduled ? 'post.scheduled' : 'post.created', 'post', row.id, { scheduledAt });
  if (!scheduled) emitChannel(req, channel.id, 'channel:message:new', post);
  res.status(201).json({ message: post });
});

router.patch('/:id/messages/:messageId', (req, res) => {
  const channel = requireChannel(req, res); if (!channel) return;
  const messageId = Number(req.params.messageId);
  const post = db.prepare('SELECT * FROM channel_messages WHERE id = ? AND channel_id = ? AND deleted_at IS NULL').get(messageId, channel.id);
  if (!post) return res.status(404).json({ error: 'Пост не найден' });
  if (post.sender_id !== req.userId && !canManageChannel(channel.id, req.userId, 'can_edit')) return res.status(403).json({ error: 'Нет права редактировать пост' });
  const history = safeJsonParse(post.edit_history_json, []);
  history.push({ text: post.text, media: safeJsonParse(post.media_json, []), editedAt: new Date().toISOString(), actorId: req.userId });
  const nextText = req.body.text !== undefined ? String(req.body.text).trim() : post.text;
  const nextMedia = req.body.media !== undefined ? req.body.media : safeJsonParse(post.media_json, []);
  db.prepare(`UPDATE channel_messages SET text = ?, media_json = ?, entities_json = COALESCE(?, entities_json), edit_history_json = ? WHERE id = ?`).run(nextText, json(nextMedia), req.body.entities ? json(req.body.entities) : null, json(history), messageId);
  const row = db.prepare(`SELECT m.*, u.username as sender_username, u.nickname as sender_nickname FROM channel_messages m JOIN users u ON u.id = m.sender_id WHERE m.id = ?`).get(messageId);
  const formatted = formatPost(row, req.userId);
  logChannel(channel.id, req.userId, 'post.edited', 'post', messageId);
  emitChannel(req, channel.id, 'channel:message:updated', formatted);
  res.json({ message: formatted });
});

router.delete('/:id/messages/:messageId', (req, res) => {
  const channel = requireChannel(req, res); if (!channel) return;
  const messageId = Number(req.params.messageId);
  const post = db.prepare('SELECT * FROM channel_messages WHERE id = ? AND channel_id = ?').get(messageId, channel.id);
  if (!post) return res.status(404).json({ error: 'Пост не найден' });
  if (post.sender_id !== req.userId && !canManageChannel(channel.id, req.userId, 'can_delete')) return res.status(403).json({ error: 'Нет права удалить пост' });
  db.prepare('UPDATE channel_messages SET deleted_at = datetime(\'now\') WHERE id = ?').run(messageId);
  logChannel(channel.id, req.userId, 'post.deleted', 'post', messageId);
  emitChannel(req, channel.id, 'channel:message:deleted', { channelId: channel.id, messageId });
  res.json({ ok: true });
});

router.post('/:id/messages/:messageId/view', (req, res) => {
  const channel = requireChannel(req, res); if (!channel) return;
  const messageId = Number(req.params.messageId);
  const post = db.prepare('SELECT id FROM channel_messages WHERE id = ? AND channel_id = ?').get(messageId, channel.id);
  if (!post) return res.status(404).json({ error: 'Пост не найден' });
  db.prepare('INSERT OR IGNORE INTO channel_post_views (message_id, user_id) VALUES (?, ?)').run(messageId, req.userId);
  const views = db.prepare('SELECT COUNT(*) as c FROM channel_post_views WHERE message_id = ?').get(messageId).c;
  res.json({ ok: true, views });
});

router.post('/:id/messages/:messageId/reactions', (req, res) => {
  const channel = requireChannel(req, res); if (!channel) return;
  if (!channel.default_reaction_enabled) return res.status(403).json({ error: 'Реакции отключены' });
  const { emoji, isPremium } = req.body || {};
  if (!emoji) return res.status(400).json({ error: 'emoji обязателен' });
  const messageId = Number(req.params.messageId);
  const post = db.prepare('SELECT id FROM channel_messages WHERE id = ? AND channel_id = ?').get(messageId, channel.id);
  if (!post) return res.status(404).json({ error: 'Пост не найден' });
  db.prepare('INSERT OR IGNORE INTO channel_post_reactions (message_id, user_id, emoji, is_premium) VALUES (?, ?, ?, ?)').run(messageId, req.userId, emoji, isPremium ? 1 : 0);
  const reactions = db.prepare('SELECT emoji, COUNT(*) as count FROM channel_post_reactions WHERE message_id = ? GROUP BY emoji').all(messageId);
  emitChannel(req, channel.id, 'channel:reaction:new', { channelId: channel.id, messageId, userId: req.userId, emoji });
  res.json({ ok: true, reactions });
});

router.delete('/:id/messages/:messageId/reactions/:emoji', (req, res) => {
  const channel = requireChannel(req, res); if (!channel) return;
  const messageId = Number(req.params.messageId);
  db.prepare('DELETE FROM channel_post_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?').run(messageId, req.userId, req.params.emoji);
  const reactions = db.prepare('SELECT emoji, COUNT(*) as count FROM channel_post_reactions WHERE message_id = ? GROUP BY emoji').all(messageId);
  res.json({ ok: true, reactions });
});

router.get('/:id/messages/:messageId/comments', (req, res) => {
  const channel = requireChannel(req, res); if (!channel) return;
  const messageId = Number(req.params.messageId);
  const rows = db.prepare(`SELECT c.*, u.username, u.nickname FROM channel_post_comments c JOIN users u ON u.id = c.user_id WHERE c.message_id = ? AND c.deleted_at IS NULL ORDER BY c.created_at ASC`).all(messageId);
  res.json({ comments: rows.map((c) => ({ id: c.id, text: c.text, replyToCommentId: c.reply_to_comment_id, createdAt: c.created_at, editedAt: c.edited_at, user: { id: c.user_id, username: c.username, nickname: c.nickname } })) });
});

router.post('/:id/messages/:messageId/comments', (req, res) => {
  const channel = requireChannel(req, res); if (!channel) return;
  const messageId = Number(req.params.messageId);
  const { text, replyToCommentId } = req.body || {};
  if (!text || !String(text).trim()) return res.status(400).json({ error: 'Пустой комментарий' });
  const post = db.prepare('SELECT id FROM channel_messages WHERE id = ? AND channel_id = ?').get(messageId, channel.id);
  if (!post) return res.status(404).json({ error: 'Пост не найден' });
  const info = db.prepare('INSERT INTO channel_post_comments (message_id, user_id, text, reply_to_comment_id) VALUES (?, ?, ?, ?)').run(messageId, req.userId, String(text).trim(), replyToCommentId || null);
  const comment = db.prepare(`SELECT c.*, u.username, u.nickname FROM channel_post_comments c JOIN users u ON u.id = c.user_id WHERE c.id = ?`).get(info.lastInsertRowid);
  const wire = { id: comment.id, messageId, text: comment.text, user: { id: req.userId, username: comment.username, nickname: comment.nickname }, createdAt: comment.created_at };
  emitChannel(req, channel.id, 'channel:comment:new', wire);
  res.status(201).json({ comment: wire });
});

router.post('/:id/messages/:messageId/pin', (req, res) => {
  const channel = requireChannel(req, res); if (!channel) return;
  if (!canManageChannel(channel.id, req.userId, 'can_edit')) return res.status(403).json({ error: 'Нет права закреплять' });
  const messageId = Number(req.params.messageId);
  db.prepare('INSERT OR IGNORE INTO channel_pins (channel_id, message_id, pinned_by) VALUES (?, ?, ?)').run(channel.id, messageId, req.userId);
  logChannel(channel.id, req.userId, 'post.pinned', 'post', messageId);
  emitChannel(req, channel.id, 'channel:pin:new', { channelId: channel.id, messageId });
  res.json({ ok: true });
});

router.delete('/:id/messages/:messageId/pin', (req, res) => {
  const channel = requireChannel(req, res); if (!channel) return;
  if (!canManageChannel(channel.id, req.userId, 'can_edit')) return res.status(403).json({ error: 'Нет права откреплять' });
  const messageId = Number(req.params.messageId);
  db.prepare('DELETE FROM channel_pins WHERE channel_id = ? AND message_id = ?').run(channel.id, messageId);
  emitChannel(req, channel.id, 'channel:pin:removed', { channelId: channel.id, messageId });
  res.json({ ok: true });
});

router.get('/:id/pins', (req, res) => {
  const channel = requireChannel(req, res); if (!channel) return;
  const rows = db.prepare(`SELECT m.*, u.username as sender_username, u.nickname as sender_nickname FROM channel_pins p JOIN channel_messages m ON m.id = p.message_id JOIN users u ON u.id = m.sender_id WHERE p.channel_id = ? ORDER BY p.pinned_at DESC`).all(channel.id);
  res.json({ pins: rows.map((m) => formatPost(m, req.userId)) });
});

router.get('/:id/scheduled', (req, res) => {
  const channel = requireChannel(req, res); if (!channel) return;
  if (!isChannelAdmin(channel.id, req.userId)) return res.status(403).json({ error: 'Только админы' });
  const rows = db.prepare(`SELECT m.*, u.username as sender_username, u.nickname as sender_nickname FROM channel_messages m JOIN users u ON u.id = m.sender_id WHERE m.channel_id = ? AND m.scheduled_at IS NOT NULL AND m.deleted_at IS NULL ORDER BY m.scheduled_at ASC`).all(channel.id);
  res.json({ scheduled: rows.map((m) => formatPost(m, req.userId)) });
});

router.post('/:id/scheduled/:messageId/publish', (req, res) => {
  const channel = requireChannel(req, res); if (!channel) return;
  if (!isChannelAdmin(channel.id, req.userId)) return res.status(403).json({ error: 'Только админы' });
  const messageId = Number(req.params.messageId);
  db.prepare('UPDATE channel_messages SET scheduled_at = NULL, published_at = datetime(\'now\') WHERE id = ? AND channel_id = ?').run(messageId, channel.id);
  const row = db.prepare(`SELECT m.*, u.username as sender_username, u.nickname as sender_nickname FROM channel_messages m JOIN users u ON u.id = m.sender_id WHERE m.id = ?`).get(messageId);
  const post = formatPost(row, req.userId);
  emitChannel(req, channel.id, 'channel:message:new', post);
  res.json({ message: post });
});

router.get('/:id/admins', (req, res) => {
  const channel = requireChannel(req, res); if (!channel) return;
  if (!isChannelAdmin(channel.id, req.userId)) return res.status(403).json({ error: 'Только админы' });
  const admins = db.prepare(`SELECT ca.role, u.id, u.username, u.nickname, r.* FROM channel_admins ca JOIN users u ON u.id = ca.user_id LEFT JOIN channel_admin_rights r ON r.channel_id = ca.channel_id AND r.user_id = ca.user_id WHERE ca.channel_id = ? ORDER BY ca.role DESC`).all(channel.id);
  res.json({ admins });
});

router.post('/:id/admins/:userId', (req, res) => {
  const channel = requireChannel(req, res); if (!channel) return;
  if (!canManageChannel(channel.id, req.userId, 'can_manage_admins')) return res.status(403).json({ error: 'Нет права назначать админов' });
  const targetUserId = Number(req.params.userId);
  db.prepare('INSERT OR IGNORE INTO channel_subscriptions (channel_id, user_id) VALUES (?, ?)').run(channel.id, targetUserId);
  db.prepare('INSERT OR REPLACE INTO channel_admins (channel_id, user_id, role) VALUES (?, ?, ?)').run(channel.id, targetUserId, 'admin');
  const rights = req.body.rights || {};
  db.prepare(`INSERT OR REPLACE INTO channel_admin_rights (channel_id, user_id, can_post, can_edit, can_delete, can_manage_subscribers, can_manage_admins, can_manage_settings, can_view_stats)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(channel.id, targetUserId, rights.canPost !== false ? 1 : 0, rights.canEdit !== false ? 1 : 0, rights.canDelete !== false ? 1 : 0, rights.canManageSubscribers ? 1 : 0, rights.canManageAdmins ? 1 : 0, rights.canManageSettings ? 1 : 0, rights.canViewStats ? 1 : 0);
  logChannel(channel.id, req.userId, 'admin.promoted', 'user', targetUserId, rights);
  res.json({ ok: true });
});

router.delete('/:id/admins/:userId', (req, res) => {
  const channel = requireChannel(req, res); if (!channel) return;
  if (!canManageChannel(channel.id, req.userId, 'can_manage_admins')) return res.status(403).json({ error: 'Нет права снимать админов' });
  const targetUserId = Number(req.params.userId);
  if (targetUserId === channel.owner_id) return res.status(400).json({ error: 'Нельзя снять владельца' });
  db.prepare('DELETE FROM channel_admins WHERE channel_id = ? AND user_id = ?').run(channel.id, targetUserId);
  db.prepare('DELETE FROM channel_admin_rights WHERE channel_id = ? AND user_id = ?').run(channel.id, targetUserId);
  logChannel(channel.id, req.userId, 'admin.demoted', 'user', targetUserId);
  res.json({ ok: true });
});

router.get('/:id/members', (req, res) => {
  const channel = requireChannel(req, res); if (!channel) return;
  const role = channelRole(channel.id, req.userId);
  if (channel.hide_members && role !== 'owner' && role !== 'admin') return res.json({ members: [], subscriberCount: countSubscribers(channel.id), hidden: true });
  const rows = db.prepare(`SELECT cs.user_id as id, u.username, u.nickname, u.avatar_path, COALESCE(ca.role, 'subscriber') as role, cs.subscribed_at as joined_at
    FROM channel_subscriptions cs JOIN users u ON u.id = cs.user_id LEFT JOIN channel_admins ca ON ca.channel_id = cs.channel_id AND ca.user_id = cs.user_id
    WHERE cs.channel_id = ? ORDER BY CASE COALESCE(ca.role, 'subscriber') WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, cs.subscribed_at`).all(channel.id);
  res.json({ members: rows.map((m) => ({ id: m.id, username: m.username, nickname: m.nickname, avatarUrl: m.avatar_path ? `/avatars/${m.avatar_path}` : null, role: m.role, joinedAt: m.joined_at })), subscriberCount: rows.length, hidden: false });
});

router.delete('/:id/members/:userId', (req, res) => {
  const channel = requireChannel(req, res); if (!channel) return;
  if (!canManageChannel(channel.id, req.userId, 'can_manage_subscribers')) return res.status(403).json({ error: 'Нет права удалять подписчиков' });
  const targetUserId = Number(req.params.userId);
  if (targetUserId === channel.owner_id) return res.status(400).json({ error: 'Нельзя удалить владельца' });
  db.prepare('DELETE FROM channel_subscriptions WHERE channel_id = ? AND user_id = ?').run(channel.id, targetUserId);
  db.prepare('DELETE FROM channel_admins WHERE channel_id = ? AND user_id = ?').run(channel.id, targetUserId);
  db.prepare('DELETE FROM channel_admin_rights WHERE channel_id = ? AND user_id = ?').run(channel.id, targetUserId);
  logChannel(channel.id, req.userId, 'subscriber.removed', 'user', targetUserId);
  res.json({ ok: true });
});

router.post('/:id/ban/:userId', (req, res) => {
  const channel = requireChannel(req, res); if (!channel) return;
  if (!canManageChannel(channel.id, req.userId, 'can_manage_subscribers')) return res.status(403).json({ error: 'Нет права банить' });
  const targetUserId = Number(req.params.userId);
  if (targetUserId === channel.owner_id) return res.status(400).json({ error: 'Нельзя забанить владельца' });
  const { reason, until } = req.body || {};
  db.prepare('INSERT OR REPLACE INTO channel_bans (channel_id, user_id, banned_by, reason, banned_until) VALUES (?, ?, ?, ?, ?)').run(channel.id, targetUserId, req.userId, reason || null, until || null);
  db.prepare('DELETE FROM channel_subscriptions WHERE channel_id = ? AND user_id = ?').run(channel.id, targetUserId);
  logChannel(channel.id, req.userId, 'subscriber.banned', 'user', targetUserId, { reason, until });
  res.json({ ok: true });
});

router.delete('/:id/ban/:userId', (req, res) => {
  const channel = requireChannel(req, res); if (!channel) return;
  if (!canManageChannel(channel.id, req.userId, 'can_manage_subscribers')) return res.status(403).json({ error: 'Нет права разбанить' });
  db.prepare('DELETE FROM channel_bans WHERE channel_id = ? AND user_id = ?').run(channel.id, Number(req.params.userId));
  res.json({ ok: true });
});

router.post('/:id/invite', (req, res) => {
  const channel = requireChannel(req, res); if (!channel) return;
  if (!isChannelAdmin(channel.id, req.userId)) return res.status(403).json({ error: 'Только админы могут создавать инвайт-ссылки' });
  const token = crypto.randomBytes(16).toString('hex');
  db.prepare('INSERT INTO channel_invites (channel_id, token, created_by, expires_at) VALUES (?, ?, ?, ?)').run(channel.id, token, req.userId, req.body?.expiresAt || null);
  res.json({ token, inviteLink: `/channels/join/${token}`, apiInviteLink: `/channels/join/${token}` });
});

router.get('/:id/join-requests', (req, res) => {
  const channel = requireChannel(req, res); if (!channel) return;
  if (!canManageChannel(channel.id, req.userId, 'can_manage_subscribers')) return res.status(403).json({ error: 'Нет права видеть заявки' });
  const rows = db.prepare(`SELECT r.*, u.username, u.nickname FROM channel_join_requests r JOIN users u ON u.id = r.user_id WHERE r.channel_id = ? ORDER BY r.requested_at ASC`).all(channel.id);
  res.json({ requests: rows });
});

router.post('/:id/join-requests/:userId/:action', (req, res) => {
  const channel = requireChannel(req, res); if (!channel) return;
  if (!canManageChannel(channel.id, req.userId, 'can_manage_subscribers')) return res.status(403).json({ error: 'Нет права управлять заявками' });
  const targetUserId = Number(req.params.userId);
  const action = req.params.action;
  if (!['approve', 'decline'].includes(action)) return res.status(400).json({ error: 'action approve/decline' });
  db.prepare('UPDATE channel_join_requests SET status = ? WHERE channel_id = ? AND user_id = ?').run(action === 'approve' ? 'approved' : 'declined', channel.id, targetUserId);
  if (action === 'approve') db.prepare('INSERT OR IGNORE INTO channel_subscriptions (channel_id, user_id) VALUES (?, ?)').run(channel.id, targetUserId);
  res.json({ ok: true });
});

router.get('/:id/stats', (req, res) => {
  const channel = requireChannel(req, res); if (!channel) return;
  if (!canManageChannel(channel.id, req.userId, 'can_view_stats')) return res.status(403).json({ error: 'Нет права смотреть статистику' });
  const topPosts = db.prepare(`SELECT m.id, m.text, COUNT(v.user_id) as views FROM channel_messages m LEFT JOIN channel_post_views v ON v.message_id = m.id WHERE m.channel_id = ? GROUP BY m.id ORDER BY views DESC LIMIT 20`).all(channel.id);
  res.json({ stats: { ...channelStats(channel.id), topPosts } });
});

router.get('/:id/audit', (req, res) => {
  const channel = requireChannel(req, res); if (!channel) return;
  if (!isChannelAdmin(channel.id, req.userId)) return res.status(403).json({ error: 'Только админы' });
  const rows = db.prepare(`SELECT l.*, u.username, u.nickname FROM channel_audit_log l JOIN users u ON u.id = l.actor_id WHERE l.channel_id = ? ORDER BY l.created_at DESC LIMIT 200`).all(channel.id);
  res.json({ events: rows.map((r) => ({ ...r, payload: safeJsonParse(r.payload_json, null) })) });
});

// Backward-compatible old endpoint.
router.patch('/:id/settings', (req, res) => {
  const channel = requireChannel(req, res); if (!channel) return;
  if (!canManageChannel(channel.id, req.userId, 'can_manage_settings')) return res.status(403).json({ error: 'Нет права менять настройки' });
  const slowMode = req.body.slowMode ?? req.body.slow_mode;
  const onlyAdminsPost = req.body.onlyAdminsPost ?? req.body.only_admins_post;
  const hideMembers = req.body.hideMembers ?? req.body.hide_members;
  const protectedContent = req.body.protectedContent ?? req.body.protected_content;
  const sets = []; const vals = [];
  if (slowMode !== undefined) { sets.push('slow_mode = ?'); vals.push(Number(slowMode) || 0); }
  if (onlyAdminsPost !== undefined) { sets.push('only_admins_post = ?'); vals.push(toBool(onlyAdminsPost) ? 1 : 0); }
  if (hideMembers !== undefined) { sets.push('hide_members = ?'); vals.push(toBool(hideMembers) ? 1 : 0); }
  if (protectedContent !== undefined) { sets.push('protected_content = ?'); vals.push(toBool(protectedContent) ? 1 : 0); }
  if (!sets.length) return res.status(400).json({ error: 'Нет изменений' });
  sets.push('updated_at = datetime(\'now\')'); vals.push(channel.id);
  db.prepare(`UPDATE channels SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  const updated = db.prepare('SELECT * FROM channels WHERE id = ?').get(channel.id);
  res.json({ settings: formatChannel(updated, req.userId, true) });
});

module.exports = router;
module.exports.formatChannel = formatChannel;
module.exports.formatPost = formatPost;
