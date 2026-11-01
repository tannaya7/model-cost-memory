# Frontend Deployment Guide

This guide explains how to build, verify, and deploy the **Model & Cost Memory** frontend web application.

---

## 1. Overview & Architecture

The frontend is a static Single Page Application (SPA) built with:
- **React 19** + **TypeScript**
- **Vite** (bundler and dev server)
- **Tailwind CSS v4** (theme-driven design via CSS variables in `src/shared/theme/theme.css`)
- **react-router-dom** (client-side routing with route-level lazy loading)
- **TanStack Query** (server-state management, cache invalidation, and cursor-based infinite pagination)
- **@tanstack/react-virtual** (virtualized rendering for large run datasets)

### Same-Origin API Design
All API calls use relative paths (e.g. `/v1/jobs`, `/v1/runs`). In development, Vite proxies `/v1` and `/auth` to the backend at `http://127.0.0.1:8000`. In production, the frontend is served from the same origin as the API (or via a reverse proxy), eliminating CORS issues and hardcoded hostnames.

---

## 2. Prerequisites

- **Node.js**: `v18.0.0` or higher (Node 20+ LTS recommended)
- **npm**: `v9.0.0` or higher

Verify your environment:
```bash
node -v
npm -v
```

---

## 3. Production Build

### Step 1: Install Dependencies
```bash
cd frontend
npm install
```

### Step 2: (Optional) Synchronize Types with Backend Contract
If the API schema in `contract/openapi.json` has changed, regenerate TypeScript types:
```bash
npm run gen:types
```

### Step 3: Run Type Check & Production Build
```bash
npm run build
```
This runs:
1. `tsc --noEmit` — strict TypeScript verification across all source files.
2. `vite build` — bundles, tree-shakes, minifies, and code-splits all pages into `frontend/dist/`.

### Build Output Structure
The output is written to `frontend/dist/`:
```
dist/
├── index.html                   # HTML entry point
├── mockServiceWorker.js         # Dev mock worker (inactive in prod)
└── assets/
    ├── index-[hash].css         # Compiled Tailwind theme and styles
    ├── index-[hash].js          # Core vendor & shell bundle
    ├── HomePage-[hash].js       # Lazy-loaded page chunks
    ├── JobsPage-[hash].js
    ├── RunsPage-[hash].js
    ├── SettingsPage-[hash].js
    └── ...
```

Every route is lazy-loaded (`React.lazy()`) and compiled into its own isolated JavaScript chunk.

---

## 4. Local Build Verification

You can preview the production bundle locally before deploying:
```bash
npm run preview
```
This starts Vite's local static file server (typically at `http://localhost:4173`).

---

## 5. Deployment Options

### Option A: Served directly by FastAPI (Unified Deployment)
FastAPI can serve the frontend directly as static files. Mount `dist/` in your FastAPI app:

```python
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
import os

app = FastAPI()

# Mount API routers first (/v1/jobs, /v1/runs, etc.)
# app.include_router(api_router, prefix="/v1")

# Serve static assets
if os.path.isdir("frontend/dist"):
    app.mount("/assets", StaticFiles(directory="frontend/dist/assets"), name="assets")

    @app.get("/{full_path:path}")
    async def serve_spa(full_path: str):
        index_file = "frontend/dist/index.html"
        return FileResponse(index_file)
```

### Option B: Reverse Proxy (Nginx / Caddy) — Recommended for Production
Serve the static files from `frontend/dist` and proxy `/v1/` and `/auth/` to the FastAPI backend.

#### Nginx Example
```nginx
server {
    listen 80;
    server_name mcm.example.com;

    # Static assets with long cache headers
    location /assets/ {
        root /var/www/model-cost-memory/frontend/dist;
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    # API endpoints proxied to backend
    location /v1/ {
        proxy_pass http://127.0.0.1:8000/v1/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Auth endpoints proxied to backend
    location /auth/ {
        proxy_pass http://127.0.0.1:8000/auth/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # SPA fallback: any non-file route serves index.html
    location / {
        root /var/www/model-cost-memory/frontend/dist;
        try_files $uri $uri/ /index.html;
    }
}
```

#### Caddy Example
```caddy
mcm.example.com {
    root * /var/www/model-cost-memory/frontend/dist

    # Reverse proxy API and Auth routes
    reverse_proxy /v1/* 127.0.0.1:8000
    reverse_proxy /auth/* 127.0.0.1:8000

    # Serve static assets and fallback to index.html for client-side routing
    file_server
    try_files {path} /index.html
}
```

### Option C: Cloudflare Pages / AWS S3 + CloudFront / Vercel
Deploy the `frontend/dist/` directory to static hosting, and configure routing rules:
- **SPA Fallback**: Redirect all non-asset requests (404s) to `/index.html`.
- **API Proxy**: Configure a rewrite rule directing `/v1/*` to your backend endpoint (e.g. via Cloudflare Pages functions or AWS CloudFront origins).

---

## 6. Authentication & Configuration

1. **Project API Key**:
   - Stored in browser `localStorage` under the key `mcm_api_key` (default is `"demo-key"`).
   - Injected into every API request header: `X-API-Key: <key>`.
   - Users can update and test this key at `/settings`.
2. **Mock Server**:
   - MSW (Mock Service Worker) is dev-only (`import.meta.env.DEV && VITE_USE_MOCK === "true"`).
   - It is completely tree-shaken and excluded from production builds.

---

## 7. Troubleshooting

| Issue | Cause | Resolution |
|---|---|---|
| **404 on page refresh (e.g. `/runs`)** | Server is looking for a physical `runs.html` file | Configure SPA fallback on your web server (`try_files $uri /index.html`) |
| **401 Unauthorized errors** | Missing or invalid API key | Check the API key on the `/settings` screen or ensure backend accepts the key |
| **Requests failing with connection refused** | Backend is not running or proxy is misconfigured | Verify backend service is listening on port 8000 and proxy passes `/v1` |
