// src/routes/media.js
// Telegram-like media library: upload registry, file metadata, link previews,
// cache settings, albums payload support and encrypted-media metadata storage.

const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { json, safeJsonParse, parsePaging } = require('../utils/format');

const router = express.Router();
router.use(requireAuth);

const MEDIA_DIR = path.join(__dirname, '..', '..', 'data', 'media');
fs.mkdirSync(MEDIA_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, MEDIA_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || '';
      cb(null, `media-${req.userId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
    },
  }),
  limits: { fileSize: Number(process.env.MAX_MEDIA_SIZE || 250) * 1024 * 1024 },
});

router.post('/upload', (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'Файл не получен' });
    const { width, height, durationSeconds, encrypted, encryptionMeta } = req.body || {};
    const info = db.prepare(`INSERT INTO media_files (owner_id, file_path, original_name, mime_type, size_bytes, width, height, duration_seconds, encrypted, encryption_meta_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(req.userId, req.file.filename, req.file.originalname, req.file.mimetype, req.file.size, width || null, height || null, durationSeconds || null, encrypted ? 1 : 0, encryptionMeta ? json(encryptionMeta) : null);
    res.status(201).json({
      file: {
        id: info.lastInsertRowid,
        url: `/media/${req.file.filename}`,
        filePath: req.file.filename,
        originalName: req.file.originalname,
        mimeType: req.file.mimetype,
        sizeBytes: req.file.size,
        encrypted: Boolean(encrypted),
      },
    });
  });
});

router.get('/library', (req, res) => {
  const { limit, offset } = parsePaging(req, 100);
  const type = req.query.type;
  const where = ['owner_id = ?'];
  const params = [req.userId];
  if (type) { where.push('mime_type LIKE ?'); params.push(`${type}/%`); }
  params.push(limit, offset);
  const rows = db.prepare(`SELECT * FROM media_files WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...params);
  res.json({ files: rows.map((f) => ({ ...f, url: `/media/${f.file_path}`, encrypted: Boolean(f.encrypted), encryptionMeta: safeJsonParse(f.encryption_meta_json, null) })) });
});

router.get('/cache-settings', (req, res) => {
  res.json({
    cache: {
      maxSizeMb: Number(process.env.MEDIA_CACHE_MAX_MB || 1024),
      autoClearDays: Number(process.env.MEDIA_CACHE_AUTO_CLEAR_DAYS || 30),
      streamVideo: true,
      progressiveDownload: true,
    },
  });
});

router.post('/link-preview', (req, res) => {
  const { url } = req.body || {};
  if (!url || !/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'Нужен http/https URL' });
  const existing = db.prepare('SELECT * FROM link_previews WHERE url = ?').get(url);
  if (existing) return res.json({ preview: existing });
  // Safe placeholder: no remote fetch here; client may enrich this later.
  const host = (() => { try { return new URL(url).hostname; } catch (e) { return url; } })();
  db.prepare('INSERT INTO link_previews (url, title, description) VALUES (?, ?, ?)').run(url, host, `Ссылка на ${host}`);
  res.json({ preview: db.prepare('SELECT * FROM link_previews WHERE url = ?').get(url) });
});

module.exports = router;
