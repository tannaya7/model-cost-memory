#!/usr/bin/env bash
# Restore a backup into a scratch database and check it, WITHOUT touching the live one.
#   ./deploy/restore.sh backups/mcm-2026-10-20-0315.dump
# Run this once before the demo to prove the backups work (Week 12).
set -euo pipefail

dump="${1:?usage: restore.sh <dump file>}"
test -s "$dump" || { echo "no such dump: $dump" >&2; exit 1; }

docker compose exec -T db psql -U memory -d postgres -c "DROP DATABASE IF EXISTS mcm_restore_check"
docker compose exec -T db psql -U memory -d postgres -c "CREATE DATABASE mcm_restore_check"
docker compose exec -T db pg_restore -U memory -d mcm_restore_check --no-owner < "$dump"
docker compose exec -T db psql -U memory -d mcm_restore_check -At -c \
  "SELECT 'runs: ' || count(*) FROM runs UNION ALL SELECT 'projects: ' || count(*) FROM projects"
docker compose exec -T db psql -U memory -d postgres -c "DROP DATABASE mcm_restore_check"
echo "restore check passed for $dump"
