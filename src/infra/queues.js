const { logger, optionalRequire } = require('./logger');
const { getRedis } = require('./redis');
const bullmq = optionalRequire('bullmq');

const queueNames = {
  push: 'nyx:push',
  media: 'nyx:media',
  botUpdates: 'nyx:bot-updates',
  backups: 'nyx:backups',
  cleanup: 'nyx:cleanup',
};

const queues = new Map();

function queueEnabled() {
  return !!getRedis() && !!bullmq;
}

function getQueue(name) {
  if (!queueEnabled()) return null;
  if (!queues.has(name)) {
    queues.set(name, new bullmq.Queue(name, { connection: getRedis() }));
  }
  return queues.get(name);
}

async function addJob(name, jobName, data, opts = {}) {
  const q = getQueue(name);
  if (!q) {
    logger.debug({ name, jobName }, 'Queue disabled; job skipped');
    return null;
  }
  return q.add(jobName, data, {
    attempts: Number(process.env.QUEUE_ATTEMPTS || 5),
    backoff: { type: 'exponential', delay: Number(process.env.QUEUE_BACKOFF_MS || 1000) },
    removeOnComplete: 1000,
    removeOnFail: 2000,
    ...opts,
  });
}

async function queueHealth() {
  if (!queueEnabled()) return { enabled: false, ok: false, reason: 'redis_or_bullmq_disabled' };
  const result = {};
  for (const name of Object.values(queueNames)) {
    const q = getQueue(name);
    result[name] = q ? await q.getJobCounts('waiting', 'active', 'delayed', 'failed') : null;
  }
  return { enabled: true, ok: true, queues: result };
}

function createWorker(name, processor, opts = {}) {
  if (!queueEnabled()) return null;
  const worker = new bullmq.Worker(name, processor, {
    connection: getRedis(),
    concurrency: Number(opts.concurrency || process.env.WORKER_CONCURRENCY || 5),
  });
  worker.on('failed', (job, err) => logger.error({ queue: name, jobId: job?.id, err }, 'Queue job failed'));
  worker.on('completed', (job) => logger.debug({ queue: name, jobId: job.id }, 'Queue job completed'));
  return worker;
}

module.exports = { queueNames, queueEnabled, getQueue, addJob, queueHealth, createWorker };
