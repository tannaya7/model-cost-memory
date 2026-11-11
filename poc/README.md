# Engine V1: proof of concept

A small, working version of Model & Cost Memory you can run on your laptop and watch. It has the
real API, a real SDK, and the real analysis from the technical plan. The AI models are simulated,
so it needs no API keys and costs nothing.

## Run it

```bash
cd poc
.venv\Scripts\activate            # Windows (the venv is already created)
pip install -r requirements.txt   # only if you made a fresh venv
python -m poc_engine
```

Open **http://127.0.0.1:8000**. Interactive API docs are at **/docs**. The API key is `demo-key`.

## A guided tour (10 minutes)

1. **Simulate 30 days of traffic.** About 1,650 runs from two jobs go through the SDK and
   `POST /v1/runs`, exactly like real calls. The answers fill in.
2. **Run the scheduled jobs.** Watch the log: decay, then the regression check catches the `pro`
   upgrade, the recommendation is replaced (history shows why), and alerts go to the webhook.
3. **Make one call from the customer's app.** Pick a job and model and watch that single run travel
   through every step in the log, while the pipeline at the top lights up.
4. **Send your own run.** Edit the JSON and post it. Break the output to see the check fail, change
   the job name to see a 404, remove the key to see a 401.
5. **Try `classic`.** It's retired: the provider refuses the call and nothing is recorded.
6. **Run the real customer app over HTTP** (second terminal, engine still running):
   `python customer_app.py max 5 v2`

## The cycle: input → processing → output

```
INPUT          The customer's app calls its AI model as usual. The SDK (RunRecorder) wraps that
               call and sends a copy: prompt, model, resolved version, tokens, cost inputs, output,
               and the answer key if the app knows it.

PROCESSING     write path (instant, per run)
               validate → cost = tokens × catalog price → pass/fail check → importance score
               → run + outbox row saved in ONE transaction → 202 → sync worker marks it INDEXED

               maintenance path (scheduled)
               decay weights → regression test across version changes → consolidate into a
               recommendation (old one kept, with a reason) → catalog check → alerts to webhook

OUTPUT         read path (when the engineer asks)
               recommendation: which model, pass rate, cost per success, money and failures per
               month, warnings, the failing runs behind it · alerts · history · breakdowns by
               input size and prompt version · spend by job · catalog · raw runs
```

## The story in the simulated data

| Job | What happened | What the engine concludes |
|---|---|---|
| invoice-extract | Used `classic` (now retired), then `pro-2026-03`. On day 14 the provider upgraded to `pro-2026-09`, which is worse | **Regression alert**, then **SWITCH to `max`**: costs ~$8/month more, ~33 fewer failures. History: `pro` replaced for reason REGRESSION |
| ticket-classify | The app uses expensive `max`; re-tests show `mini` does just as well | **DOWNGRADE to `mini`**, saving ~$5/month. Warning: `mini` shuts down 31 Dec, the next option is `pro` |
| both | `mini` is cheap but weak on long invoices; prompt v2 helps it | Breakdowns show it by input size and by prompt version |

## Which file is which part of the design

| File | Design piece (tech plan section) |
|---|---|
| `poc_engine/sdk.py` | Run Recorder SDK (3.12) |
| `poc_engine/api.py` | API endpoints (3.3) |
| `poc_engine/ingest.py` | Write path, transactional outbox, sync worker (2.4, 3.6) |
| `poc_engine/checks.py` | Outcome checkers: answer key and schema (3.1) |
| `poc_engine/catalog.py` | Model catalog and cost calculation (3.13) |
| `poc_engine/scoring.py` | Importance and decay `R(t) = e^(−t/S)` (3.4) |
| `poc_engine/engine.py` | Recommendation, regression test, consolidation, history, insights, scheduler (3.4, 3.5) |
| `poc_engine/fake_models.py` | Simulated AI provider (stands in for real models) |
| `poc_engine/simulate.py` | Demo data, 30 days of traffic |
| `poc_engine/static/index.html` | The page you look at |
| `customer_app.py` | An example customer app using the SDK over HTTP |

## Endpoints

```bash
curl -H "X-API-Key: demo-key" http://127.0.0.1:8000/v1/jobs/invoice-extract/recommendation
curl -H "X-API-Key: demo-key" http://127.0.0.1:8000/v1/jobs/invoice-extract/regressions
curl -H "X-API-Key: demo-key" http://127.0.0.1:8000/v1/jobs/invoice-extract/history
curl -H "X-API-Key: demo-key" http://127.0.0.1:8000/v1/jobs/invoice-extract/insights
curl -H "X-API-Key: demo-key" http://127.0.0.1:8000/v1/insights/spend
curl -H "X-API-Key: demo-key" http://127.0.0.1:8000/v1/models
curl -H "X-API-Key: demo-key" -X POST http://127.0.0.1:8000/v1/maintenance/run
```

## What's simplified compared with the real design

| Real design | In this POC |
|---|---|
| PostgreSQL + `pgvector` | SQLite file `poc.db` (same tables, smaller) |
| Similar-run search with embeddings | Not included (the worker only marks runs INDEXED) |
| Lineage queries (recursive SQL) | Not included |
| Test commands in a Docker sandbox | Answer-key and schema checks only |
| Real providers and Ollama | Simulated models with realistic accuracy, tokens and prices |
| Scheduler on a timer, webhook over HTTP | A button; webhook delivery is logged, not sent |
| Hashed API keys, per-project isolation | One demo project and a plain key |

## Something the POC already taught us

In one random draw, `pro` scored 100% on only 90 runs. That raised the "best" bar and pushed
`mini` (98%) just outside the 2-point tolerance, even though both were really equally good. Comparing
models on raw pass rates is fragile with small samples. **Idea for the real build:** compare using
confidence ranges (for example, Wilson intervals), or require a minimum number of runs before a model
can set the bar.
