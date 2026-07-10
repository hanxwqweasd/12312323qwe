#!/usr/bin/env sh
set -eu
: "${DATABASE_URL:?DATABASE_URL is required}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
mkdir -p "$BACKUP_DIR"
OUT="$BACKUP_DIR/nyx-postgres-$(date +%Y%m%d-%H%M%S).dump"
pg_dump "$DATABASE_URL" -Fc -f "$OUT"
echo "PostgreSQL backup saved: $OUT"
