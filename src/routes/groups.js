// src/routes/groups.js
//
// Группы NYX — многосторонние чаты с поддержкой админов,
// инвайт-ссылок и управления участниками.

const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { isUsernameAvailable } = require('./auth');

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