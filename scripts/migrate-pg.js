require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { getPool } = require('../src/infra/postgres');

async function main() {
  const pool = getPool();
  if (!pool) throw new Error('PostgreSQL disabled. Set DATABASE_URL and DB_DRIVER=postgres.');
  const dir = path.join(__dirname, '..', 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  await pool.query('CREATE TABLE IF NOT EXISTS migration_meta (id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
  for (const file of files) {
    const exists = await pool.query('SELECT id FROM migration_meta WHERE id = $1', [file]);
    if (exists.rowCount) {
      console.log(`skip ${file}`);
      continue;
    }
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    await pool.query('BEGIN');
    try {
      await pool.query(sql);
      await pool.query('INSERT INTO migration_meta (id) VALUES ($1)', [file]);
      await pool.query('COMMIT');
      console.log(`applied ${file}`);
    } catch (err) {
      await pool.query('ROLLBACK');
      throw err;
    }
  }
  await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
