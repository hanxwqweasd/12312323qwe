const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { json } = require('../utils/format');
const { addJob, queueNames } = require('../infra/queues');

const router = express.Router();
router.use(requireAuth);

router.post('/dialog', async (req, res) => {
  const { text } = req.body || {};
  const input = String(text || '').trim();
  let reply = 'Напиши /newbot, /mybots, /setcommands, /setwebhook или /help.';
  if (input === '/start' || input === '/help') reply = 'Я Nyx BotFather. Создаю ботов, токены, команды, webhook, inline-кнопки и Mini Apps.';
  if (input === '/mybots') {
    const bots = db.prepare('SELECT id, username, name, token_preview FROM bots WHERE owner_id = ? ORDER BY created_at DESC').all(req.userId);
    return res.json({ reply: bots.length ? 'Твои боты:' : 'Ботов пока нет.', bots, actions: ['newbot', 'setcommands', 'setwebhook'] });
  }
  if (input === '/newbot') reply = 'Открой форму создания бота: укажи username с окончанием bot, имя, описание и Mini App URL.';
  res.json({ reply, actions: ['newbot', 'mybots', 'setcommands', 'setwebhook', 'sandbox'] });
});

router.post('/inline-keyboard/preview', (req, res) => {
  const { rows = [] } = req.body || {};
  const keyboard = rows.map((row) => row.map((btn) => ({ text: btn.text || 'Button', callback_data: btn.callbackData || btn.callback_data || null, url: btn.url || null, web_app: btn.webAppUrl ? { url: btn.webAppUrl } : undefined })));
  res.json({ reply_markup: { inline_keyboard: keyboard } });
});

router.post('/callback-test', async (req, res) => {
  const { botId, callbackData = 'demo_callback' } = req.body || {};
  if (!botId) return res.status(400).json({ error: 'botId обязателен' });
  const bot = db.prepare('SELECT * FROM bots WHERE id = ? AND owner_id = ?').get(Number(botId), req.userId);
  if (!bot) return res.status(404).json({ error: 'Бот не найден' });
  const info = db.prepare('INSERT INTO bot_updates (bot_id, update_type, payload_json) VALUES (?, ?, ?)').run(bot.id, 'callback_query', json({ callback_query: { id: `cb_${Date.now()}`, data: callbackData, from: { id: req.userId } } }));
  await addJob(queueNames.botUpdates, 'deliver-callback', { botId: bot.id, updateId: info.lastInsertRowid });
  res.json({ ok: true, updateId: info.lastInsertRowid });
});

router.get('/docs', (req, res) => {
  res.json({
    title: 'Nyx Bot API',
    endpoints: [
      'POST /bots - create bot',
      'POST /bots/:id/token/rotate - rotate token',
      'PUT /bots/:id/commands - set commands',
      'POST /bots/:id/webhook - set webhook',
      'GET /bots/api/:token/getUpdates - poll updates',
      'POST /botfather/inline-keyboard/preview - build inline keyboard',
    ],
  });
});

module.exports = router;
