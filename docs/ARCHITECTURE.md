# Architecture

A **modular monolith with background workers**: one Python codebase, run as four processes that
share one PostgreSQL database and talk through a **transactional outbox** instead of a message
broker. The system **observes AI calls and never intercepts them**.

The illustrated version, with a walkthrough and glossary, is
[`Architecture_Overview.pdf`](Architecture_Overview.pdf).

![System architecture](assets/diagrams/architecture_overview_v3.png)

## What each numbered arrow means

| # | Path | What happens |
|---|---|---|
| 1 | Production | The customer's app calls the AI provider exactly as before. We are never in this path |
| 2 | Write | `RunRecorder` sends a copy of the run (prompt, model, exact version, tokens, cost, latency, output) to `POST /v1/runs` in the background, adding under 5 ms |
| 3 | Write | The API checks pass/fail, then saves the run **and** an outbox row in one transaction and replies `202` |
| 4 | Write | The sync worker claims outbox rows with `SELECT … FOR UPDATE SKIP LOCKED` |
| 5 | Write | It embeds each prompt (pgvector) and writes lineage (Neo4j, optional) |
| 6 | Maintenance | Decay, consolidation and the regression check run on the stored runs |
| 7 | Maintenance | Re-tests replay sampled runs on new or candidate models: the only calls we make, always under a budget |
| 8 | Maintenance | Regression alerts are pushed to the project's webhook |
| 9 | Read | The engineer asks: which model, did it break, why did it change, what does each job cost |
| 10 | Read | Demo visitors use the read-only Streamlit UI and cannot spend the budget |
| 11 | Maintenance | Catalog sync reads a public model list daily for prices and retirement dates |

## Three independent paths

| Path | Trigger | Steps |
|---|---|---|
| **Write** | Every model call | Validate → pass/fail check (answer key, tests in a sandbox, or schema) → run + outbox row in one transaction → `202` → worker indexes it |
| **Read** | Someone asks | Load active runs → weight by freshness → group by model, drop retired models → evidence floor → lowest cost per success within tolerance → verdict with failing run ids. Never writes |
| **Maintenance** | Scheduler | Decay · consolidation · regression check · catalog sync · re-tests · alert delivery |

They share only the database, so a slow re-test never slows recording and a burst of runs never
slows answers.

**Life of a run:** `CAPTURED → CHECKED → INDEXED → CONSOLIDATED → ARCHIVED` (failure:
`INGESTION_FAILED`). Archived runs are never deleted; they stop counting.

## Core formulas

```
freshness            R(t) = e^(-t / S),  S = importance × 30 × version_factor
                     version_factor = 1.00 current, 0.25 superseded (fades ~4× faster)
weighted pass rate   Σ(R × passed) / Σ R
cost per run         usage × catalog price (input, output incl. thinking, cache read, cache write)
cost per success     mean cost / weighted pass rate
recommendation       lowest cost per success among models within 2 points of the best
                     pass rate, never RETIRED; INSUFFICIENT_EVIDENCE below the floor
regression           two-proportion test across a version change: p < 0.05 AND drop ≥ minimum
```

## Five design decisions

| Decision | Why |
|---|---|
| **Observe, never intercept** | If this system goes down, the customer's app keeps working |
| **Modular monolith** | One codebase, clear modules, four processes. Microservices are overkill for this scale |
| **Transactional outbox, no broker** | Nothing is lost or processed twice, with no Kafka/RabbitMQ to run. The database is the queue |
| **Three independent paths** | Each can be slow or fail without dragging the others down |
| **Swappable storage** | `VectorStoreClient` / `GraphStoreClient` interfaces; the graph store degrades to a no-op |

## Data model

The authoritative schema is [`db/schema.sql`](../db/schema.sql): `projects`, `jobs`, `runs`,
`recommendations`, `outbox`, `model_catalog`, `alerts`.

- `recommendations.consolidated_from` links a conclusion to every run behind it.
- `recommendations.superseded_by_id` links it to the conclusion that replaced it, with a date and
  reason, so history is never overwritten.
- `runs.model_version` is the provider-resolved snapshot; decay and regression tests key on it.

## API

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/jobs` | Define a job and its success check |
| `POST` | `/v1/runs` | Record a run |
| `POST` | `/v1/runs/{id}/label` | Supply a late outcome label |
| `GET` | `/v1/jobs/{job}/recommendation` | Cheapest model that passes, with evidence |
| `GET` | `/v1/jobs/{job}/regressions` | Open regression alerts |
| `GET` | `/v1/jobs/{job}/history` | What changed, when and why |
| `POST` | `/v1/jobs/{job}/retest` | Replay sampled runs on a candidate, under a budget |
| `GET` | `/v1/models` | Model catalog: status and shutdown dates |
| `GET` | `/v1/insights/spend` | Spend by job |
| `GET` | `/v1/jobs/{job}/insights` | Cost per success, pass rate by input size and prompt version |

## Repository layout

```
src/agent_memory/
├── config.py          env-driven settings
├── models.py          domain models (mirror db/schema.sql)
├── recorder.py        RunRecorder SDK
├── api.py             FastAPI routes
├── scheduler.py       scheduled maintenance process
├── checks/            OutcomeChecker interface, answer key, test command, schema, late label, sandbox
├── storage/           postgres, vector_store, graph_store (interfaces + connectors)
├── pipeline/          sync_worker, scoring (decay), consolidation, regression
├── recommend/         engine: cheapest that passes + evidence + forecast
├── retest/            budgeted, importance-sampled replay: the only code that spends money
├── catalog/           model catalog and daily sync
├── insights/          spend and pass-rate breakdowns
├── alerts/            alert records and webhook delivery
└── prompts/           the one prompt file the system owns
db/schema.sql · demo/ · scripts/ · tests/ · docker-compose.yml · Dockerfile · pyproject.toml
```

## Technology

Python 3.11 · FastAPI · Pydantic v2 · PostgreSQL + SQLAlchemy 2 + Alembic · pgvector with local
`all-MiniLM-L6-v2` embeddings · Neo4j (optional) · scipy · APScheduler · Docker sandbox for test
commands · `anthropic` and `openai` clients (the latter also reaches local Ollama) · Streamlit demo ·
docker-compose on one VPS behind Caddy (HTTPS).
