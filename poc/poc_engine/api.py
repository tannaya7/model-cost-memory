"""The HTTP API (tech plan 3.3). Every /v1 route needs the project's key in the X-API-Key header.

Write:        POST /v1/jobs · POST /v1/runs · POST /v1/runs/{id}/label
Read:         GET  /v1/jobs · /v1/runs · /v1/jobs/{job}/recommendation · /regressions · /history
              GET  /v1/jobs/{job}/insights · /v1/insights/spend · /v1/models
Maintenance:  POST /v1/maintenance/run      (the real system runs this on a timer)
POC only:     GET /v1/flow · POST /demo/reset · /demo/simulate · /demo/customer-call · GET /
"""

import json
import os
import threading
from contextlib import asynccontextmanager
from typing import Any

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from . import catalog, checks, db, engine, ingest, simulate, trace

STATIC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
_stop = threading.Event()


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init()
    if db.one("SELECT 1 FROM projects") is None:
        simulate.setup()
    ingest.start_worker(_stop)
    yield
    _stop.set()


app = FastAPI(title="Model & Cost Memory — POC engine", lifespan=lifespan)


def project(x_api_key: str = Header(default="")) -> dict:
    p = db.one("SELECT * FROM projects WHERE api_key=?", (x_api_key,))
    if p is None:
        raise HTTPException(401, "missing or wrong X-API-Key")
    return p


def _job_or_404(job: str) -> dict:
    j = db.one("SELECT * FROM jobs WHERE job_id=?", (job,))
    if j is None:
        raise HTTPException(404, f"unknown job '{job}'")
    return j


# ----------------------------------------------------------------------------------- models
class JobIn(BaseModel):
    name: str = Field(examples=["invoice-extract"])
    description: str = ""
    check_kind: str = Field(pattern="^(ANSWER_KEY|SCHEMA)$")
    check_config: dict[str, Any]
    retest_consent: bool = True


class RunIn(BaseModel):
    job: str = Field(examples=["invoice-extract"])
    model: str = Field(examples=["mini"])
    model_version: str = Field(examples=["mini-2026-06"])
    prompt: str = ""
    prompt_version: str | None = None
    tokens_in: int = Field(ge=0)
    tokens_out: int = Field(ge=0)
    cache_read_tokens: int = Field(default=0, ge=0)
    cache_write_tokens: int = Field(default=0, ge=0)
    latency_ms: int | None = None
    output: str
    reference: dict[str, Any] | None = None
    run_kind: str = Field(default="PRODUCTION", pattern="^(PRODUCTION|RETEST)$")


class LabelIn(BaseModel):
    outcome: str = Field(pattern="^(PASS|FAIL)$")


class CustomerCallIn(BaseModel):
    job: str = "invoice-extract"
    model: str = "mini"
    prompt_version: str = "v1"


# ------------------------------------------------------------------------------ write routes
@app.post("/v1/jobs", status_code=201)
def create_job(body: JobIn, p: dict = Depends(project)):
    with db.conn() as c:
        c.execute("INSERT OR REPLACE INTO jobs VALUES (?,?,?,?,?,?)",
                  (body.name, p["project_id"], body.description, body.check_kind,
                   json.dumps(body.check_config), int(body.retest_consent)))
    trace.log("api", f"Job '{body.name}' defined with a {body.check_kind} check")
    return {"job": body.name, "check_kind": body.check_kind}


@app.post("/v1/runs", status_code=202)
def post_run(body: RunIn, p: dict = Depends(project)):
    try:
        return ingest.record_run(body.model_dump(), trace_it=True)
    except ingest.IngestError as e:
        raise HTTPException(e.status, e.message)


@app.post("/v1/runs/{run_id}/label")
def label_run(run_id: str, body: LabelIn, p: dict = Depends(project)):
    r = db.one("SELECT * FROM runs WHERE run_id=?", (run_id,))
    if r is None:
        raise HTTPException(404, "unknown run")
    with db.conn() as c:
        c.execute("UPDATE runs SET outcome=?, outcome_reason=? WHERE run_id=?",
                  (body.outcome, "labelled later by the engineer", run_id))
    trace.log("label", f"Late label: run is now {body.outcome}", run_id)
    return {"run_id": run_id, "outcome": body.outcome}


# ------------------------------------------------------------------------------- read routes
@app.get("/v1/jobs")
def list_jobs(p: dict = Depends(project)):
    out = db.rows("SELECT j.*, (SELECT COUNT(*) FROM runs r WHERE r.job_id=j.job_id) AS runs FROM jobs j")
    for j in out:
        j["check_config"] = json.loads(j["check_config"])
    return out


@app.get("/v1/runs")
def list_runs(job: str | None = None, limit: int = 25, p: dict = Depends(project)):
    sql = ("SELECT run_id, job_id, model, model_version, prompt_version, run_kind, tokens_in, tokens_out, "
           "cache_read_tokens, cache_write_tokens, cost_usd, latency_ms, outcome, outcome_reason, "
           "importance, stability, weight, state, created_at FROM runs")
    args: tuple = ()
    if job:
        sql += " WHERE job_id=?"
        args = (job,)
    return db.rows(sql + " ORDER BY created_at DESC LIMIT ?", args + (min(limit, 200),))


@app.get("/v1/jobs/{job}/recommendation")
def get_recommendation(job: str, p: dict = Depends(project)):
    _job_or_404(job)
    trace.log("read", f"GET recommendation for '{job}': load runs → weight by freshness → per-model "
              "pass rate and cost per success → drop retired → evidence floor → cheapest within tolerance")
    return engine.recommend(job)


@app.get("/v1/jobs/{job}/regressions")
def get_regressions(job: str, p: dict = Depends(project)):
    _job_or_404(job)
    return engine.regressions(job)


@app.get("/v1/jobs/{job}/history")
def get_history(job: str, p: dict = Depends(project)):
    _job_or_404(job)
    return engine.history(job)


@app.get("/v1/jobs/{job}/insights")
def get_insights(job: str, p: dict = Depends(project)):
    _job_or_404(job)
    return engine.insights(job)


@app.get("/v1/insights/spend")
def get_spend(p: dict = Depends(project)):
    return engine.spend()


@app.get("/v1/models")
def get_models(p: dict = Depends(project)):
    return catalog.all_entries()


@app.post("/v1/maintenance/run")
def post_maintenance(p: dict = Depends(project)):
    ingest.drain_outbox()
    return engine.run_maintenance()


# --------------------------------------------------------------------------------- POC only
@app.get("/v1/flow")
def get_flow(after: int = 0, limit: int = 200, p: dict = Depends(project)):
    out = db.rows("SELECT * FROM events WHERE event_id>? ORDER BY event_id DESC LIMIT ?", (after, limit))
    for e in out:
        e["data"] = json.loads(e["data"]) if e["data"] else None
    return list(reversed(out))


@app.post("/demo/reset")
def demo_reset(p: dict = Depends(project)):
    simulate.setup()
    return {"ok": True}


@app.post("/demo/simulate")
def demo_simulate(days: int = 30, p: dict = Depends(project)):
    return simulate.simulate(days=min(max(days, 1), 60))


@app.post("/demo/customer-call")
def demo_customer_call(body: CustomerCallIn, p: dict = Depends(project)):
    _job_or_404(body.job)
    return simulate.customer_call(body.job, body.model, body.prompt_version)


@app.get("/")
def index():
    return FileResponse(os.path.join(STATIC, "index.html"))
