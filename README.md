# Model & Cost Memory

A long-term memory of an AI system's **own performance**. It records every production model run
with its cost and a machine-checked pass/fail, then answers two questions teams can't answer today:

1. **Which model is the cheapest that still does each job properly?**
2. **Did the last model upgrade quietly break something?**

Every answer comes with the runs behind it, failures included, and a dated history of what was
recommended and why it changed.

![Architecture](docs/assets/diagrams/architecture_overview_v3.png)

## How it works

- A small SDK (`RunRecorder`) wraps the app's existing model call and sends a copy of each run in
  the background. The production call never passes through this system.
- Each run is checked automatically (answer key, tests in a sandbox, or schema) and stored.
- Evidence fades with age, faster for model versions that have been superseded, so conclusions stay
  current without anyone curating a test set.
- Scheduled jobs consolidate runs into recommendations, detect regressions across version changes,
  track model retirements, and re-test new models within a budget.

Full design: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) ·
illustrated walkthrough: [`docs/Architecture_Overview.pdf`](docs/Architecture_Overview.pdf) ·
database schema: [`db/schema.sql`](db/schema.sql)

## Status

**Week 1 of 12: repository structure and architecture.** Modules exist with their responsibilities
documented; logic is implemented week by week.

| Weeks | Milestone |
|---|---|
| 1–4 | Record and check: data model, SDK and ingest API, outcome checkers with sandbox |
| 5–8 | Score and recommend: similar-run search, decay, model catalog, recommendations, history. **Public deployment from Week 7** |
| 9–12 | Detect, prove and ship: regression alerts, re-test runner, lineage graph, staleness experiment, demo |

## Getting started

```bash
cp .env.example .env
docker compose up -d db          # Postgres with pgvector; db/schema.sql is applied on first start
pip install -e ".[dev]"
pytest
```

The API, worker, scheduler and demo UI are already defined in `docker-compose.yml` under the
`full` profile and are switched on as they are implemented.

## Team

Tannaya Supriya · Rajeshwaree Parida — GenAI track, AI/ML Infrastructure (Agent Memory Systems).
