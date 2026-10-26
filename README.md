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
- A cheaper model is recommended only when the system is **95% sure it is at most 3 points worse** than the
  best, ranked by **cost per successful run**, with a savings forecast and the failing runs behind it.
- Scheduled jobs store each changed verdict with its lineage, detect regressions across version changes (and
  silent drops under an unchanged name), alert a signed webhook, track model retirements, and **re-test**
  cheaper candidates on the customer's own key, always within a budget and a monthly cap.
- A React web app: Google sign-in, projects and keys, recommendations, evidence, history, alerts, re-tests,
  spend, breakdowns and a live view of runs crossing the pipeline.

Full design: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) ·
illustrated walkthrough: [`docs/Architecture_Overview.pdf`](docs/Architecture_Overview.pdf) ·
database schema: [`db/schema.sql`](db/schema.sql) · API contract: [`contract/`](contract/) ·
measured results: [`reports/`](reports/)

## Status

| Weeks | Milestone | State |
|---|---|---|
| 1–6 | Repository, data model, SDK and ingest, outcome checks, sync worker and vector search, decay, model catalog | done |
| 7 | Recommendation engine (95% intervals, 3-point tolerance), spend by job | done |
| 8 | Consolidation, supersession, history and lineage, result cache, savings forecast | done |
| 9 | Simulated-time harness, regression and silent-drop detection, signed webhook alerts | done |
| 10 | Re-test runner: budget and cap before every call, just-in-time provider key, automatic triggers | done |
| 11 | Google sign-in, project ownership and setup, public read-only demo, breakdown insights | done |
| 12 | Staleness experiment, live data-flow view (SSE), optional recommendation summary | done |
| — | Public deployment on the server | waiting for the server and domain |

## Results

Simulated data, run through the production engine, decay, consolidation and regression code:

- **Staleness experiment** ([report](reports/staleness_experiment.md)): as the workload drifts and a new model
  version arrives, a curated evidence set frozen at day 14 stops picking the right model, while the
  self-maintaining memory keeps up.
- **Regression detection** ([data](reports/regression_detection.json)), 20 trials per size: no false alarms;
  drops of 10 and 15 points caught every time; drops of exactly 5 points 75% of the time.

Reproduce with `python scripts/staleness_experiment.py` and `python scripts/simulate.py` (an embedded
Postgres is started for them).

## Getting started

Development needs Python 3.11+ and a PostgreSQL database with the pgvector extension. A free hosted
[Neon](https://neon.tech) database works well and needs no Docker. Tests need neither: they start their own
embedded Postgres.

```bash
python -m venv .venv && source .venv/bin/activate     # Windows: .venv\Scripts\activate
pip install -e ".[dev]"
cp .env.example .env                                  # set DATABASE_URL and SECRET_KEY

alembic upgrade head                                  # create the tables
python scripts/create_project.py my-company           # prints the project key once; copy it
python scripts/sync_catalog.py                        # model prices and shutdown dates (optional)

uvicorn agent_memory.api:app --reload                 # the API on http://127.0.0.1:8000
python -m agent_memory.pipeline.sync_worker           # embeds recorded runs (second terminal)
python -m agent_memory.scheduler                      # maintenance, regressions, re-tests (third terminal)

cd frontend && npm ci && npm run dev                  # the web app on http://localhost:5174
```

Open the web app and either paste the project key in **Settings**, or sign in: with `GOOGLE_CLIENT_ID` and
`GOOGLE_CLIENT_SECRET` set, through Google; on a development machine, with `DEV_LOGIN=true`, by email.

Record a call from your own code:

```python
from agent_memory.recorder import RunRecorder

with RunRecorder(job="invoice-extract") as rec:
    response = client.chat.completions.create(model="my-model", messages=[...])   # your call, unchanged
    rec.capture(response, prompt=prompt, model="my-model", expected={"total": 1250.0})
```

Set `MCM_API_KEY` to the project key (and `MCM_API_URL` if the API is not local). The recorder sends in the
background, adds well under 5 ms, and never raises into your application.

Try it with the built-in corpus of invoices with known answers, on a free hosted model:

```bash
python scripts/build_corpus.py
python scripts/run_corpus.py --model <a Gemini model name> --limit 50 \
    --base-url https://generativelanguage.googleapis.com/v1beta/openai/ --api-key-env GEMINI_API_KEY
```

Pick a model your key's free tier offers that is also in the price catalog (`GET /v1/models?q=gemini`), so each
run is priced at its real list price. Groq works the same way with `--base-url https://api.groq.com/openai/v1`.

Or fill a demo project with 90 days of simulated history (recommendations that change, a regression alert,
spend), and let anyone read it without signing in:

```bash
python scripts/seed_demo.py --database-url "$DATABASE_URL"     # then set DEMO_PROJECT_ID=demo
```

Re-tests run on the customer's own provider key, asked for in the web app the first time a re-test needs it
and stored encrypted with `SECRET_KEY`. Every re-test has a budget, and every project a monthly cap (default
$10, counted at list price so it limits free keys too), checked before each call.

Logs are JSON lines carrying `run_id`, `job_id` and `project_id`, so one run can be followed end to end
(`LOG_FORMAT=text` gives a readable form for a terminal). To check that the sync worker is healthy:

```bash
python scripts/outbox_status.py        # prints the queue counts; exits 1 if anything is failed, stuck or slow
```

Tool-call arguments can hold sensitive data, so only each tool's name and call id are kept. A project can opt in
to keeping arguments with `create_project.py --store-tool-arguments`.

Run the tests and lint:

```bash
pytest
ruff check .
cd frontend && npm run build
```

Docker is for the server only. See [`deploy/README.md`](deploy/README.md).

## Contributing

Branch names, commit messages and sign-off rules are in [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Team

Tannaya Supriya · Rajeshwaree Parida — GenAI track, AI/ML Infrastructure (Agent Memory Systems).
