# API contract

The backend and the web app meet here. Nothing in this folder is edited by hand.

| File | What it is |
|---|---|
| `openapi.json` | The OpenAPI schema FastAPI publishes. The frontend generates its TypeScript types from it. |
| `samples/jobs.json` | An example `GET /v1/jobs` response. The frontend's mock server serves it. |
| `samples/runs.json` | An example `GET /v1/runs` response. |
| `samples/models.json` | An example `GET /v1/models` response. |
| `samples/recommendation.json` | An example `GET /v1/jobs/{job}/recommendation` response, produced by the engine itself. |
| `samples/spend.json` | An example `GET /v1/insights/spend` response. |

## How it is used each week

1. **Monday:** the backend commits the week's response models and runs `python scripts/export_openapi.py`.
2. **Tuesday to Thursday:** the backend builds the endpoint; the frontend builds the screen against the sample.
3. **Friday:** the screen is switched from the mock to the live endpoint.

A test (`tests/test_contract.py`) fails if these files are out of date, so a response model can never
change without the contract changing with it.

## Authentication

Every `/v1` route needs the project key, sent as `X-API-Key: <key>` or `Authorization: Bearer <key>`.
Keys look like `mcm_live_...`. `GET /healthz` needs no key.

## Conventions

- Money is a JSON number in US dollars (`cost_usd`).
- Timestamps are ISO 8601 in UTC.
- Lists that can grow are paged with a cursor: pass the previous response's `next_cursor` as `?cursor=`;
  `null` means the last page.
- Errors are `{"detail": "..."}` with a 401 (bad key) or 422 (bad input).
