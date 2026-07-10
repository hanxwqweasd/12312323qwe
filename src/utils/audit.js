const db = require('../db');
const { json } = require('./format');

function logChannel(channelId, actorId, action, targetType = null, targetId = null, payload = null) {
  try {
    db.prepare(`INSERT INTO channel_audit_log (channel_id, actor_id, action, target_type, target_id, payload_json)
      VALUES (?, ?, ?, ?, ?, ?)`).run(channelId, actorId, action, targetType, targetId, payload ? json(payload) : null);
  } catch (e) {}
}

function logGroup(groupId, actorId, action, targetType = null, targetId = null, payload = null) {
  try {
    db.prepare(`INSERT INTO group_audit_log (group_id, actor_id, action, target_type, target_id, payload_json)
      VALUES (?, ?, ?, ?, ?, ?)`).run(groupId, actorId, action, targetType, targetId, payload ? json(payload) : null);
  } catch (e) {}
}

module.exports = { logChannel, logGroup };
