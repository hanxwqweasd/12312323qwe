require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { logger } = require('../infra/logger');
const { createWorker, queueNames } = require('../infra/queues');

const execFileAsync = promisify(execFile);

async function runBackup(job) {
  const dir = process.env.BACKUP_DIR || path.join(__dirname, '..', '..', 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `nyx-${stamp}.sql`);
  if (process.env.DATABASE_URL) {
    await execFileAsync('pg_dump', [process.env.DATABASE_URL, '-f', file]);
    return { ok: true, file };
  }
  if (process.env.DB_PATH) {
    const sqliteCopy = path.join(dir, `nyx-${stamp}.db`);
    fs.copyFileSync(process.env.DB_PATH, sqliteCopy);
    return { ok: true, file: sqliteCopy, mode: 'sqlite-copy' };
  }
  return { ok: false, reason: 'No DATABASE_URL or DB_PATH configured' };
}

if (require.main === module) {
  const worker = createWorker(queueNames.backups, runBackup, { concurrency: 1 });
  if (!worker) {
    logger.warn('Backup worker not started: Redis/BullMQ disabled.');
    process.exit(0);
  }
  logger.info('Nyx backup worker started');
}

module.exports = { runBackup };
