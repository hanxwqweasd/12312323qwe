const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { uploadBuffer, signedGetUrl, isS3Enabled } = require('../storage/s3');
const { addJob, queueNames } = require('../infra/queues');
const { json, safeJsonParse } = require('../utils/format');

const router = express.Router();
router.use(requireAuth);

const LOCAL_MEDIA_DIR = path.join(__dirname, '..', '..', 'data', 'media-v2');
fs.mkdirSync(LOCAL_MEDIA_DIR, { recursive: true });

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: Number(process.env.MAX_UPLOAD_MB || 200) * 1024 * 1024 },
});

function localSave(file, userId) {
  const ext = path.extname(file.originalname || '') || '.bin';
  const name = `u${userId}-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
  fs.writeFileSync(path.join(LOCAL_MEDIA_DIR, name), file.buffer);
  return { provider: 'local', key: name, cdnUrl: `/media-v2/${name}` };
}

router.post('/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл обязателен' });
  const encrypted = req.body.encrypted === '1' || req.body.encrypted === 'true';
  const encryptionMeta = req.body.encryptionMeta ? safeJsonParse(req.body.encryptionMeta, {}) : {};
  const storage = isS3Enabled()
    ? await uploadBuffer({ buffer: req.file.buffer, userId: req.userId, originalName: req.file.originalname, mimeType: req.file.mimetype, encrypted, meta: encryptionMeta })
    : localSave(req.file, req.userId);

  const info = db.prepare(`INSERT INTO media_files (owner_id, file_path, original_name, mime_type, size_bytes, encrypted, encryption_meta_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(req.userId, storage.key, req.file.originalname || null, req.file.mimetype || null, req.file.size || req.file.buffer.length, encrypted ? 1 : 0, json({ ...encryptionMeta, storage }));

  await addJob(queueNames.media, 'generate-previews', { mediaId: info.lastInsertRowid, storage, mimeType: req.file.mimetype, ownerId: req.userId });
  res.status(201).json({ media: { id: info.lastInsertRowid, url: storage.cdnUrl, storage, encrypted, originalName: req.file.originalname, mimeType: req.file.mimetype, sizeBytes: req.file.size || req.file.buffer.length } });
});

router.get('/:id/signed-url', async (req, res) => {
  const row = db.prepare('SELECT * FROM media_files WHERE id = ? AND owner_id = ?').get(Number(req.params.id), req.userId);
  if (!row) return res.status(404).json({ error: 'Файл не найден' });
  const meta = safeJsonParse(row.encryption_meta_json, {});
  const storage = meta.storage || { provider: 'local', key: row.file_path };
  if (storage.provider === 's3') {
    const url = storage.cdnUrl || await signedGetUrl(storage.key, Number(req.query.expires || 900));
    return res.json({ url, expiresIn: Number(req.query.expires || 900), encrypted: Boolean(row.encrypted) });
  }
  return res.json({ url: `/media-v2/${encodeURIComponent(storage.key)}`, encrypted: Boolean(row.encrypted) });
});

router.get('/library', (req, res) => {
  const rows = db.prepare('SELECT * FROM media_files WHERE owner_id = ? ORDER BY created_at DESC LIMIT 200').all(req.userId);
  res.json({ files: rows.map((r) => ({ ...r, encryptionMeta: safeJsonParse(r.encryption_meta_json, null) })) });
});

router.post('/cache/cleanup', async (req, res) => {
  const olderThanDays = Number(req.body?.olderThanDays || 30);
  const job = await addJob(queueNames.cleanup, 'media-cache-cleanup', { requestedBy: req.userId, olderThanDays });
  res.json({ ok: true, queued: Boolean(job), olderThanDays });
});

module.exports = router;
