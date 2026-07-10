// src/routes/marketplace.js
//
// Маркетплейс юзернеймов. Баланс NYX здесь — СЕРВЕРНЫЙ (колонка
// users.nyx_balance), не путать с клиентским useWalletStore (тот отдельный,
// демонстрационный, для рекламы/стейкинга). Здесь баланс — единственный
// источник правды, потому что сделка происходит МЕЖДУ двумя реальными
// аккаунтами и должна быть согласованной для обоих.
//
// Каждому новому пользователю при регистрации начисляется 1000 NYX
// (см. db.js) — это тестовый стартовый баланс, НЕ настоящая платёжная
// система. Реального ввода/вывода денег здесь нет.

const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const USERNAME_RE = /^[a-zA-Z0-9_]{4,30}$/;

router.get('/listings', (req, res) => {
  const listings = db
    .prepare(
      `SELECT l.*, u.username as seller_username, u.nickname as seller_nickname
       FROM username_listings l
       JOIN users u ON u.id = l.seller_id
       WHERE l.status = 'active'
       ORDER BY l.created_at DESC`
    )
    .all();

  res.json({
    listings: listings.map((l) => ({
      id: l.id,
      username: l.listed_username,
      price: l.price,
      seller: { username: l.seller_username, nickname: l.seller_nickname },
      isMine: l.seller_id === req.userId,
      createdAt: l.created_at,
    })),
  });
});

router.post('/listings', (req, res) => {
  const { username, price } = req.body || {};

  if (!USERNAME_RE.test(username || '')) {
    return res.status(400).json({ error: 'Username: 4-30 символов, латиница/цифры/"_"' });
  }
  if (!Number.isInteger(price) || price <= 0) {
    return res.status(400).json({ error: 'Цена должна быть положительным целым числом NYX' });
  }

  const takenByActiveUser = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (takenByActiveUser) {
    return res.status(409).json({ error: 'Этот username уже чей-то активный логин, его нельзя выставить на продажу' });
  }

  try {
    const info = db
      .prepare('INSERT INTO username_listings (seller_id, listed_username, price) VALUES (?, ?, ?)')
      .run(req.userId, username, price);
    res.status(201).json({ listingId: info.lastInsertRowid });
  } catch (e) {
    if (/UNIQUE/.test(e.message)) {
      return res.status(409).json({ error: 'Этот username уже выставлен на продажу другим пользователем' });
    }
    throw e;
  }
});

router.delete('/listings/:id', (req, res) => {
  const listing = db.prepare('SELECT * FROM username_listings WHERE id = ?').get(req.params.id);
  if (!listing) return res.status(404).json({ error: 'Листинг не найден' });
  if (listing.seller_id !== req.userId) return res.status(403).json({ error: 'Это не ваш листинг' });

  db.prepare("UPDATE username_listings SET status = 'cancelled' WHERE id = ?").run(listing.id);
  res.json({ ok: true });
});

/** Покупка: атомарно переводит username и NYX между покупателем и продавцом. */
router.post('/listings/:id/buy', (req, res) => {
  const listingId = Number(req.params.id);

  const buyTransaction = db.transaction(() => {
    const listing = db.prepare("SELECT * FROM username_listings WHERE id = ? AND status = 'active'").get(listingId);
    if (!listing) throw { status: 404, message: 'Листинг не найден или уже продан' };

    if (listing.seller_id === req.userId) {
      throw { status: 400, message: 'Нельзя купить свой же листинг' };
    }

    const buyer = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
    if (buyer.nyx_balance < listing.price) {
      throw { status: 400, message: 'Недостаточно NYX на балансе' };
    }

    // Повторная проверка прямо перед покупкой — вдруг кто-то успел занять
    // этот username активным логином за время между листингом и покупкой.
    const stillFree = !db.prepare('SELECT id FROM users WHERE username = ?').get(listing.listed_username);
    if (!stillFree) {
      db.prepare("UPDATE username_listings SET status = 'cancelled' WHERE id = ?").run(listing.id);
      throw { status: 409, message: 'Этот username только что стал чьим-то активным логином' };
    }

    const oldUsername = buyer.username;

    db.prepare('UPDATE users SET username = ?, nyx_balance = nyx_balance - ? WHERE id = ?').run(
      listing.listed_username,
      listing.price,
      req.userId
    );
    db.prepare('UPDATE users SET nyx_balance = nyx_balance + ? WHERE id = ?').run(listing.price, listing.seller_id);
    db.prepare("UPDATE username_listings SET status = 'sold' WHERE id = ?").run(listing.id);

    return { newUsername: listing.listed_username, oldUsername };
  });

  try {
    const result = buyTransaction();
    res.json({ ok: true, ...result });
  } catch (e) {
    const status = e.status || 500;
    res.status(status).json({ error: e.message || 'Внутренняя ошибка сервера' });
  }
});

module.exports = router;
