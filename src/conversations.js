// src/conversations.js
const db = require('./db');

/**
 * Разговор всегда хранится с userAId < userBId (нормализация порядка),
 * чтобы UNIQUE(user_a_id, user_b_id) гарантировал ровно одну запись на пару.
 */
function getOrCreateConversation(idA, idB) {
  const [userAId, userBId] = idA < idB ? [idA, idB] : [idB, idA];

  const existing = db
    .prepare('SELECT * FROM conversations WHERE user_a_id = ? AND user_b_id = ?')
    .get(userAId, userBId);
  if (existing) return existing;

  const info = db
    .prepare('INSERT INTO conversations (user_a_id, user_b_id) VALUES (?, ?)')
    .run(userAId, userBId);

  return db.prepare('SELECT * FROM conversations WHERE id = ?').get(info.lastInsertRowid);
}

function otherParticipantId(conversation, myId) {
  return conversation.user_a_id === myId ? conversation.user_b_id : conversation.user_a_id;
}

module.exports = { getOrCreateConversation, otherParticipantId };
