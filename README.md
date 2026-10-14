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
- Each run is checked automatically (an answer key or a JSON schema, or a label supplied later) and stored
  with the reason it passed or failed.
- Evidence fades with age, faster for model versions that have been superseded, so conclusions stay
  current without anyone curating a test set.
- Scheduled jobs consolidate runs into recommendations, detect regressions across version changes,
  track model retirements, and re-test new models within a budget.

Full design: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) ·
illustrated walkthrough: [`docs/Architecture_Overview.pdf`](docs/Architecture_Overview.pdf) ·
database schema: [`db/schema.sql`](db/schema.sql) · API contract: [`contract/`](contract/)

## Status

| Weeks | Milestone | State |
|---|---|---|
| 1 | Repository, schema, architecture | done |
| 2 | Data model, migrations, API contract | done |
| 3 | Recorder SDK, idempotent ingest, project keys | done |
| 4 | Outcome checkers, invoice-extraction corpus | done |
| 5 | Sync worker, pgvector search, outbox janitor, server files | done (server files not yet run on a real server) |
| 6 | Importance and decay, model catalog | done |
| 7–8 | Recommendation engine, public deployment, consolidation, history | next |
| 9–12 | Regression detection and alerts, re-test runner, sign-in, staleness experiment | planned |

## Getting started

Development needs Python 3.11+ and a PostgreSQL database with the pgvector extension. A free hosted
[Neon](https://neon.tech) database works well and needs no Docker. Tests need neither: they start their own
embedded Postgres.

```bash
python -m venv .venv && source .venv/bin/activate     # Windows: .venv\Scripts\activate
pip install -e ".[dev]"
cp .env.example .env                                  # set DATABASE_URL to your database

alembic upgrade head                                  # create the tables
python scripts/create_project.py my-company           # prints the project key once; copy it
python scripts/sync_catalog.py                        # model prices and shutdown dates (optional)

uvicorn agent_memory.api:app --reload                 # the API on http://127.0.0.1:8000
python -m agent_memory.pipeline.sync_worker           # embeds recorded runs (second terminal)
python -m agent_memory.scheduler                      # maintenance jobs (third terminal)
```

Record a call from your own code:

```python
from agent_memory.recorder import RunRecorder

with RunRecorder(job="invoice-extract") as rec:
    response = client.chat.completions.create(model="my-model", messages=[...])   # your call, unchanged
    rec.capture(response, prompt=prompt, model="my-model", expected={"total": 1250.0})
```

Set `MCM_API_KEY` to the project key (and `MCM_API_URL` if the API is not local). The recorder sends in the
background, adds well under 5 ms, and never raises into your application.

Try it with the built-in corpus of invoices with known answers (a local Ollama model is free):

```bash
python scripts/build_corpus.py
python scripts/run_corpus.py --model llama3.2 --limit 50
```

Run the tests and lint:

```bash
pytest
ruff check .
```

Docker is for the server only. See [`deploy/README.md`](deploy/README.md).

## Contributing

Branch names, commit messages and sign-off rules are in [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Team

Tannaya Supriya · Rajeshwaree Parida — GenAI track, AI/ML Infrastructure (Agent Memory Systems).
