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

router.get('/purchases', (req, res) => {
  const purchases = db.prepare('SELECT * FROM premium_purchases WHERE user_id = ? ORDER BY purchased_at DESC').all(req.userId);
  res.json({ purchases });
});

module.exports = router;
