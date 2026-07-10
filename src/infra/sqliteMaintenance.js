const db = require('../db');
const { logger } = require('./logger');

function runSqliteMaintenance() {
  if (String(process.env.DB_DRIVER || 'sqlite').toLowerCase() === 'postgres') return;
  try {
    db.pragma('wal_checkpoint(PASSIVE)');
    db.exec('PRAGMA optimize;');
    logger.info('SQLite maintenance completed');
  } catch (err) {
    logger.warn({ err }, 'SQLite maintenance failed');
  }
}

function scheduleSqliteMaintenance() {
  const everyMs = Number(process.env.SQLITE_OPTIMIZE_INTERVAL_MS || 10 * 60 * 1000);
  runSqliteMaintenance();
  setInterval(runSqliteMaintenance, everyMs).unref();
}

module.exports = { runSqliteMaintenance, scheduleSqliteMaintenance };
