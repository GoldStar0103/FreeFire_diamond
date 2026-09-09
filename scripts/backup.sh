#!/usr/bin/env bash
#
# Nightly backup: the database and the uploads volume.
#
# Both are needed. A database dump alone restores every order and payment
# record but none of the comprobantes — the bank receipts proving those
# payments happened. Losing those while keeping the orders is arguably worse
# than losing both, because the records would say money arrived with nothing to
# support it.
#
#   ./scripts/backup.sh [destination]
#
# Install as root's crontab on the VPS:
#   15 4 * * * cd /srv/levelup && ./scripts/backup.sh >> /var/log/levelup-backup.log 2>&1
#
# Restore is documented in docs/RUNBOOK.md. Read it before you need it.

set -euo pipefail

DEST="${1:-/srv/levelup/backups}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
COMPOSE="docker compose -f docker-compose.prod.yml"
STAMP="$(date +%Y%m%d-%H%M%S)"

DB_USER="${POSTGRES_USER:-levelup}"
DB_NAME="${POSTGRES_DB:-levelup}"

mkdir -p "$DEST"

# umask before anything is written: a dump contains every customer's Free Fire
# ID and order history, and the default 0644 would leave it world-readable on a
# box that may later have more than one user.
umask 077

db_file="$DEST/db-$STAMP.sql.gz"
uploads_file="$DEST/uploads-$STAMP.tar.gz"

echo "[backup] $STAMP -> $DEST"

# --clean --if-exists so the dump can be replayed over an existing database
# without hand-dropping it first, which is what you want at 3am.
$COMPOSE exec -T postgres \
  pg_dump --username "$DB_USER" --dbname "$DB_NAME" --clean --if-exists \
  | gzip -9 > "$db_file.partial"

# Rename only after success. A truncated .sql.gz that looks like a backup is
# worse than an obviously missing one, because you find out which it was during
# a restore.
mv "$db_file.partial" "$db_file"
echo "[backup] database: $(du -h "$db_file" | cut -f1)"

# Read straight from the named volume rather than a running container, so this
# keeps working if the apps are down — which is exactly when a backup matters.
docker run --rm \
  -v levelup_uploads:/data:ro \
  -v "$DEST":/backup \
  alpine:3 \
  tar czf "/backup/uploads-$STAMP.tar.gz.partial" -C /data .

mv "$uploads_file.partial" "$uploads_file"
echo "[backup] uploads:  $(du -h "$uploads_file" | cut -f1)"

# Prune old sets. Only files matching our own naming, so nothing else in the
# directory is ever touched.
find "$DEST" -maxdepth 1 -name 'db-*.sql.gz'      -mtime "+$KEEP_DAYS" -delete
find "$DEST" -maxdepth 1 -name 'uploads-*.tar.gz' -mtime "+$KEEP_DAYS" -delete

# Refuse to report success on an empty dump. pg_dump exits 0 on some failures
# that produce almost no output, and a backup job that has been silently
# writing 20-byte files for a month is the classic way to discover you have no
# backups at the worst possible moment.
if [ "$(stat -c%s "$db_file")" -lt 1024 ]; then
  echo "[backup] FAILED: database dump is suspiciously small" >&2
  exit 1
fi

echo "[backup] done"
echo "[backup] NOTE: these are on the same disk as the data. Copy them off-box."
