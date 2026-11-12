# Deploying to a server

> **Status: dry-run in CI, not yet run on a real server.** On every pull request the `deploy-dry-run` job
> follows this guide on a throwaway machine (`deploy/dry_run.sh`, with `DOMAIN=localhost`): it builds every image,
> migrates, starts the stack behind Caddy, records runs through it, and restores a backup. What only a real server
> can prove is still open: the public domain and its certificate, Google sign-in, and running on 4 GB of memory.

Laptops need none of this: development uses a free hosted Neon database. Docker is for the server only.

## One-time server setup (Week 5)

1. **Server:** a 4 GB Linux VPS (Vultr with the college credits). Open ports 22, 80 and 443 only.
2. **Domain:** point an A record (and AAAA if the server has IPv6) at the server's address. Caddy's HTTPS and
   Google sign-in both need a real domain name.
3. **Install Docker** with the official convenience script, then log in again so your user can run it.
4. **Get the code:** `git clone <repo> /opt/model-cost-memory && cd /opt/model-cost-memory`, then check out `POC`.
5. **Configure:** `cp .env.example .env` and set `POSTGRES_PASSWORD` (long and random), `DOMAIN`, `SECRET_KEY`
   (long and random; it encrypts stored provider keys and signs sign-in cookies, so keep it stable) and
   `PUBLIC_URL=https://<DOMAIN>`. For Google sign-in, create an OAuth client (Web application) with the redirect
   URI `https://<DOMAIN>/auth/google/callback` and set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. Leave
   `DEV_LOGIN` and `ALLOW_PRIVATE_URLS` false: with `PUBLIC_URL` on https the API and the scheduler refuse to start
   if either is on, or if `SECRET_KEY` is missing or shorter than 32 characters. Optional: `SUMMARY_API_KEY` (or
   `GEMINI_API_KEY`) for two-sentence recommendation summaries on Gemini's free tier, `DEMO_PROJECT_ID` for a public read-only demo (fill it with
   `python scripts/seed_demo.py`), and the abuse limits (`RATE_LIMIT_*`, `RUNS_PER_DAY_PER_PROJECT`, `STREAMS_*`),
   whose defaults suit one small server.
6. **Build the web app** so `frontend/dist` is present: `npm ci && npm run build` in `frontend/`.
7. **First deploy:** `./deploy/deploy.sh`. It builds, runs `alembic upgrade head`, starts everything and checks `/healthz`.
8. **Create the first project:** `docker compose run --rm api python scripts/create_project.py my-company`.
   It prints the project key once; copy it somewhere safe.
9. **Backups, off the machine:** install [rclone](https://rclone.org), run `rclone config` to add your object
   storage (Vultr Object Storage, Backblaze B2 or any S3-compatible bucket) and a **crypt** remote on top of it,
   because the dumps hold customers' prompts. Set `BACKUP_REMOTE` (for example `mcm-crypt:backups`) in `.env`,
   then add the cron line from `deploy/backup.sh`. Each night's dump is kept 14 days on the server and
   `REMOTE_KEEP_DAYS` (30) at the remote. Without `BACKUP_REMOTE` the script warns that the backup is local only.
10. **Monitoring:** in a free uptime monitor (UptimeRobot, Better Stack or Healthchecks.io), check
    `https://<DOMAIN>/healthz` (the API and database) and `https://<DOMAIN>/healthz/scheduler` (503 when a
    scheduled job is overdue) every 5 minutes, alerting you by email. Make a Healthchecks.io check with a
    one-day period for the backup and put its URL in `BACKUP_PING_URL`: a backup that fails or stops running is
    then reported too. Optionally set `OPERATOR_WEBHOOK_URL` to a Slack or Discord incoming webhook to hear
    about each failing scheduled job (at most once an hour per job).

## Every release

`git pull` and `./deploy/deploy.sh`. Migrations are additive, so a release never rewrites run history.

## Proving the backups work (before the demo)

`./deploy/restore.sh backups/<file>.dump` restores into a scratch database, counts the rows and drops it,
leaving the live database untouched. Try it once on a dump fetched back from the remote too
(`rclone copy $BACKUP_REMOTE/<file>.dump backups/`), so the off-site copy is known to restore.

## Deleting a customer's data

A signed-in owner deletes a project from the web app (Projects, open the project, Delete project). For a project made
with `create_project.py`, which has no owner, run
`docker compose run --rm api python scripts/delete_project.py <project-id> --yes`. Either way every job,
run, re-test, recommendation, alert and stored key of that project goes in one transaction. Dumps already
taken still hold it until they age out (14 days here, `REMOTE_KEEP_DAYS` at the remote).

Run content (prompt, answer, tool calls, answer key) is cleared after each project's retention, 90 days by
default and set per project in Settings; the figures the recommendations use are kept.

## What runs where

| Piece | Where | Exposed |
|---|---|---|
| Caddy | container, ports 80 and 443 | the only public service |
| API, worker, scheduler | containers on the private network | `127.0.0.1:8000` on the host, for the health check |
| Postgres + pgvector | container | `127.0.0.1:5432` on the host only |
