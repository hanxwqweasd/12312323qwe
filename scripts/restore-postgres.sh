#!/usr/bin/env sh
set -eu
: "${DATABASE_URL:?DATABASE_URL is required}"
: "${1:?Usage: restore-postgres.sh path/to/backup.dump}"
pg_restore --clean --if-exists --no-owner --dbname "$DATABASE_URL" "$1"
echo "PostgreSQL restored from: $1"
