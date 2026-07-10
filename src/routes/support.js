const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { json, safeJsonParse, parsePaging } = require('../utils/format');
const { ADMIN_USERNAME, isNyxAdmin } = require('../utils/admin');

const router = express.Router();
router.use(requireAuth);

function formatTicket(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    username: row.username,
    nickname: row.nickname,
    assignedTo: row.assigned_to_username,
    subject: row.subject,
    status: row.status,
    priority: row.priority,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function canViewTicket(req, ticket) {
  return ticket.user_id === req.userId || isNyxAdmin(req);
}

router.post('/tickets', (req, res) => {
  const text = String(req.body?.text || req.body?.message || '').trim();
  const subject = String(req.body?.subject || 'Обращение в поддержку').trim().slice(0, 120);
  const priority = ['low','normal','high','urgent'].includes(req.body?.priority) ? req.body.priority : 'normal';
  const source = String(req.body?.source || 'app').slice(0, 80);
  const attachments = Array.isArray(req.body?.attachments) ? req.body.attachments : [];
  if (!text) return res.status(400).json({ error: 'Опишите проблему' });
  const info = db.prepare(`INSERT INTO support_tickets (user_id, assigned_to_username, subject, priority, source)
    VALUES (?, ?, ?, ?, ?)`).run(req.userId, ADMIN_USERNAME, subject, priority, source);
  db.prepare(`INSERT INTO support_messages (ticket_id, sender_id, sender_username, text, attachments_json)
    VALUES (?, ?, ?, ?, ?)`).run(info.lastInsertRowid, req.userId, req.username, text, json(attachments));
  const ticket = db.prepare(`SELECT t.*, u.username, u.nickname FROM support_tickets t JOIN users u ON u.id = t.user_id WHERE t.id = ?`).get(info.lastInsertRowid);
  const io = req.app.get('io');
  if (io) io.to(`user:${ADMIN_USERNAME}`).emit('support:ticket:new', { ticket: formatTicket(ticket) });
  res.status(201).json({ ok: true, ticket: formatTicket(ticket) });
});

router.get('/tickets', (req, res) => {
  const { limit, offset } = parsePaging(req, 100);
  const rows = isNyxAdmin(req)
    ? db.prepare(`SELECT t.*, u.username, u.nickname FROM support_tickets t JOIN users u ON u.id = t.user_id ORDER BY t.updated_at DESC LIMIT ? OFFSET ?`).all(limit, offset)
    : db.prepare(`SELECT t.*, u.username, u.nickname FROM support_tickets t JOIN users u ON u.id = t.user_id WHERE t.user_id = ? ORDER BY t.updated_at DESC LIMIT ? OFFSET ?`).all(req.userId, limit, offset);
  res.json({ tickets: rows.map(formatTicket) });
});

router.get('/tickets/:id', (req, res) => {
  const ticket = db.prepare(`SELECT t.*, u.username, u.nickname FROM support_tickets t JOIN users u ON u.id = t.user_id WHERE t.id = ?`).get(Number(req.params.id));
  if (!ticket) return res.status(404).json({ error: 'Обращение не найдено' });
  if (!canViewTicket(req, ticket)) return res.status(403).json({ error: 'Нет доступа' });
  const messages = db.prepare('SELECT * FROM support_messages WHERE ticket_id = ? ORDER BY created_at ASC').all(ticket.id)
    .map((m) => ({ ...m, attachments: safeJsonParse(m.attachments_json, []) }));
  res.json({ ticket: formatTicket(ticket), messages });
});

router.post('/tickets/:id/messages', (req, res) => {
  const ticket = db.prepare('SELECT * FROM support_tickets WHERE id = ?').get(Number(req.params.id));
  if (!ticket) return res.status(404).json({ error: 'Обращение не найдено' });
  if (!canViewTicket(req, ticket)) return res.status(403).json({ error: 'Нет доступа' });
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Пустое сообщение' });
  const attachments = Array.isArray(req.body?.attachments) ? req.body.attachments : [];
  const status = isNyxAdmin(req) ? (req.body?.status || ticket.status) : ticket.status;
  const info = db.prepare(`INSERT INTO support_messages (ticket_id, sender_id, sender_username, text, attachments_json)
    VALUES (?, ?, ?, ?, ?)`).run(ticket.id, req.userId, req.username, text, json(attachments));
  db.prepare('UPDATE support_tickets SET status = ?, updated_at = datetime(\'now\') WHERE id = ?').run(status, ticket.id);
  res.status(201).json({ ok: true, messageId: info.lastInsertRowid });
});

router.patch('/tickets/:id', (req, res) => {
  if (!isNyxAdmin(req)) return res.status(403).json({ error: 'Доступ только для NyxDev' });
  const ticket = db.prepare('SELECT * FROM support_tickets WHERE id = ?').get(Number(req.params.id));
  if (!ticket) return res.status(404).json({ error: 'Обращение не найдено' });
  const status = ['open','pending','closed'].includes(req.body?.status) ? req.body.status : ticket.status;
  const priority = ['low','normal','high','urgent'].includes(req.body?.priority) ? req.body.priority : ticket.priority;
  db.prepare('UPDATE support_tickets SET status = ?, priority = ?, updated_at = datetime(\'now\') WHERE id = ?').run(status, priority, ticket.id);
  res.json({ ok: true });
});

module.exports = router;
