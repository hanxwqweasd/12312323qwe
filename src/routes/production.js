const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { pgReady, isPostgresEnabled } = require('../infra/postgres');
const { redisReady, isRedisEnabled } = require('../infra/redis');
const { queueHealth } = require('../infra/queues');
const { storageHealth } = require('../storage/s3');
const db = require('../db');

const router = express.Router();

function featureChecklist() {
  return [
    { id: 'postgres', title: 'PostgreSQL', enabled: isPostgresEnabled(), env: ['DB_DRIVER=postgres', 'DATABASE_URL'] },
    { id: 'redis', title: 'Redis', enabled: isRedisEnabled(), env: ['REDIS_URL'] },
    { id: 'queues', title: 'BullMQ queues', enabled: isRedisEnabled(), env: ['REDIS_URL'] },
    { id: 's3', title: 'S3/MinIO media storage', enabled: !!(process.env.S3_BUCKET || process.env.MINIO_BUCKET), env: ['S3_BUCKET', 'S3_ENDPOINT', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'] },
    { id: 'cdn', title: 'CDN signed delivery', enabled: !!process.env.CDN_BASE_URL, env: ['CDN_BASE_URL'] },
    { id: 'push', title: 'Push worker', enabled: !!process.env.EXPO_ACCESS_TOKEN || !!process.env.FCM_SERVER_KEY || !!process.env.APNS_KEY_ID, env: ['EXPO_ACCESS_TOKEN', 'FCM_SERVER_KEY', 'APNS_*'] },
    { id: 'turn', title: 'TURN/coturn', enabled: !!process.env.TURN_URL, env: ['TURN_URL', 'TURN_USERNAME', 'TURN_CREDENTIAL'] },
    { id: 'backups', title: 'Backups', enabled: !!process.env.BACKUP_DIR || !!process.env.BACKUP_S3_PREFIX, env: ['BACKUP_DIR', 'BACKUP_S3_PREFIX'] },
  ];
}

router.get('/status', async (req, res) => {
  const sqlite = (() => {
    try { return { ok: true, users: db.prepare('SELECT COUNT(*) as c FROM users').get().c }; }
    catch (err) { return { ok: false, error: err.message }; }
  })();
  const [postgres, redis, queues, storage] = await Promise.all([pgReady(), redisReady(), queueHealth(), storageHealth()]);
  res.json({
    ok: true,
    mode: process.env.NODE_ENV || 'development',
    dbDriver: process.env.DB_DRIVER || 'sqlite',
    sqlite,
    postgres,
    redis,
    queues,
    storage,
    checklist: featureChecklist(),
    serverTime: new Date().toISOString(),
  });
});

router.get('/readiness', async (req, res) => {
  const required = String(process.env.PRODUCTION_REQUIRED_SERVICES || '').split(',').map((s) => s.trim()).filter(Boolean);
  const checks = {
    postgres: await pgReady(),
    redis: await redisReady(),
    storage: await storageHealth(),
  };
  const failed = required.filter((key) => !checks[key]?.ok);
  res.status(failed.length ? 503 : 200).json({ ok: failed.length === 0, failed, checks });
});

router.use(requireAuth);

router.get('/admin/checklist', (req, res) => {
  res.json({
    checklist: featureChecklist(),
    recommendedOrder: [
      'PostgreSQL + migrations',
      'Redis + Socket.io adapter + queues',
      'S3/MinIO + CDN',
      'Push worker',
      'TURN/coturn',
      'Backups + monitoring',
    ],
  });
});

router.post('/admin/backups/request', async (req, res) => {
  const { addJob, queueNames } = require('../infra/queues');
  const job = await addJob(queueNames.backups, 'manual-backup', { requestedBy: req.userId, at: new Date().toISOString() });
  res.json({ ok: true, queued: Boolean(job), jobId: job?.id || null, fallback: job ? null : 'Очереди выключены. Запустите Redis/BullMQ.' });
});

module.exports = router;
