const fs = require('fs');
const path = require('path');
const db = require('../src/db');

const backupDir = process.env.BACKUP_DIR || path.join(__dirname, '..', 'backups');
fs.mkdirSync(backupDir, { recursive: true });
const file = path.join(backupDir, `nyx-sqlite-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
db.backup(file)
  .then(() => {
    console.log(`SQLite backup saved: ${file}`);
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
