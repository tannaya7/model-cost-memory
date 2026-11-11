#!/usr/bin/env bash
# Nightly Postgres backup. Run from the repo root on the server, for example from cron:
#   15 3 * * *  cd /opt/model-cost-memory && ./deploy/backup.sh >> backups/backup.log 2>&1
# Keeps KEEP_DAYS days of dumps in ./backups. Copy that folder off the machine for real safety.
set -euo pipefail

KEEP_DAYS="${KEEP_DAYS:-14}"
mkdir -p backups
file="backups/mcm-$(date +%F-%H%M).dump"

docker compose exec -T db pg_dump -U memory -Fc memory > "$file"
test -s "$file" || { echo "backup is empty: $file" >&2; rm -f "$file"; exit 1; }
find backups -name 'mcm-*.dump' -mtime +"$KEEP_DAYS" -delete
echo "backup written: $file ($(du -h "$file" | cut -f1))"
