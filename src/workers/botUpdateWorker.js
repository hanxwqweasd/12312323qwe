require('dotenv').config();
const db = require('../db');
const { logger } = require('../infra/logger');
const { createWorker, queueNames } = require('../infra/queues');

async function deliverBotUpdate(job) {
  const { updateId, botId } = job.data || {};
  const bot = db.prepare('SELECT * FROM bots WHERE id = ?').get(botId);
  const update = db.prepare('SELECT * FROM bot_updates WHERE id = ? AND bot_id = ?').get(updateId, botId);
  if (!bot || !update) return { ok: false, reason: 'missing_bot_or_update' };
  if (!bot.webhook_url) return { ok: false, reason: 'no_webhook' };
  const payload = JSON.parse(update.payload_json || '{}');
  const response = await fetch(bot.webhook_url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Nyx-Bot-Secret': bot.webhook_secret || '' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`Webhook failed ${response.status}`);
  db.prepare('UPDATE bot_updates SET delivered = 1 WHERE id = ?').run(update.id);
  return { ok: true, status: response.status };
}

if (require.main === module) {
  const worker = createWorker(queueNames.botUpdates, deliverBotUpdate, { concurrency: 5 });
  if (!worker) {
    logger.warn('Bot update worker not started: Redis/BullMQ disabled.');
    process.exit(0);
  }
  logger.info('Nyx bot update worker started');
}

module.exports = { deliverBotUpdate };
