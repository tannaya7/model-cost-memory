#!/usr/bin/env bash
# Nightly Postgres backup. Run from the repo root on the server, for example from cron:
#   15 3 * * *  cd /opt/model-cost-memory && ./deploy/backup.sh >> backups/backup.log 2>&1
# Keeps KEEP_DAYS days of dumps in ./backups, and (with BACKUP_REMOTE set) a copy off the machine, so
# losing the server does not lose the backups too. Settings come from the environment or from .env:
#   BACKUP_REMOTE     an rclone destination, e.g. "vultr-crypt:mcm-backups" (see deploy/README.md).
#                     Use an rclone crypt remote: the dumps hold customers' prompts.
#   REMOTE_KEEP_DAYS  days of dumps kept at the remote (default 30)
#   BACKUP_PING_URL   a dead-man's-switch URL (e.g. healthchecks.io), pinged on success and at
#                     <url>/fail on failure, so a backup that stops running is noticed
set -euo pipefail

setting() {  # the environment wins; otherwise the value in .env, without its trailing comment
  local value="${!1:-}"
  if [ -z "$value" ] && [ -f .env ]; then
    value="$(grep -E "^$1=" .env | tail -n 1 | cut -d= -f2- | sed -E 's/[[:space:]]+#.*$//; s/^[[:space:]]+|[[:space:]]+$//g')"
  fi
  printf '%s' "$value"
}

KEEP_DAYS="${KEEP_DAYS:-14}"
BACKUP_REMOTE="$(setting BACKUP_REMOTE)"
REMOTE_KEEP_DAYS="$(setting REMOTE_KEEP_DAYS)"; REMOTE_KEEP_DAYS="${REMOTE_KEEP_DAYS:-30}"
BACKUP_PING_URL="$(setting BACKUP_PING_URL)"

ping() { [ -z "$BACKUP_PING_URL" ] || curl -fsS -m 10 --retry 3 -o /dev/null "$BACKUP_PING_URL$1" || true; }
trap 'status=$?; [ "$status" -eq 0 ] || ping /fail' EXIT  # any failure, including an empty dump

mkdir -p backups
file="backups/mcm-$(date +%F-%H%M).dump"

docker compose exec -T db pg_dump -U memory -Fc memory > "$file"
test -s "$file" || { echo "backup is empty: $file" >&2; rm -f "$file"; exit 1; }
find backups -name 'mcm-*.dump' -mtime +"$KEEP_DAYS" -delete
echo "backup written: $file ($(du -h "$file" | cut -f1))"

if [ -n "$BACKUP_REMOTE" ]; then
  rclone copy "$file" "$BACKUP_REMOTE"
  rclone delete "$BACKUP_REMOTE" --min-age "${REMOTE_KEEP_DAYS}d" --include 'mcm-*.dump'
  echo "copied off the machine to $BACKUP_REMOTE"
else
  echo "warning: BACKUP_REMOTE is not set; this backup exists only on this machine" >&2
fi
ping ""
