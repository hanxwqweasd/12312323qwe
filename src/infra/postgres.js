const { logger, optionalRequire } = require('./logger');
const pg = optionalRequire('pg');

let pool = null;

function isPostgresEnabled() {
  return String(process.env.DB_DRIVER || '').toLowerCase() === 'postgres' || !!process.env.DATABASE_URL;
}

function getPool() {
  if (!isPostgresEnabled()) return null;
  if (!pg) {
    logger.warn('PostgreSQL requested but package pg is not installed. Run npm install.');
    return null;
  }
  if (!pool) {
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      max: Number(process.env.PG_POOL_SIZE || 20),
      idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS || 30000),
      connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT_MS || 5000),
      ssl: process.env.PG_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
    });
    pool.on('error', (err) => logger.error({ err }, 'Unexpected PostgreSQL pool error'));
  }
  return pool;
}

async function pgReady() {
  const p = getPool();
  if (!p) return { enabled: false, ok: false, reason: 'postgres_disabled' };
  const started = Date.now();
  try {
    const result = await p.query('SELECT NOW() as now');
    return { enabled: true, ok: true, latencyMs: Date.now() - started, now: result.rows[0]?.now };
  } catch (err) {
    return { enabled: true, ok: false, error: err.message };
  }
}

async function query(text, params = []) {
  const p = getPool();
  if (!p) throw new Error('PostgreSQL is not enabled. Set DB_DRIVER=postgres and DATABASE_URL.');
  return p.query(text, params);
}

module.exports = { isPostgresEnabled, getPool, pgReady, query };
