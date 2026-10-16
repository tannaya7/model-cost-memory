# Model & Cost Memory Frontend

Continuous evaluation and cost memory for AI model migrations, prompt iterations, and model retirements.

---

## 1. Quick Start

### Installation
```bash
npm install
```

### Development with Mock API (Local Sandbox)
```bash
VITE_USE_MOCK=true npm run dev
```
Starts the Vite dev server with Mock Service Worker (MSW) simulating all backend routes, users, run pipelines, and background re-tests.

### Development with Real Backend
```bash
npm run dev
```
Proxies `/v1` and `/auth` requests directly to `http://127.0.0.1:8000`.

### Production Build & Type Check
```bash
npm run build
```
Runs strict TypeScript validation (`tsc --noEmit`) and compiles optimized static assets into `dist/`.

---

## 2. Directory Layout

```
src/
├── app/          # Core shell, auth guards (RequireAuth), and root layout
├── features/     # Feature-oriented domain modules
│   ├── alerts/          # Regression alerts and deprecation warnings
│   ├── auth/            # User profile and session hooks
│   ├── flow/            # Real-time event stream and step pipeline
│   ├── history/         # Recommendation decision timeline
│   ├── insights/        # Spend metrics and chart visualizations
│   ├── jobs/            # Job catalog, creation panel, and overview
│   ├── models/          # Model catalog and pricing
│   ├── projects/        # Project management, setup, and API keys
│   ├── recommendations/ # Model recommendations, comparison, and evidence
│   ├── retest/          # Sandbox re-test execution and progress tracking
│   ├── runs/            # Virtualized run logs and detail inspection
│   └── settings/        # Project API key settings
├── mocks/        # MSW service worker handlers and sample data fixtures
├── pages/        # Lazy-loaded route page components
└── shared/       # Cross-cutting API client, theme tokens, motion, and UI components
```

---

## 3. API Types & Synchronization

TypeScript contracts are generated directly from the OpenAPI specification:
```bash
npm run gen:types
```
Generates `src/shared/api/generated.ts` from `../contract/openapi.json`.

---

## 4. Temporary Endpoints

The following features use transitional frontend types (`types.ts`) pending final publication in `contract/openapi.json`:
- **`recommendation`**: `GET /v1/jobs/{job}/recommendation`
- **`spend`**: `GET /v1/insights/spend`
- **`regressions`**: `GET /v1/jobs/{job}/regressions`
- **`history`**: `GET /v1/jobs/{job}/history`
- **`retest`**: `GET /v1/retest/limits`, `POST /v1/jobs/{job}/retest`, and `GET /v1/jobs/{job}/retest/{id}`
- **`me`**: `GET /v1/me` and `POST /auth/logout`
- **`projects`**: `GET /v1/projects`, `POST /v1/projects`, `PATCH /v1/projects/{id}`, and `POST /v1/projects/{id}/key`
- **`flow`**: `GET /v1/flow` and SSE `GET /v1/flow/stream`

---

## 5. Deployment

For complete production deployment instructions (FastAPI static mounting, Nginx / Caddy reverse proxy configurations, and caching strategies), see [DEPLOY.md](./DEPLOY.md).
