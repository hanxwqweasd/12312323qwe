// src/routes/bots.js
// Telegram-like Bot API core: bot creation, token issuing/rotation,
// /start and /help commands, command menu, webhooks, getUpdates,
// inline keyboard payloads, callbacks, mini-app URL and group rights.

const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { sha256, token, json, safeJsonParse, parsePaging } = require('../utils/format');
const { isUsernameAvailable } = require('./auth');

const router = express.Router();
const USERNAME_RE = /^[a-zA-Z0-9_]{4,30}$/;

function issueToken(botUsername) {
  return `${botUsername}:${token(32)}`;
}

function publicBot(row, includeToken = false, plainToken = null) {
  return {
    id: row.id,
    username: row.username,
    name: row.name,
    description: row.description,
    about: row.about,
    avatarUrl: row.avatar_path ? `/avatars/${row.avatar_path}` : null,
    ownerId: row.owner_id,
    tokenPreview: row.token_preview,
    token: includeToken ? plainToken : undefined,
    webhookUrl: row.webhook_url,
    inlineMode: Boolean(row.inline_mode),
    canJoinGroups: Boolean(row.can_join_groups),
    canReadAllGroupMessages: Boolean(row.can_read_all_group_messages),
    paymentsEnabled: Boolean(row.payments_enabled),
    miniAppUrl: row.mini_app_url,
    isSupportBot: Boolean(row.is_support_bot),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function botFromToken(rawToken) {
  const hash = sha256(rawToken || '');
  return db.prepare('SELECT * FROM bots WHERE token_hash = ?').get(hash);
}

function enqueueUpdate(botId, type, payload) {
  const info = db.prepare('INSERT INTO bot_updates (bot_id, update_type, payload_json) VALUES (?, ?, ?)').run(botId, type, json(payload));
  return info.lastInsertRowid;
}

router.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  return requireAuth(req, res, next);
});

// BotFather-like catalog for the current user.
router.get('/', (req, res) => {
  const bots = db.prepare('SELECT * FROM bots WHERE owner_id = ? ORDER BY created_at DESC').all(req.userId);
  res.json({ bots: bots.map((b) => publicBot(b)) });
});

router.post('/', (req, res) => {
  const { username, name, description, about, inlineMode, miniAppUrl, isSupportBot } = req.body || {};
  if (!USERNAME_RE.test(username || '')) return res.status(400).json({ error: 'Username бота: 4-30 символов, латиница/цифры/_' });
  if (!String(username).toLowerCase().endsWith('bot')) return res.status(400).json({ error: 'Username бота должен заканчиваться на bot' });
  if (!isUsernameAvailable(username, null)) return res.status(409).json({ error: 'Username уже занят пользователем/каналом/группой' });
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Имя бота обязательно' });
  const rawToken = issueToken(username);
  const info = db.prepare(`INSERT INTO bots (owner_id, username, name, description, about, token_hash, token_preview, inline_mode, mini_app_url, is_support_bot)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(req.userId, username, String(name).trim(), description || null, about || null, sha256(rawToken), `${username}:••••${rawToken.slice(-6)}`, inlineMode ? 1 : 0, miniAppUrl || null, isSupportBot ? 1 : 0);
  db.prepare('INSERT OR IGNORE INTO bot_commands (bot_id, command, description) VALUES (?, ?, ?)').run(info.lastInsertRowid, 'start', 'Запустить бота');
  db.prepare('INSERT OR IGNORE INTO bot_commands (bot_id, command, description) VALUES (?, ?, ?)').run(info.lastInsertRowid, 'help', 'Помощь');
  const bot = db.prepare('SELECT * FROM bots WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ bot: publicBot(bot, true, rawToken) });
});

router.post('/:id/token/rotate', (req, res) => {
  const bot = db.prepare('SELECT * FROM bots WHERE id = ? AND owner_id = ?').get(Number(req.params.id), req.userId);
  if (!bot) return res.status(404).json({ error: 'Бот не найден' });
  const rawToken = issueToken(bot.username);
  db.prepare('UPDATE bots SET token_hash = ?, token_preview = ?, updated_at = datetime(\'now\') WHERE id = ?').run(sha256(rawToken), `${bot.username}:••••${rawToken.slice(-6)}`, bot.id);
  res.json({ token: rawToken, tokenPreview: `${bot.username}:••••${rawToken.slice(-6)}` });
});

router.patch('/:id', (req, res) => {
  const bot = db.prepare('SELECT * FROM bots WHERE id = ? AND owner_id = ?').get(Number(req.params.id), req.userId);
  if (!bot) return res.status(404).json({ error: 'Бот не найден' });
  const fields = { name: 'name', description: 'description', about: 'about', inlineMode: 'inline_mode', canJoinGroups: 'can_join_groups', canReadAllGroupMessages: 'can_read_all_group_messages', paymentsEnabled: 'payments_enabled', miniAppUrl: 'mini_app_url' };
  const sets = [], vals = [];
  for (const [input, column] of Object.entries(fields)) {
    if (req.body[input] === undefined) continue;
    let value = req.body[input];
    if (['inlineMode','canJoinGroups','canReadAllGroupMessages','paymentsEnabled'].includes(input)) value = value ? 1 : 0;
    sets.push(`${column} = ?`); vals.push(value ?? null);
  }
  if (!sets.length) return res.status(400).json({ error: 'Нет изменений' });
  sets.push('updated_at = datetime(\'now\')'); vals.push(bot.id);
  db.prepare(`UPDATE bots SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  res.json({ bot: publicBot(db.prepare('SELECT * FROM bots WHERE id = ?').get(bot.id)) });
});

router.delete('/:id', (req, res) => {
  const bot = db.prepare('SELECT * FROM bots WHERE id = ? AND owner_id = ?').get(Number(req.params.id), req.userId);
  if (!bot) return res.status(404).json({ error: 'Бот не найден' });
  db.prepare('DELETE FROM bot_updates WHERE bot_id = ?').run(bot.id);
  db.prepare('DELETE FROM bot_commands WHERE bot_id = ?').run(bot.id);
  db.prepare('DELETE FROM bots WHERE id = ?').run(bot.id);
  res.json({ ok: true });
});

router.get('/:id/commands', (req, res) => {
  const bot = db.prepare('SELECT * FROM bots WHERE id = ? AND owner_id = ?').get(Number(req.params.id), req.userId);
  if (!bot) return res.status(404).json({ error: 'Бот не найден' });
  const commands = db.prepare('SELECT * FROM bot_commands WHERE bot_id = ? ORDER BY command').all(bot.id);
  res.json({ commands });
});

router.put('/:id/commands', (req, res) => {
  const bot = db.prepare('SELECT * FROM bots WHERE id = ? AND owner_id = ?').get(Number(req.params.id), req.userId);
  if (!bot) return res.status(404).json({ error: 'Бот не найден' });
  const commands = Array.isArray(req.body?.commands) ? req.body.commands : [];
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM bot_commands WHERE bot_id = ?').run(bot.id);
    for (const c of commands) {
      if (!c.command || !c.description) continue;
      db.prepare('INSERT OR IGNORE INTO bot_commands (bot_id, command, description, scope) VALUES (?, ?, ?, ?)').run(bot.id, String(c.command).replace(/^\//, ''), String(c.description), c.scope || 'default');
    }
  });
  tx();
  res.json({ ok: true, commands: db.prepare('SELECT * FROM bot_commands WHERE bot_id = ? ORDER BY command').all(bot.id) });
});

router.post('/:id/webhook', (req, res) => {
  const bot = db.prepare('SELECT * FROM bots WHERE id = ? AND owner_id = ?').get(Number(req.params.id), req.userId);
  if (!bot) return res.status(404).json({ error: 'Бот не найден' });
  const { url, secret } = req.body || {};
  db.prepare('UPDATE bots SET webhook_url = ?, webhook_secret = ?, updated_at = datetime(\'now\') WHERE id = ?').run(url || null, secret || null, bot.id);
  res.json({ ok: true });
});

router.post('/:id/group-rights/:groupId', (req, res) => {
  const bot = db.prepare('SELECT * FROM bots WHERE id = ? AND owner_id = ?').get(Number(req.params.id), req.userId);
  if (!bot) return res.status(404).json({ error: 'Бот не найден' });
  const groupId = Number(req.params.groupId);
  const rights = req.body || {};
  db.prepare(`INSERT OR REPLACE INTO bot_group_rights (bot_id, group_id, can_delete_messages, can_ban_users, can_pin_messages, can_manage_topics)
    VALUES (?, ?, ?, ?, ?, ?)`).run(bot.id, groupId, rights.canDeleteMessages ? 1 : 0, rights.canBanUsers ? 1 : 0, rights.canPinMessages ? 1 : 0, rights.canManageTopics ? 1 : 0);
  res.json({ ok: true });
});

// Simulate user message to bot for local testing and support bot flow.
router.post('/:id/incoming', (req, res) => {
  const bot = db.prepare('SELECT * FROM bots WHERE id = ?').get(Number(req.params.id));
  if (!bot) return res.status(404).json({ error: 'Бот не найден' });
  const { text, chatId, payload } = req.body || {};
  const update = { message: { chat: { id: chatId || req.userId, type: 'private' }, from: { id: req.userId }, text: text || '' }, payload };
  const updateId = enqueueUpdate(bot.id, 'message', update);
  res.status(201).json({ ok: true, updateId });
});

// Token API — Telegram-like surface.
router.post('/api/:token/sendMessage', express.json(), (req, res) => {
  const bot = botFromToken(req.params.token);
  if (!bot) return res.status(401).json({ ok: false, description: 'Unauthorized' });
  const { chat_id, text, reply_markup } = req.body || {};
  const payload = { chat_id, text, reply_markup, bot: { id: bot.id, username: bot.username }, date: Math.floor(Date.now() / 1000) };
  enqueueUpdate(bot.id, 'outgoing_message', payload);
  res.json({ ok: true, result: { message_id: Date.now(), chat: { id: chat_id }, text, reply_markup } });
});

router.get('/api/:token/getUpdates', (req, res) => {
  const bot = botFromToken(req.params.token);
  if (!bot) return res.status(401).json({ ok: false, description: 'Unauthorized' });
  const offset = Number(req.query.offset || 0);
  const { limit } = parsePaging(req, 100);
  const rows = db.prepare('SELECT * FROM bot_updates WHERE bot_id = ? AND id > ? ORDER BY id ASC LIMIT ?').all(bot.id, offset, limit);
  res.json({ ok: true, result: rows.map((u) => ({ update_id: u.id, [u.update_type]: safeJsonParse(u.payload_json, {}) })) });
});

router.post('/api/:token/setWebhook', express.json(), (req, res) => {
  const bot = botFromToken(req.params.token);
  if (!bot) return res.status(401).json({ ok: false, description: 'Unauthorized' });
  db.prepare('UPDATE bots SET webhook_url = ?, webhook_secret = ?, updated_at = datetime(\'now\') WHERE id = ?').run(req.body?.url || null, req.body?.secret_token || null, bot.id);
  res.json({ ok: true, result: true });
});

router.get('/api/:token/getMe', (req, res) => {
  const bot = botFromToken(req.params.token);
  if (!bot) return res.status(401).json({ ok: false, description: 'Unauthorized' });
  res.json({ ok: true, result: { id: bot.id, is_bot: true, username: bot.username, first_name: bot.name, can_join_groups: Boolean(bot.can_join_groups), supports_inline_queries: Boolean(bot.inline_mode) } });
});

router.post('/api/:token/answerCallbackQuery', express.json(), (req, res) => {
  const bot = botFromToken(req.params.token);
  if (!bot) return res.status(401).json({ ok: false, description: 'Unauthorized' });
  res.json({ ok: true, result: true });
});

router.post('/api/:token/answerInlineQuery', express.json(), (req, res) => {
  const bot = botFromToken(req.params.token);
  if (!bot || !bot.inline_mode) return res.status(401).json({ ok: false, description: 'Unauthorized or inline disabled' });
  res.json({ ok: true, result: true });
});


router.get('/support/virtual', (req, res) => {
  res.json({ bot: { id: 'nyx-support', username: 'nyx_support_bot', name: 'Nyx Support', description: 'Официальный бот поддержки Nyx', isSupportBot: true, commands: [{ command: 'start', description: 'Начать диалог' }, { command: 'help', description: 'Помощь' }] } });
});

router.post('/support/message', (req, res) => {
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Пустое сообщение' });
  const answer = text.startsWith('/help')
    ? 'Я помогу с аккаунтом, каналами, ботами, приватностью и сборкой приложения. Опишите проблему одним сообщением.'
    : text.startsWith('/start')
      ? 'Привет. Это Nyx Support. Напишите, что нужно исправить или настроить.'
      : 'Принял. Для полноценного support desk подключите webhook/CRM, этот ответ создан локальным support-ботом.';
  res.json({ ok: true, reply: { from: 'nyx_support_bot', text: answer, createdAt: new Date().toISOString() } });
});

module.exports = router;
