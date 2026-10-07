"""The write path: what happens when one run arrives at POST /v1/runs (tech plan 2.4).

  validate → price it from the catalog → check PASS/FAIL → score importance
  → save run + outbox row in ONE transaction → reply 202
  ... later, the sync worker claims the outbox row and marks the run INDEXED.
"""

import hashlib
import json
import threading
import time
import uuid

from . import catalog, checks, db, scoring, trace


class IngestError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def _job_mean_cost(job_id: str) -> float:
    r = db.one("SELECT AVG(cost_usd) AS m FROM runs WHERE job_id=?", (job_id,))
    return (r and r["m"]) or 0.0


def record_run(payload: dict, *, trace_it: bool = True, created_at: str | None = None) -> dict:
    """Ingest one run. `created_at` is only used by the simulator to back-date history."""
    run_id = uuid.uuid4().hex[:12]
    t = (lambda stage, msg, data=None: trace.log(stage, msg, run_id, data)) if trace_it else (lambda *a, **k: None)

    t("api", f"POST /v1/runs received for job '{payload.get('job')}'",
      {k: payload.get(k) for k in ("job", "model", "model_version", "tokens_in", "tokens_out",
                                   "cache_read_tokens", "cache_write_tokens", "prompt_version", "run_kind")})

    # 1. Validate --------------------------------------------------------------------------
    job = db.one("SELECT * FROM jobs WHERE job_id=?", (payload.get("job"),))
    if job is None:
        t("validate", "Rejected: unknown job (404). Jobs are never created automatically.")
        raise IngestError(404, f"unknown job '{payload.get('job')}'")
    for f in ("tokens_in", "tokens_out", "cache_read_tokens", "cache_write_tokens"):
        if int(payload.get(f) or 0) < 0:
            t("validate", f"Rejected: {f} is negative (422)")
            raise IngestError(422, f"{f} must be non-negative")
    entry = catalog.entry(payload["model"], payload["model_version"])
    if entry is None:
        t("validate", "Rejected: model version not in the catalog (422)")
        raise IngestError(422, f"unknown model version {payload['model']}/{payload['model_version']}")
    t("validate", "Valid: job exists, numbers are sane, model version is in the catalog",
      {"catalog_status": entry["status"]})

    # 2. Cost from reported usage × catalog price --------------------------------------------
    cost, parts = catalog.cost_usd(entry, payload["tokens_in"], payload["tokens_out"],
                                   payload.get("cache_read_tokens", 0), payload.get("cache_write_tokens", 0))
    t("cost", f"Cost computed from usage × catalog price: ${cost:.6f}", parts)

    # 3. Outcome check -----------------------------------------------------------------------
    outcome, reason = checks.check(job, payload.get("output"), payload.get("reference"))
    t("check", f"{job['check_kind']} check → {outcome}: {reason}")

    # 4. Importance and decay speed ----------------------------------------------------------
    imp = scoring.importance(outcome, cost, _job_mean_cost(job["job_id"]) or cost)
    vf = scoring.version_factor(entry)
    s = scoring.stability(imp, vf)
    t("score", f"Importance {imp} · version factor {vf} · fades with S = {s} days",
      {"importance": imp, "version_factor": vf, "stability_days": s})

    # 5. One transaction: the run AND its outbox row ------------------------------------------
    prompt = payload.get("prompt") or ""
    created = created_at or trace.now_iso()
    with db.conn() as c:
        c.execute(
            """INSERT INTO runs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (run_id, job["job_id"], job["project_id"], prompt,
             hashlib.sha256(prompt.encode()).hexdigest()[:16], payload.get("prompt_version"),
             payload["model"], payload["model_version"], payload["tokens_in"], payload["tokens_out"],
             payload.get("cache_read_tokens", 0), payload.get("cache_write_tokens", 0), cost,
             payload.get("latency_ms"), payload.get("output"),
             json.dumps(payload["reference"]) if payload.get("reference") is not None else None,
             outcome, reason, payload.get("run_kind", "PRODUCTION"), imp, s, 1.0, "CHECKED", created),
        )
        c.execute("INSERT INTO outbox (run_id, trace, created_at) VALUES (?,?,?)",
                  (run_id, 1 if trace_it else 0, created))
    t("store", "Saved run + outbox row in ONE transaction → state CHECKED. Replying 202 Accepted.")

    return {"run_id": run_id, "outcome": outcome, "reason": reason, "cost_usd": cost,
            "state": "CHECKED", "status": 202}


# ---------------------------------------------------------------------------------------------
# Sync worker: drains the outbox in the background (the real one also writes embeddings to
# pgvector and lineage to Neo4j). Postgres would claim rows with SELECT … FOR UPDATE SKIP LOCKED;
# SQLite has one writer at a time, so a single worker thread is enough here.

def drain_outbox(limit: int = 500) -> int:
    pending = db.rows("SELECT * FROM outbox WHERE status='PENDING' ORDER BY outbox_id LIMIT ?", (limit,))
    if not pending:
        return 0
    with db.conn() as c:
        for row in pending:
            c.execute("UPDATE runs SET state='INDEXED' WHERE run_id=? AND state='CHECKED'", (row["run_id"],))
            c.execute("UPDATE outbox SET status='DONE' WHERE outbox_id=?", (row["outbox_id"],))
    for row in pending:
        if row["trace"]:
            trace.log("worker", "Sync worker claimed the outbox row, indexed the run → state INDEXED "
                      "(real system: prompt embedding to pgvector + lineage to Neo4j)", row["run_id"])
    return len(pending)


def start_worker(stop: threading.Event) -> threading.Thread:
    def loop():
        while not stop.is_set():
            try:
                drain_outbox()
            except Exception as exc:  # keep the worker alive; the outbox keeps the work safe
                trace.log("worker", f"Worker error, will retry: {exc}")
            time.sleep(1.0)

    th = threading.Thread(target=loop, name="sync-worker", daemon=True)
    th.start()
    return th
