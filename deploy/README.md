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
   `DEV_LOGIN` false. Optional: `ANTHROPIC_API_KEY` for recommendation summaries, `DEMO_PROJECT_ID` for a public
   read-only demo (fill it with `python scripts/seed_demo.py`).
6. **Build the web app** so `frontend/dist` is present: `npm ci && npm run build` in `frontend/`.
7. **First deploy:** `./deploy/deploy.sh`. It builds, runs `alembic upgrade head`, starts everything and checks `/healthz`.
8. **Create the first project:** `docker compose run --rm api python scripts/create_project.py my-company`.
   It prints the project key once; copy it somewhere safe.
9. **Backups:** add the cron line from `deploy/backup.sh`, and copy `backups/` off the machine.

## Every release

`git pull` and `./deploy/deploy.sh`. Migrations are additive, so a release never rewrites run history.

## Proving the backups work (before the demo)

`./deploy/restore.sh backups/<file>.dump` restores into a scratch database, counts the rows and drops it,
leaving the live database untouched.

## What runs where

| Piece | Where | Exposed |
|---|---|---|
| Caddy | container, ports 80 and 443 | the only public service |
| API, worker, scheduler | containers on the private network | `127.0.0.1:8000` on the host, for the health check |
| Postgres + pgvector | container | `127.0.0.1:5432` on the host only |
