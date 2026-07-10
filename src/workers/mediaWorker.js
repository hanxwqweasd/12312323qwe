require('dotenv').config();
const db = require('../db');
const { logger } = require('../infra/logger');
const { createWorker, queueNames } = require('../infra/queues');
const { json, safeJsonParse } = require('../utils/format');

async function generatePreviews(job) {
  const { mediaId, storage, mimeType } = job.data || {};
  const row = db.prepare('SELECT * FROM media_files WHERE id = ?').get(mediaId);
  if (!row) return { ok: false, reason: 'missing_media' };
  const meta = safeJsonParse(row.encryption_meta_json, {});
  const previewMeta = {
    ...meta,
    storage,
    previewStatus: (mimeType || '').startsWith('image/') ? 'ready_from_original' : 'queued_external_transcoder',
    thumbnailUrl: storage?.cdnUrl || null,
    streamingStatus: (mimeType || '').startsWith('video/') ? 'needs_hls_worker' : null,
    generatedAt: new Date().toISOString(),
  };
  db.prepare('UPDATE media_files SET encryption_meta_json = ? WHERE id = ?').run(json(previewMeta), mediaId);
  return { ok: true, previewMeta };
}

async function cleanup(job) {
  logger.info({ data: job.data }, 'Media cache cleanup requested');
  return { ok: true, note: 'Local/client cache cleanup is coordinated by the mobile app; server object lifecycle is configured in S3/MinIO.' };
}

if (require.main === module) {
  const previewWorker = createWorker(queueNames.media, generatePreviews, { concurrency: 3 });
  const cleanupWorker = createWorker(queueNames.cleanup, cleanup, { concurrency: 1 });
  if (!previewWorker && !cleanupWorker) {
    logger.warn('Media worker not started: Redis/BullMQ disabled.');
    process.exit(0);
  }
  logger.info('Nyx media worker started');
}

module.exports = { generatePreviews, cleanup };
