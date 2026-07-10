const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { safeJsonParse } = require('../utils/format');
const router = express.Router();
router.use(requireAuth);

router.get('/products', (req, res) => {
  const products = db.prepare('SELECT * FROM premium_products ORDER BY price_nyx ASC').all();
  res.json({ products: products.map((p) => ({ ...p, payload: safeJsonParse(p.payload_json, {}) })) });
});

router.post('/purchase/:productId', (req, res) => {
  const product = db.prepare('SELECT * FROM premium_products WHERE id = ?').get(req.params.productId);
  if (!product) return res.status(404).json({ error: 'Продукт не найден' });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  if (user.nyx_balance < product.price_nyx) return res.status(400).json({ error: 'Недостаточно NYX' });
  const tx = db.transaction(() => {
    db.prepare('UPDATE users SET nyx_balance = nyx_balance - ?, is_premium = CASE WHEN ? = \'subscription\' THEN 1 ELSE is_premium END WHERE id = ?').run(product.price_nyx, product.product_type, req.userId);
    const expires = product.product_type === 'subscription' ? new Date(Date.now() + 30*86400000).toISOString() : null;
    const info = db.prepare('INSERT INTO premium_purchases (user_id, product_id, expires_at) VALUES (?, ?, ?)').run(req.userId, product.id, expires);
    return info.lastInsertRowid;
  });
  const purchaseId = tx();
  res.status(201).json({ ok: true, purchaseId });
});



router.get('/wallet', (req, res) => {
  const user = db.prepare('SELECT nyx_balance FROM users WHERE id = ?').get(req.userId);
  const transactions = db.prepare('SELECT * FROM wallet_transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 100').all(req.userId);
  res.json({ balance: user?.nyx_balance || 0, transactions: transactions.map((t) => ({ ...t, payload: safeJsonParse(t.payload_json, {}) })) });
});

router.post('/coins/purchase', (req, res) => {
  const packs = {
    starter: { amount: 500, title: 'Starter Pack' },
    plus: { amount: 1500, title: 'Plus Pack' },
    pro: { amount: 5000, title: 'Pro Pack' },
  };
  const packId = String(req.body?.packId || req.body?.pack_id || 'starter');
  const requestedAmount = Number(req.body?.amount || 0);
  const pack = packs[packId] || { amount: Math.max(1, Math.min(50000, requestedAmount || 500)), title: req.body?.label || 'NYX Coin Pack' };
  const tx = db.transaction(() => {
    db.prepare('UPDATE users SET nyx_balance = nyx_balance + ? WHERE id = ?').run(pack.amount, req.userId);
    const info = db.prepare(`INSERT INTO wallet_transactions (user_id, tx_type, amount, provider, provider_ref, payload_json)
      VALUES (?, 'coin_purchase', ?, ?, ?, ?)`).run(req.userId, pack.amount, req.body?.provider || 'in_app', req.body?.providerRef || null, JSON.stringify({ packId, title: pack.title, clientPayload: req.body || {} }));
    return info.lastInsertRowid;
  });
  const txId = tx();
  const user = db.prepare('SELECT nyx_balance FROM users WHERE id = ?').get(req.userId);
  res.status(201).json({ ok: true, transactionId: txId, credited: pack.amount, balance: user.nyx_balance });
});

router.post('/coins/ad-reward', (req, res) => {
  const rewardId = String(req.body?.rewardId || req.body?.adUnitId || '').slice(0, 120);
  const amount = Math.max(1, Math.min(100, Number(req.body?.amount || 5)));
  db.prepare('UPDATE users SET nyx_balance = nyx_balance + ? WHERE id = ?').run(amount, req.userId);
  const info = db.prepare(`INSERT INTO wallet_transactions (user_id, tx_type, amount, provider, provider_ref, payload_json)
    VALUES (?, 'ad_reward', ?, 'admob', ?, ?)`).run(req.userId, amount, rewardId || null, JSON.stringify(req.body || {}));
  const user = db.prepare('SELECT nyx_balance FROM users WHERE id = ?').get(req.userId);
  res.status(201).json({ ok: true, transactionId: info.lastInsertRowid, credited: amount, balance: user.nyx_balance });
});

router.get('/purchases', (req, res) => {
  const purchases = db.prepare('SELECT * FROM premium_purchases WHERE user_id = ? ORDER BY purchased_at DESC').all(req.userId);
  res.json({ purchases });
});

module.exports = router;
