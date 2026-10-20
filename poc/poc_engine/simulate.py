"""Demo data: sets up a project and two jobs, and simulates past traffic through the real SDK and
the real ingest path, so the answers have weeks of evidence behind them.

The story in the simulated 30 days (invoice-extract):
  days 30–26  the app used 'classic'           (since RETIRED by its provider)
  days 25–15  the app used 'pro-2026-03'
  days 14–0   the provider upgraded to 'pro-2026-09', which quietly got worse
  every day   re-tests replayed a few invoices on 'mini' and 'max' to gather evidence
ticket-classify: the app uses expensive 'max'; re-tests show 'mini' does the job just as well.
"""

import random
from datetime import datetime, timedelta, timezone

from . import catalog, db, engine, fake_models, ingest, trace
from .sdk import RunRecorder

API_KEY = "demo-key"
JOBS = [
    ("invoice-extract", "Extract vendor, invoice number, date and total from an invoice", "ANSWER_KEY",
     {"fields": ["vendor", "invoice_number", "date", "total"]}),
    ("ticket-classify", "Label a support ticket with a category and a priority", "SCHEMA",
     {"required": {"category": "string", "priority": "integer"},
      "allowed": {"category": fake_models.CATEGORIES}}),
]


def setup() -> None:
    db.init()
    db.reset()
    catalog.seed()
    with db.conn() as c:
        c.execute("INSERT INTO projects VALUES (?,?,?)", ("demo", API_KEY, "https://hooks.example.com/model-cost-memory"))
        for job_id, desc, kind, cfg in JOBS:
            c.execute("INSERT INTO jobs VALUES (?,?,?,?,?,?)", (job_id, "demo", desc, kind, db.dumps(cfg), 1))
    trace.log("setup", "Fresh start: project 'demo' (API key demo-key), jobs 'invoice-extract' and "
              "'ticket-classify', model catalog with 5 model versions")


def _schedule(day: int) -> list[tuple[str, str, str, str, int]]:
    """(job, model_version, run_kind, prompt_version, count) for one simulated day."""
    if day > 25:
        inv_prod = "classic-2025-11"
    elif day > 14:
        inv_prod = "pro-2026-03"
    else:
        inv_prod = "pro-2026-09"
    return [
        ("invoice-extract", inv_prod, "PRODUCTION", "v1", 18),
        ("invoice-extract", "mini-2026-06", "RETEST", "v1", 5),
        ("invoice-extract", "mini-2026-06", "RETEST", "v2", 5),
        ("invoice-extract", "max-2026-05", "RETEST", "v1", 4),
        ("ticket-classify", "max-2026-05", "PRODUCTION", "v1", 15),
        ("ticket-classify", "mini-2026-06", "RETEST", "v1", 5),
        ("ticket-classify", "pro-2026-09", "RETEST", "v1", 3),
    ]


def _one_run(job, version, run_kind, prompt_version, rng, ts, first_today, trace_it=False) -> dict:
    make = fake_models.make_invoice if job == "invoice-extract" else fake_models.make_ticket
    prompt, reference, tokens_in = make(rng)
    response = fake_models.call(version, job, prompt, reference, tokens_in, prompt_version, rng, first_today)
    sink = lambda payload: ingest.record_run(payload, trace_it=trace_it, created_at=ts)
    with RunRecorder(job=job, prompt_version=prompt_version, run_kind=run_kind,
                     transport=sink, background=False) as rec:
        rec.capture(prompt, response, reference=reference)
    return rec.result


def simulate(days: int = 30, seed: int = 7) -> dict:
    rng = random.Random(seed)
    now = datetime.now(timezone.utc)
    trace.log("simulate", f"Simulating {days} days of traffic through the SDK and POST /v1/runs ...")
    count = 0
    for day in range(days, 0, -1):
        start = now - timedelta(days=day)
        first = True
        for job, version, kind, pv, n in _schedule(day):
            for _ in range(n):
                ts = (start + timedelta(seconds=rng.randint(0, 86000))).isoformat()
                _one_run(job, version, kind, pv, rng, ts, first)
                first = False
                count += 1
        if day == 15:   # the scheduler ran halfway through, before the provider's upgrade
            ingest.drain_outbox(limit=100000)
            engine.run_maintenance(now=start + timedelta(days=1))
    ingest.drain_outbox(limit=100000)
    trace.log("simulate", f"Done: {count} runs recorded over {days} days. Next: run the scheduled jobs "
              "to detect regressions and write recommendations.")
    return {"runs_recorded": count, "days": days}


def customer_call(job: str, model: str, prompt_version: str = "v1") -> dict:
    """One call from the 'customer's app', recorded through the SDK with full tracing."""
    rng = random.Random()
    entry = catalog.latest_version(model)
    if entry is None:
        return {"error": f"unknown model {model}"}
    trace.log("app", f"Customer app: calling {model} for '{job}' (prompt {prompt_version})")
    if entry["status"] == "RETIRED":
        trace.log("app", f"Provider refused: {entry['model_version']} was retired on "
                  f"{entry['shutdown_date']}. Nothing to record.")
        return {"error": f"{entry['model_version']} is retired and can no longer be called"}
    make = fake_models.make_invoice if job == "invoice-extract" else fake_models.make_ticket
    prompt, reference, tokens_in = make(rng)
    response = fake_models.call(entry["model_version"], job, prompt, reference, tokens_in, prompt_version, rng)
    trace.log("app", f"Provider answered in {response['latency_ms']} ms; the app uses the answer as normal",
              data={"output": response["output"], "usage": response["usage"]})
    trace.log("sdk", "RunRecorder captured the run and is sending it to POST /v1/runs "
              "(in the background in a real app)")
    with RunRecorder(job=job, prompt_version=prompt_version,
                     transport=lambda p: ingest.record_run(p, trace_it=True), background=False) as rec:
        rec.capture(prompt, response, reference=reference)
    return {"app_saw": {"prompt": prompt, "output": response["output"], "usage": response["usage"],
                        "latency_ms": response["latency_ms"]},
            "answer_key": reference, "recorded": rec.result}
