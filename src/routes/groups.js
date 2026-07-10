// src/routes/groups.js
//
// Группы NYX — многосторонние чаты с поддержкой админов,
// инвайт-ссылок и управления участниками.

const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { isUsernameAvailable } = require('./auth');
const { safeJsonParse } = require('../utils/format');

const router = express.Router();
router.use(requireAuth);

// ── Helpers ──

function isGroupMember(groupId, userId) {
  return db
    .prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?')
    .get(groupId, userId);
}

function isGroupAdmin(groupId, userId) {
  const m = db
    .prepare('SELECT role FROM group_members WHERE group_id = ? AND user_id = ?')
    .get(groupId, userId);
  return m && (m.role === 'admin' || m.role === 'owner');
}

function isGroupOwner(groupId, userId) {
  const m = db
    .prepare('SELECT role FROM group_members WHERE group_id = ? AND user_id = ?')
    .get(groupId, userId);
  return m && m.role === 'owner';
}

function publicGroup(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    isPublic: Boolean(row.is_public),
    username: row.username,
    photoUrl: row.photo_url,
    memberCount: row.member_count || 0,
    accentColor: row.accent_color,
    welcomeText: row.welcome_text,
    theme: safeJsonParse(row.theme_json, null),
    createdAt: row.created_at,
  };
}

// ── POST / — Create group ──

router.post('/', (req, res) => {
  const { name, description, isPublic, username } = req.body || {};

  if (!name || !name.trim() || name.trim().length > 60) {
    return res.status(400).json({ error: 'Название группы: 1-60 символов' });
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
    .prepare(
      'INSERT INTO groups (name, description, owner_id, is_public, username) VALUES (?, ?, ?, ?, ?)'
    )
    .run(
      name.trim(),
      description?.trim() || null,
      req.userId,
      isPublic ? 1 : 0,
      username || null
    );

  const groupId = info.lastInsertRowid;

  // Owner becomes first member with 'owner' role
  db.prepare(
    'INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, ?)'
  ).run(groupId, req.userId, 'owner');

  const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(groupId);
  res.status(201).json({ group: publicGroup({ ...group, member_count: 1 }) });
});

// ── GET / — List user's groups ──

router.get('/', (req, res) => {
  const groups = db
    .prepare(
      `SELECT g.*,
              (SELECT COUNT(*) FROM group_members WHERE group_id = g.id) as member_count
       FROM groups g
       JOIN group_members gm ON gm.group_id = g.id AND gm.user_id = ?
       ORDER BY g.created_at DESC`
    )
    .all(req.userId);

  res.json({ groups: groups.map(publicGroup) });
});

// ── GET /:id — Get group info + members ──

router.get('/:id', (req, res) => {
  const groupId = Number(req.params.id);
  const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(groupId);
  if (!group) return res.status(404).json({ error: 'Группа не найдена' });

  if (!isGroupMember(groupId, req.userId)) {
    return res.status(403).json({ error: 'Вы не участник этой группы' });
  }

  const members = db
    .prepare(
      `SELECT gm.role, gm.joined_at, u.id, u.username, u.nickname, u.avatar_path
       FROM group_members gm
       JOIN users u ON u.id = gm.user_id
       WHERE gm.group_id = ?
       ORDER BY CASE gm.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, gm.joined_at`
    )
    .all(groupId);

  const memberCount = db
    .prepare('SELECT COUNT(*) as c FROM group_members WHERE group_id = ?')
    .get(groupId).c;

  res.json({
    group: publicGroup({ ...group, member_count: memberCount }),
    members: members.map((m) => ({
      id: m.id,
      username: m.username,
      nickname: m.nickname,
      avatarPath: m.avatar_path,
      role: m.role,
      joinedAt: m.joined_at,
    })),
  });
});

// ── POST /:id/members — Add member to group ──

router.post('/:id/members', (req, res) => {
  const groupId = Number(req.params.id);
  const { userId } = req.body || {};

  if (!userId) return res.status(400).json({ error: 'Укажите userId' });

  const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(groupId);
  if (!group) return res.status(404).json({ error: 'Группа не найдена' });

  if (!isGroupAdmin(groupId, req.userId)) {
    return res.status(403).json({ error: 'Только админы могут добавлять участников' });
  }

  const target = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
  if (!target) return res.status(404).json({ error: 'Пользователь не найден' });

  const existing = isGroupMember(groupId, userId);
  if (existing) return res.status(409).json({ error: 'Пользователь уже в группе' });

  db.prepare(
    'INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, ?)'
  ).run(groupId, userId, 'member');

  res.json({ ok: true });
});

// ── DELETE /:id/members/:userId — Remove member ──

router.delete('/:id/members/:userId', (req, res) => {
  const groupId = Number(req.params.id);
  const targetUserId = Number(req.params.userId);

  const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(groupId);
  if (!group) return res.status(404).json({ error: 'Группа не найдена' });

  // Can remove self, or admin can remove non-admin members
  if (targetUserId !== req.userId && !isGroupAdmin(groupId, req.userId)) {
    return res.status(403).json({ error: 'Нет прав для удаления участника' });
  }

  // Cannot remove owner
  if (isGroupOwner(groupId, targetUserId)) {
    return res.status(403).json({ error: 'Нельзя удалить владельца группы' });
  }

  // Admin cannot remove another admin (only owner can)
  if (targetUserId !== req.userId && isGroupAdmin(groupId, targetUserId) && !isGroupOwner(groupId, req.userId)) {
    return res.status(403).json({ error: 'Только владелец может удалить админа' });
  }

  db.prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?').run(
    groupId,
    targetUserId
  );

  res.json({ ok: true });
});

// ── POST /:id/messages — Send message to group ──

router.post('/:id/messages', (req, res) => {
  const groupId = Number(req.params.id);
  const { text } = req.body || {};

  if (!text || !text.trim()) {
    return res.status(400).json({ error: 'Сообщение не может быть пустым' });
  }

  if (!isGroupMember(groupId, req.userId)) {
    return res.status(403).json({ error: 'Вы не участник этой группы' });
  }

  const info = db
    .prepare(
      'INSERT INTO group_messages (group_id, sender_id, text) VALUES (?, ?, ?)'
    )
    .run(groupId, req.userId, text.trim());

  const message = db
    .prepare(
      `SELECT gm.*, u.username as sender_username, u.nickname as sender_nickname
       FROM group_messages gm
       JOIN users u ON u.id = gm.sender_id
       WHERE gm.id = ?`
    )
    .get(info.lastInsertRowid);

  res.status(201).json({
    message: {
      id: message.id,
      text: message.text,
      senderUsername: message.sender_username,
      senderNickname: message.sender_nickname,
      createdAt: message.created_at,
    },
  });
});

// ── GET /:id/messages — Get group messages ──

router.get('/:id/messages', (req, res) => {
  const groupId = Number(req.params.id);
  const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(groupId);
  if (!group) return res.status(404).json({ error: 'Группа не найдена' });

  if (!isGroupMember(groupId, req.userId)) {
    return res.status(403).json({ error: 'Вы не участник этой группы' });
  }

  const messages = db
    .prepare(
      `SELECT gm.*, u.username as sender_username, u.nickname as sender_nickname
       FROM group_messages gm
       JOIN users u ON u.id = gm.sender_id
       WHERE gm.group_id = ?
       ORDER BY gm.created_at ASC, gm.id ASC`
    )
    .all(groupId);

  res.json({
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
  const groupId = Number(req.params.id);
  const targetUserId = Number(req.params.userId);

  if (!isGroupOwner(groupId, req.userId)) {
    return res.status(403).json({ error: 'Только владелец может назначать админов' });
  }

  const member = isGroupMember(groupId, targetUserId);
  if (!member) return res.status(404).json({ error: 'Пользователь не участник группы' });

  db.prepare(
    'UPDATE group_members SET role = ? WHERE group_id = ? AND user_id = ?'
  ).run('admin', groupId, targetUserId);

  res.json({ ok: true });
});

// ── DELETE /:id/admins/:userId — Remove admin ──

router.delete('/:id/admins/:userId', (req, res) => {
  const groupId = Number(req.params.id);
  const targetUserId = Number(req.params.userId);

  if (!isGroupOwner(groupId, req.userId)) {
    return res.status(403).json({ error: 'Только владелец может снимать админов' });
  }

  const member = db
    .prepare('SELECT role FROM group_members WHERE group_id = ? AND user_id = ?')
    .get(groupId, targetUserId);
  if (!member || member.role !== 'admin') {
    return res.status(400).json({ error: 'Пользователь не является админом' });
  }

  db.prepare(
    'UPDATE group_members SET role = ? WHERE group_id = ? AND user_id = ?'
  ).run('member', groupId, targetUserId);

  res.json({ ok: true });
});

// ── POST /:id/invite — Generate/regenerate invite link ──

router.post('/:id/invite', (req, res) => {
  const groupId = Number(req.params.id);

  if (!isGroupAdmin(groupId, req.userId)) {
    return res.status(403).json({ error: 'Только админы могут создавать инвайт-ссылки' });
  }

  const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(groupId);
  if (!group) return res.status(404).json({ error: 'Группа не найдена' });

  // Delete existing invite for this group (regenerate)
  db.prepare('DELETE FROM group_invites WHERE group_id = ?').run(groupId);

  const token = crypto.randomBytes(16).toString('hex');
  db.prepare(
    'INSERT INTO group_invites (group_id, token, created_by) VALUES (?, ?, ?)'
  ).run(groupId, token, req.userId);

  res.json({ token, inviteLink: `/api/groups/join/${token}` });
});

// ── GET /join/:token — Join group via invite link ──

router.get('/join/:token', (req, res) => {
  const { token } = req.params;

  const invite = db.prepare('SELECT * FROM group_invites WHERE token = ?').get(token);
  if (!invite) return res.status(404).json({ error: 'Инвайт-ссылка не найдена' });

  if (invite.expires_at && new Date(invite.expires_at).getTime() < Date.now()) {
    return res.status(410).json({ error: 'Инвайт-ссылка истекла' });
  }

  const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(invite.group_id);
  if (!group) return res.status(404).json({ error: 'Группа не найдена' });

  // Check if already a member
  if (isGroupMember(invite.group_id, req.userId)) {
    return res.json({ group: publicGroup(group), alreadyMember: true });
  }

  db.prepare(
    'INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, ?)'
  ).run(invite.group_id, req.userId, 'member');

  res.json({ group: publicGroup(group), alreadyMember: false });
});



// ── PATCH /:id/settings — group permissions/settings ──
router.patch('/:id/settings', (req, res) => {
  const groupId = Number(req.params.id);
  const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(groupId);
  if (!group) return res.status(404).json({ error: 'Группа не найдена' });
  if (!isGroupAdmin(groupId, req.userId)) return res.status(403).json({ error: 'Только админы могут менять настройки' });

  const allowed = ['name', 'description', 'photo_url', 'group_type', 'slow_mode_seconds', 'join_approval_required', 'protected_content', 'permissions_json', 'linked_channel_id', 'accent_color', 'welcome_text', 'theme_json'];
  const sets = [];
  const vals = [];
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      sets.push(`${key} = ?`);
      if (['slow_mode_seconds','join_approval_required','protected_content','linked_channel_id'].includes(key)) vals.push(req.body[key] === null ? null : Number(req.body[key]));
      else vals.push(key === 'permissions_json' && typeof req.body[key] !== 'string' ? JSON.stringify(req.body[key]) : req.body[key]);
    }
  }
  if (sets.length) {
    sets.push("updated_at = datetime('now')");
    db.prepare(`UPDATE groups SET ${sets.join(', ')} WHERE id = ?`).run(...vals, groupId);
    db.prepare('INSERT INTO group_audit_log (group_id, actor_id, action, target_type, target_id, payload_json) VALUES (?, ?, ?, ?, ?, ?)')
      .run(groupId, req.userId, 'settings.updated', 'group', groupId, JSON.stringify(req.body));
  }
  const updated = db.prepare('SELECT * FROM groups WHERE id = ?').get(groupId);
  res.json({ ok: true, group: publicGroup({ ...updated, member_count: db.prepare('SELECT COUNT(*) c FROM group_members WHERE group_id=?').get(groupId).c }) });
});

// ── GET /:id/topics — group topics ──
router.get('/:id/topics', (req, res) => {
  const groupId = Number(req.params.id);
  if (!isGroupMember(groupId, req.userId)) return res.status(403).json({ error: 'Вы не участник этой группы' });
  const topics = db.prepare('SELECT * FROM group_topics WHERE group_id = ? ORDER BY is_closed ASC, created_at ASC').all(groupId);
  res.json({ topics: topics.map(t => ({ id: t.id, groupId: t.group_id, title: t.title, icon: t.icon, isClosed: !!t.is_closed, createdAt: t.created_at })) });
});

// ── POST /:id/topics — create topic ──
router.post('/:id/topics', (req, res) => {
  const groupId = Number(req.params.id);
  const { title, icon } = req.body || {};
  if (!isGroupAdmin(groupId, req.userId)) return res.status(403).json({ error: 'Только админы могут создавать темы' });
  if (!title || !title.trim()) return res.status(400).json({ error: 'Название темы обязательно' });
  const info = db.prepare('INSERT INTO group_topics (group_id, title, icon, created_by) VALUES (?, ?, ?, ?)')
    .run(groupId, title.trim(), icon || null, req.userId);
  const topic = db.prepare('SELECT * FROM group_topics WHERE id = ?').get(info.lastInsertRowid);
  db.prepare('INSERT INTO group_audit_log (group_id, actor_id, action, target_type, target_id, payload_json) VALUES (?, ?, ?, ?, ?, ?)')
    .run(groupId, req.userId, 'topic.created', 'topic', topic.id, JSON.stringify({ title: topic.title, icon: topic.icon }));
  res.status(201).json({ topic: { id: topic.id, groupId: topic.group_id, title: topic.title, icon: topic.icon, isClosed: !!topic.is_closed, createdAt: topic.created_at } });
});

// ── PATCH /:id/topics/:topicId — close/rename topic ──
router.patch('/:id/topics/:topicId', (req, res) => {
  const groupId = Number(req.params.id);
  const topicId = Number(req.params.topicId);
  if (!isGroupAdmin(groupId, req.userId)) return res.status(403).json({ error: 'Только админы могут менять темы' });
  const topic = db.prepare('SELECT * FROM group_topics WHERE id = ? AND group_id = ?').get(topicId, groupId);
  if (!topic) return res.status(404).json({ error: 'Тема не найдена' });
  const sets = [];
  const vals = [];
  if (req.body.title !== undefined) { sets.push('title = ?'); vals.push(String(req.body.title).trim()); }
  if (req.body.icon !== undefined) { sets.push('icon = ?'); vals.push(req.body.icon || null); }
  if (req.body.isClosed !== undefined || req.body.is_closed !== undefined) { sets.push('is_closed = ?'); vals.push((req.body.isClosed ?? req.body.is_closed) ? 1 : 0); }
  if (sets.length) db.prepare(`UPDATE group_topics SET ${sets.join(', ')} WHERE id = ? AND group_id = ?`).run(...vals, topicId, groupId);
  const updated = db.prepare('SELECT * FROM group_topics WHERE id = ?').get(topicId);
  res.json({ ok: true, topic: { id: updated.id, groupId: updated.group_id, title: updated.title, icon: updated.icon, isClosed: !!updated.is_closed, createdAt: updated.created_at } });
});

// ── GET /:id/search-members — search participants ──
router.get('/:id/search-members', (req, res) => {
  const groupId = Number(req.params.id);
  if (!isGroupMember(groupId, req.userId)) return res.status(403).json({ error: 'Вы не участник этой группы' });
  const q = `%${String(req.query.q || '').trim()}%`;
  const members = db.prepare(`SELECT gm.role, gm.joined_at, u.id, u.username, u.nickname, u.avatar_path
    FROM group_members gm JOIN users u ON u.id = gm.user_id
    WHERE gm.group_id = ? AND (? = '%%' OR u.username LIKE ? OR u.nickname LIKE ?)
    ORDER BY CASE gm.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, u.nickname ASC LIMIT 50`).all(groupId, q, q, q);
  res.json({ members: members.map(m => ({ id: m.id, username: m.username, nickname: m.nickname, avatarPath: m.avatar_path, role: m.role, joinedAt: m.joined_at })) });
});

// ── POST /:id/ban/:userId — ban member ──
router.post('/:id/ban/:userId', (req, res) => {
  const groupId = Number(req.params.id);
  const targetUserId = Number(req.params.userId);
  if (!isGroupAdmin(groupId, req.userId)) return res.status(403).json({ error: 'Только админы могут банить' });
  if (isGroupOwner(groupId, targetUserId)) return res.status(403).json({ error: 'Нельзя забанить владельца' });
  const { reason, bannedUntil } = req.body || {};
  db.prepare('INSERT OR REPLACE INTO group_bans (group_id, user_id, banned_by, reason, banned_until) VALUES (?, ?, ?, ?, ?)')
    .run(groupId, targetUserId, req.userId, reason || null, bannedUntil || null);
  db.prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?').run(groupId, targetUserId);
  db.prepare('INSERT INTO group_audit_log (group_id, actor_id, action, target_type, target_id, payload_json) VALUES (?, ?, ?, ?, ?, ?)')
    .run(groupId, req.userId, 'member.banned', 'user', targetUserId, JSON.stringify({ reason, bannedUntil }));
  res.json({ ok: true });
});

// ── DELETE /:id/ban/:userId — unban member ──
router.delete('/:id/ban/:userId', (req, res) => {
  const groupId = Number(req.params.id);
  const targetUserId = Number(req.params.userId);
  if (!isGroupAdmin(groupId, req.userId)) return res.status(403).json({ error: 'Только админы могут разбанивать' });
  db.prepare('DELETE FROM group_bans WHERE group_id = ? AND user_id = ?').run(groupId, targetUserId);
  db.prepare('INSERT INTO group_audit_log (group_id, actor_id, action, target_type, target_id) VALUES (?, ?, ?, ?, ?)')
    .run(groupId, req.userId, 'member.unbanned', 'user', targetUserId);
  res.json({ ok: true });
});

// ── POST /:id/messages/:messageId/pin — pin group message ──
router.post('/:id/messages/:messageId/pin', (req, res) => {
  const groupId = Number(req.params.id);
  const messageId = Number(req.params.messageId);
  if (!isGroupAdmin(groupId, req.userId)) return res.status(403).json({ error: 'Только админы могут закреплять' });
  const msg = db.prepare('SELECT id FROM group_messages WHERE id = ? AND group_id = ?').get(messageId, groupId);
  if (!msg) return res.status(404).json({ error: 'Сообщение не найдено' });
  db.prepare('INSERT OR IGNORE INTO group_pins (group_id, message_id, pinned_by) VALUES (?, ?, ?)').run(groupId, messageId, req.userId);
  res.json({ ok: true });
});

// ── GET /:id/pins — pinned group messages ──
router.get('/:id/pins', (req, res) => {
  const groupId = Number(req.params.id);
  if (!isGroupMember(groupId, req.userId)) return res.status(403).json({ error: 'Вы не участник этой группы' });
  const pins = db.prepare(`SELECT gp.pinned_at, gm.*, u.username sender_username, u.nickname sender_nickname
    FROM group_pins gp JOIN group_messages gm ON gm.id = gp.message_id JOIN users u ON u.id = gm.sender_id
    WHERE gp.group_id = ? ORDER BY gp.pinned_at DESC`).all(groupId);
  res.json({ pins });
});

// ── GET /:id/audit — group action history ──
router.get('/:id/audit', (req, res) => {
  const groupId = Number(req.params.id);
  if (!isGroupAdmin(groupId, req.userId)) return res.status(403).json({ error: 'Только админы видят журнал' });
  const events = db.prepare(`SELECT gl.*, u.username actor_username, u.nickname actor_nickname
    FROM group_audit_log gl JOIN users u ON u.id = gl.actor_id
    WHERE gl.group_id = ? ORDER BY gl.created_at DESC LIMIT 100`).all(groupId);
  res.json({ events: events.map(e => ({ ...e, payload: e.payload_json ? JSON.parse(e.payload_json) : null })) });
});

// ── DELETE /:id — Delete group (owner only) ──

router.delete('/:id', (req, res) => {
  const groupId = Number(req.params.id);

  if (!isGroupOwner(groupId, req.userId)) {
    return res.status(403).json({ error: 'Только владелец может удалить группу' });
  }

  const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(groupId);
  if (!group) return res.status(404).json({ error: 'Группа не найдена' });

  // Delete messages, invites, members, then the group itself
  db.prepare('DELETE FROM group_messages WHERE group_id = ?').run(groupId);
  db.prepare('DELETE FROM group_invites WHERE group_id = ?').run(groupId);
  db.prepare('DELETE FROM group_members WHERE group_id = ?').run(groupId);
  db.prepare('DELETE FROM groups WHERE id = ?').run(groupId);

  res.json({ ok: true });
});

module.exports = router;