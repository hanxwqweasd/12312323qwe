require('dotenv').config();
const db = require('../db');
const { logger, optionalRequire } = require('../infra/logger');
const { createWorker, queueNames } = require('../infra/queues');

const Expo = optionalRequire('expo-server-sdk')?.Expo;
const expo = Expo ? new Expo({ accessToken: process.env.EXPO_ACCESS_TOKEN }) : null;

function isMuted(userId, scopeType, scopeId) {
  const row = db.prepare(`SELECT * FROM notification_settings WHERE user_id = ? AND scope_type = ? AND scope_id = ?`).get(userId, scopeType, String(scopeId));
  if (!row?.muted_until) return false;
  return new Date(row.muted_until).getTime() > Date.now();
}

async function sendExpo(tokens, payload) {
  if (!expo) return { sent: 0, skipped: tokens.length, reason: 'expo-server-sdk-not-installed' };
  const messages = tokens.filter((t) => Expo.isExpoPushToken(t)).map((to) => ({
    to,
    sound: payload.silent ? null : 'default',
    title: payload.title,
    body: payload.body,
    data: payload.data || {},
    badge: payload.badge,
    priority: payload.silent ? 'normal' : 'high',
    _contentAvailable: Boolean(payload.silent),
  }));
  const chunks = expo.chunkPushNotifications(messages);
  let sent = 0;
  for (const chunk of chunks) {
    await expo.sendPushNotificationsAsync(chunk);
    sent += chunk.length;
  }
  return { sent, skipped: tokens.length - sent };
}

async function processPushJob(job) {
  const { userId, scopeType = 'global', scopeId = 'global', title, body, data, silent, badge } = job.data || {};
  if (!userId) return { sent: 0, reason: 'missing_user' };
  if (isMuted(userId, scopeType, scopeId)) return { sent: 0, reason: 'muted' };
  const rows = db.prepare('SELECT token FROM push_tokens WHERE user_id = ?').all(userId);
  const tokens = rows.map((r) => r.token);
  if (!tokens.length) return { sent: 0, reason: 'no_tokens' };
  return sendExpo(tokens, { title, body, data, silent, badge });
}

if (require.main === module) {
  const worker = createWorker(queueNames.push, processPushJob, { concurrency: process.env.PUSH_WORKER_CONCURRENCY || 10 });
  if (!worker) {
    logger.warn('Push worker not started: Redis/BullMQ disabled. Set REDIS_URL and install dependencies.');
    process.exit(0);
  }
  logger.info('Nyx push worker started');
}

module.exports = { processPushJob };
