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
#   bash scripts/backup.sh [destination]
#
# Install as root's crontab on the VPS (`sudo crontab -e`). The server's clock
# is UTC, so 10:15 is 04:15 in Mexico City:
#   15 10 * * * cd /srv/levelup && bash scripts/backup.sh >> /var/log/levelup-backup.log 2>&1
#
# "bash scripts/..." rather than "./scripts/...": it works whether or not the
# file is marked executable, which a repo committed from Windows usually does
# not do. A cron job failing on "Permission denied" writes one line to a log
# nobody reads.
#
# Off-box copies: set BACKUP_RCLONE_REMOTE (see .env.example) and configure
# that rclone remote once, as root — docs/RUNBOOK.md §3. Unset, the backups
# stay on this disk only, which protects against nothing that destroys it.
#
# Restore is documented in docs/RUNBOOK.md. Read it before you need it.

set -euo pipefail

# Settings come from the environment first, so a crontab line can override
# anything; then from the BACKUP_* lines of ./.env (the same file compose
# reads, which is why the cron line cd's into /srv/levelup); then the defaults
# below. cron starts with an almost empty environment, so without the .env
# step a remote configured there would silently never be used.
#
# .env is read, never sourced. It holds lines such as
#   LEGAL_ADDRESS=Carretera Teloloapan - Apaxtla Km. 1, ...
# which a shell would try to run as a command. And only BACKUP_* keys are
# looked at, so editing some unrelated setting can never change what this
# script does.
env_file_value() {
  local key="$1" file=".env" line value
  [ -r "$file" ] || return 0
  # Last assignment wins, as in compose.
  line="$(grep -E "^[[:space:]]*${key}=" "$file" | tail -n 1 || true)"
  [ -n "$line" ] || return 0
  value="${line#*=}"
  value="${value%$'\r'}"
  case "$value" in
    \"*\") value="${value#\"}"; value="${value%\"}" ;;
    \'*\') value="${value#\'}"; value="${value%\'}" ;;
    *)
      # Unquoted: drop a " # comment" and trailing spaces, as compose does.
      value="${value%%[[:space:]]#*}"
      value="${value%"${value##*[![:space:]]}"}"
      ;;
  esac
  printf '%s' "$value"
}

setting() {
  local key="$1" default="$2" value
  value="${!key:-}"
  if [ -z "$value" ]; then
    value="$(env_file_value "$key")"
  fi
  printf '%s' "${value:-$default}"
}

DEST="${1:-/srv/levelup/backups}"
KEEP_DAYS="$(setting BACKUP_KEEP_DAYS 14)"
# e.g. gdrive:levelup-backups or r2:levelup-backups. Empty = no off-box copy.
RCLONE_REMOTE="$(setting BACKUP_RCLONE_REMOTE '')"
REMOTE_KEEP_DAYS="$(setting BACKUP_REMOTE_RETENTION_DAYS 30)"
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

if [ -z "$RCLONE_REMOTE" ]; then
  echo "[backup] done"
  echo "[backup] NOTE: these are on the same disk as the data. Copy them off-box."
  exit 0
fi

# ── off-box copy ──────────────────────────────────────────────────────────────
# Runs only after both local files are complete and the dump has passed the
# size check, so a broken night is never shipped off-box. Nothing below ever
# deletes a local file: whatever goes wrong here, tonight's local backup stays,
# and the script exits non-zero so the log says FAILED.
#
# rclone reads its remotes from root's ~/.config/rclone/rclone.conf (or
# $RCLONE_CONFIG). The credentials live there, not in .env.

remote_fail() {
  echo "[backup] FAILED: off-box copy to $RCLONE_REMOTE: $*" >&2
  echo "[backup] the local backup in $DEST is intact" >&2
  exit 1
}

if ! command -v rclone >/dev/null 2>&1; then
  remote_fail "rclone is not installed (sudo apt-get install rclone)"
fi
# Checked before anything is uploaded: "0" or a typo here would otherwise be
# handed to the prune below, and --min-age 0d means "every file".
case "$REMOTE_KEEP_DAYS" in
  '' | *[!0-9]*) remote_fail "BACKUP_REMOTE_RETENTION_DAYS='$REMOTE_KEEP_DAYS' is not a whole number of days" ;;
esac
REMOTE_KEEP_DAYS="$((10#$REMOTE_KEEP_DAYS))"
if [ "$REMOTE_KEEP_DAYS" -lt 1 ]; then
  remote_fail "BACKUP_REMOTE_RETENTION_DAYS must be at least 1"
fi

upload_ok=true
for f in "$db_file" "$uploads_file"; do
  if rclone copy "$f" "$RCLONE_REMOTE"; then
    echo "[backup] off-box:  $(basename "$f") -> $RCLONE_REMOTE"
  else
    echo "[backup] off-box:  $(basename "$f") did NOT upload" >&2
    upload_ok=false
  fi
done

# Prune only after a night that uploaded both files. A remote that has stopped
# accepting uploads should keep what it has, not age out its last good sets.
if [ "$upload_ok" != true ]; then
  remote_fail "upload failed (rclone's error is above); remote copies were not pruned"
fi

# Same rule as the local prune: only files matching our own naming, only at
# the top level, so nothing else in that folder or bucket is ever touched.
if ! rclone delete "$RCLONE_REMOTE" \
  --max-depth 1 \
  --min-age "${REMOTE_KEEP_DAYS}d" \
  --include 'db-*.sql.gz' \
  --include 'uploads-*.tar.gz'; then
  remote_fail "tonight's files uploaded, but pruning copies older than ${REMOTE_KEEP_DAYS} days failed"
fi

echo "[backup] done (local + $RCLONE_REMOTE, remote copies kept ${REMOTE_KEEP_DAYS} days)"
