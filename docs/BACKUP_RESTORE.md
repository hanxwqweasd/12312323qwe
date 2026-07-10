# Backup and restore

SQLite fallback backup:

```bash
npm run sqlite:backup
```

PostgreSQL backup:

```bash
DATABASE_URL="postgres://..." BACKUP_DIR=./backups ./scripts/backup-postgres.sh
```

PostgreSQL restore:

```bash
DATABASE_URL="postgres://..." ./scripts/restore-postgres.sh ./backups/file.dump
```

Never store production backups in a public repository.
