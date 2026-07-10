const db = require('../db');

function channelRole(channelId, userId) {
  const owner = db.prepare('SELECT owner_id FROM channels WHERE id = ? AND is_deleted = 0').get(channelId);
  if (!owner) return null;
  if (owner.owner_id === userId) return 'owner';
  const admin = db.prepare('SELECT role FROM channel_admins WHERE channel_id = ? AND user_id = ?').get(channelId, userId);
  if (admin) return admin.role || 'admin';
  const sub = db.prepare('SELECT 1 FROM channel_subscriptions WHERE channel_id = ? AND user_id = ?').get(channelId, userId);
  return sub ? 'subscriber' : null;
}

function isChannelAdmin(channelId, userId) {
  const role = channelRole(channelId, userId);
  return role === 'owner' || role === 'admin';
}

function canManageChannel(channelId, userId, right = 'can_manage_settings') {
  const role = channelRole(channelId, userId);
  if (role === 'owner') return true;
  if (role !== 'admin') return false;
  const rights = db.prepare(`SELECT * FROM channel_admin_rights WHERE channel_id = ? AND user_id = ?`).get(channelId, userId);
  if (!rights) return ['can_post','can_edit','can_delete'].includes(right);
  return Boolean(rights[right]);
}

function canPostToChannel(channelId, userId) {
  if (canManageChannel(channelId, userId, 'can_post')) return true;
  const ch = db.prepare('SELECT only_admins_post FROM channels WHERE id = ?').get(channelId);
  if (!ch) return false;
  if (ch.only_admins_post) return false;
  return Boolean(db.prepare('SELECT 1 FROM channel_subscriptions WHERE channel_id = ? AND user_id = ?').get(channelId, userId));
}

function isChannelBanned(channelId, userId) {
  const ban = db.prepare('SELECT * FROM channel_bans WHERE channel_id = ? AND user_id = ?').get(channelId, userId);
  if (!ban) return false;
  if (ban.banned_until && new Date(ban.banned_until).getTime() < Date.now()) {
    db.prepare('DELETE FROM channel_bans WHERE channel_id = ? AND user_id = ?').run(channelId, userId);
    return false;
  }
  return true;
}

function groupRole(groupId, userId) {
  const row = db.prepare('SELECT role FROM group_members WHERE group_id = ? AND user_id = ?').get(groupId, userId);
  return row?.role || null;
}

function isGroupMember(groupId, userId) { return Boolean(groupRole(groupId, userId)); }
function isGroupAdmin(groupId, userId) { const role = groupRole(groupId, userId); return role === 'owner' || role === 'admin'; }
function isGroupOwner(groupId, userId) { return groupRole(groupId, userId) === 'owner'; }

function isGroupBanned(groupId, userId) {
  const ban = db.prepare('SELECT * FROM group_bans WHERE group_id = ? AND user_id = ?').get(groupId, userId);
  if (!ban) return false;
  if (ban.banned_until && new Date(ban.banned_until).getTime() < Date.now()) {
    db.prepare('DELETE FROM group_bans WHERE group_id = ? AND user_id = ?').run(groupId, userId);
    return false;
  }
  return true;
}

function isGroupMuted(groupId, userId) {
  const mute = db.prepare('SELECT * FROM group_mutes WHERE group_id = ? AND user_id = ?').get(groupId, userId);
  if (!mute) return false;
  if (mute.muted_until && new Date(mute.muted_until).getTime() < Date.now()) {
    db.prepare('DELETE FROM group_mutes WHERE group_id = ? AND user_id = ?').run(groupId, userId);
    return false;
  }
  return true;
}

module.exports = {
  channelRole,
  isChannelAdmin,
  canManageChannel,
  canPostToChannel,
  isChannelBanned,
  groupRole,
  isGroupMember,
  isGroupAdmin,
  isGroupOwner,
  isGroupBanned,
  isGroupMuted,
};
