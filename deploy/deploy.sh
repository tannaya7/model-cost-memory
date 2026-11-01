#!/usr/bin/env bash
# Deploy the current commit on the server: pull, build, migrate, restart.
#   cd /opt/model-cost-memory && ./deploy/deploy.sh
# Migrations are additive, so a release never rewrites run history.
# DEPLOY_SKIP_PULL=1 deploys the checkout as it is (the CI dry run uses it).
set -euo pipefail

if [ "${DEPLOY_SKIP_PULL:-0}" != "1" ]; then
  git pull --ff-only
fi
docker compose --profile full build
docker compose up -d db
docker compose run --rm api alembic upgrade head
docker compose --profile full up -d
docker compose --profile full ps

# The API takes a few seconds to start after `up -d`; wait for it rather than failing the deploy.
for _ in $(seq 1 30); do
  if curl --fail --silent "http://127.0.0.1:8000/healthz" > /dev/null; then
    echo "API is healthy"
    exit 0
  fi
  sleep 2
done
echo "API did not become healthy within 60 s; recent logs:" >&2
docker compose logs --tail 50 api >&2
exit 1
