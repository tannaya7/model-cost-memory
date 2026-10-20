#!/usr/bin/env bash
# Deploy the current commit on the server: pull, build, migrate, restart.
#   cd /opt/model-cost-memory && ./deploy/deploy.sh
# Migrations are additive, so a release never rewrites run history.
set -euo pipefail

git pull --ff-only
docker compose --profile full build
docker compose up -d db
docker compose run --rm api alembic upgrade head
docker compose --profile full up -d
docker compose ps
curl --fail --silent --show-error "http://127.0.0.1:8000/healthz" && echo " <- API is healthy"
