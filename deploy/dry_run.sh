#!/usr/bin/env bash
# The whole server setup, end to end, on a throwaway machine (CI runs it on every pull request):
#   ./deploy/dry_run.sh        from the repo root, with Docker, curl, openssl and frontend/dist built
#
# It follows deploy/README.md with DOMAIN=localhost, so Caddy serves HTTPS from its own local
# certificate authority, then checks what a real deployment must do: the web app and the API answer
# through Caddy, a recorded run is checked and indexed by the worker, the scheduler stays up, a
# recommendation comes back, and a backup restores. Never run it on the real server: it rewrites .env.
set -euo pipefail

[ -f frontend/dist/index.html ] || { echo "build the web app first: (cd frontend && npm ci && npm run build)" >&2; exit 1; }

# 1. Configure, as in deploy/README.md step 5.
cp .env.example .env
set_env() { sed -i "s|^$1=.*|$1=$2|" .env; }
set_env POSTGRES_PASSWORD "dry-run-$(openssl rand -hex 12)"
set_env SECRET_KEY "$(openssl rand -hex 32)"
set_env DOMAIN localhost
set_env PUBLIC_URL https://localhost

# 2. First deploy (step 7): build, migrate, start, wait for /healthz.
DEPLOY_SKIP_PULL=1 ./deploy/deploy.sh

# 3. Create the first project (step 8).
out="$(docker compose run --rm -T api python scripts/create_project.py dry-run)"
key="$(printf '%s\n' "$out" | sed -n 's/^API key: *//p')"
[ -n "$key" ] || { echo "no API key in: $out" >&2; exit 1; }

# Everything below goes through Caddy over HTTPS, as a browser or the SDK would.
api() { curl --fail-with-body --silent --show-error --insecure "https://localhost$1" -H "X-API-Key: $key" "${@:2}"; }

echo "--- the web app is served, and client-side routes fall back to it"
curl --fail --silent --insecure https://localhost/ | grep -q '<div id="root">'
curl --fail --silent --insecure https://localhost/runs | grep -q '<div id="root">'
curl --silent --insecure -o /dev/null -D - https://localhost/ | grep -qi '^strict-transport-security'
echo "--- the API answers through Caddy"
api /healthz

echo "--- define a job and record 30 runs"
api /v1/jobs -X POST -H 'content-type: application/json' -d '{"name": "invoice-extract",
  "check_kind": "ANSWER_KEY", "check_config": {"fields": ["total"]}}' > /dev/null
for i in $(seq 1 30); do
  total=$([ "$i" -le 27 ] && echo 120.5 || echo 99)   # 27 pass, 3 fail
  api /v1/runs -X POST -H 'content-type: application/json' -d "{\"run_id\": \"$(cat /proc/sys/kernel/random/uuid)\",
    \"job\": \"invoice-extract\", \"prompt\": \"Invoice $i: extract the total\", \"model\": \"gemini-2.5-flash\",
    \"model_version\": \"gemini-2.5-flash\", \"provider\": \"gemini\", \"tokens_in\": 400, \"tokens_out\": 40,
    \"output\": \"{\\\"total\\\": $total}\", \"expected\": {\"total\": 120.5}}" > /dev/null
done

echo "--- the worker indexes every run (first start downloads the embedding model)"
for attempt in $(seq 1 90); do
  states="$(api '/v1/runs?job=invoice-extract&limit=200' | python3 -c \
    'import json,sys; print(" ".join(sorted({r["state"] for r in json.load(sys.stdin)["items"]})))')"
  [ "$states" = "INDEXED" ] && break
  [ "$attempt" = 90 ] && { echo "runs not indexed after 3 minutes: $states" >&2; docker compose logs --tail 80 worker >&2; exit 1; }
  sleep 2
done
echo "all 30 runs INDEXED"
api '/v1/runs?job=invoice-extract&outcome=FAIL' | python3 -c \
  'import json,sys; n=len(json.load(sys.stdin)["items"]); assert n == 3, n; print("3 runs checked FAIL")'

echo "--- a recommendation comes back"
api /v1/jobs/invoice-extract/recommendation | python3 -c \
  'import json,sys; d=json.load(sys.stdin); print("verdict:", d["verdict"])'

echo "--- every service is still running"
if docker compose --profile full ps --status exited --status restarting --format '{{.Service}}' | grep .; then
  echo "a service stopped" >&2; docker compose --profile full logs --tail 50 >&2; exit 1
fi

echo "--- backup and restore (deploy/README.md: proving the backups work)"
./deploy/backup.sh
./deploy/restore.sh "$(ls -t backups/mcm-*.dump | head -1)" | tee /tmp/restore.log
grep -q '^runs: 30$' /tmp/restore.log

docker images --format '{{.Repository}}:{{.Tag}} {{.Size}}' | grep -v '<none>'
echo "dry run passed"
