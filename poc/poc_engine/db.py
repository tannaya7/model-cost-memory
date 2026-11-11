"""SQLite storage for the POC.

The real system uses PostgreSQL (db/schema.sql). SQLite keeps the POC to one file and zero setup,
with the same tables in a smaller form. One connection per thread; WAL mode lets the API and the
sync worker read and write at the same time.
"""

import json
import os
import sqlite3
import threading

DB_PATH = os.environ.get(
    "POC_DB", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "poc.db")
)
_local = threading.local()

SCHEMA = """
CREATE TABLE IF NOT EXISTS projects (
    project_id  TEXT PRIMARY KEY,
    api_key     TEXT NOT NULL,           -- real system stores a hash, shown once
    webhook_url TEXT
);

CREATE TABLE IF NOT EXISTS jobs (
    job_id        TEXT PRIMARY KEY,      -- the job's name, e.g. 'invoice-extract'
    project_id    TEXT NOT NULL REFERENCES projects(project_id),
    description   TEXT,
    check_kind    TEXT NOT NULL,         -- ANSWER_KEY | SCHEMA
    check_config  TEXT NOT NULL,         -- JSON: how to decide PASS or FAIL
    retest_consent INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS model_catalog (
    model          TEXT NOT NULL,
    model_version  TEXT NOT NULL,
    status         TEXT NOT NULL,        -- ACTIVE | DEPRECATED | RETIRED
    shutdown_date  TEXT,
    superseded_by  TEXT,                 -- newer version of the same model, if any
    price_in       REAL NOT NULL,        -- $ per 1M input tokens
    price_out      REAL NOT NULL,        -- $ per 1M output tokens (thinking included)
    price_cache_read  REAL NOT NULL,
    price_cache_write REAL NOT NULL,
    PRIMARY KEY (model, model_version)
);

CREATE TABLE IF NOT EXISTS runs (
    run_id         TEXT PRIMARY KEY,
    job_id         TEXT NOT NULL REFERENCES jobs(job_id),
    project_id     TEXT NOT NULL,
    prompt         TEXT NOT NULL,
    prompt_hash    TEXT NOT NULL,
    prompt_version TEXT,
    model          TEXT NOT NULL,
    model_version  TEXT NOT NULL,
    tokens_in      INTEGER NOT NULL,
    tokens_out     INTEGER NOT NULL,
    cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd       REAL NOT NULL,
    latency_ms     INTEGER,
    output         TEXT,
    reference      TEXT,                 -- answer key sent with the run, if any (JSON)
    outcome        TEXT NOT NULL,        -- PASS | FAIL | UNKNOWN
    outcome_reason TEXT,
    run_kind       TEXT NOT NULL,        -- PRODUCTION | RETEST
    importance     REAL NOT NULL,
    stability      REAL NOT NULL,        -- S in R(t) = e^(-t/S), in days
    weight         REAL NOT NULL DEFAULT 1.0,
    state          TEXT NOT NULL,        -- CAPTURED | CHECKED | INDEXED | CONSOLIDATED | ARCHIVED
    created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runs_job_model ON runs(job_id, model, model_version);

CREATE TABLE IF NOT EXISTS outbox (
    outbox_id   INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id      TEXT NOT NULL REFERENCES runs(run_id),
    status      TEXT NOT NULL DEFAULT 'PENDING',   -- PENDING | DONE
    trace       INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS recommendations (
    recommendation_id  TEXT PRIMARY KEY,
    job_id             TEXT NOT NULL,
    model              TEXT NOT NULL,
    model_version      TEXT NOT NULL,
    verdict            TEXT NOT NULL,
    weighted_pass_rate REAL,
    cost_per_success   REAL,
    n_runs             INTEGER NOT NULL,
    evidence_weight    REAL NOT NULL,
    consolidated_from  TEXT NOT NULL,     -- JSON list of run ids: the proof
    superseded_by_id   TEXT,
    supersession_reason TEXT,             -- MODEL_UPGRADE | EVIDENCE_DECAYED | REGRESSION
    valid_at           TEXT NOT NULL,
    invalid_at         TEXT
);

CREATE TABLE IF NOT EXISTS alerts (
    alert_id     TEXT PRIMARY KEY,
    job_id       TEXT NOT NULL,
    kind         TEXT NOT NULL,           -- VERSION_REGRESSION | MODEL_DEPRECATED
    detail       TEXT NOT NULL,           -- JSON
    delivered_at TEXT,
    created_at   TEXT NOT NULL
);

-- POC only: a step-by-step trace so you can watch data move through the system.
CREATE TABLE IF NOT EXISTS events (
    event_id   INTEGER PRIMARY KEY AUTOINCREMENT,
    ts         TEXT NOT NULL,
    run_id     TEXT,
    stage      TEXT NOT NULL,
    message    TEXT NOT NULL,
    data       TEXT
);
"""


def conn() -> sqlite3.Connection:
    c = getattr(_local, "c", None)
    if c is None:
        c = sqlite3.connect(DB_PATH, timeout=30, check_same_thread=False)
        c.row_factory = sqlite3.Row
        c.execute("PRAGMA journal_mode=WAL")
        c.execute("PRAGMA foreign_keys=ON")
        _local.c = c
    return c


def rows(sql: str, args: tuple = ()) -> list[dict]:
    return [dict(r) for r in conn().execute(sql, args).fetchall()]


def one(sql: str, args: tuple = ()) -> dict | None:
    r = conn().execute(sql, args).fetchone()
    return dict(r) if r else None


def init() -> None:
    with conn() as c:
        c.executescript(SCHEMA)


def reset() -> None:
    with conn() as c:
        for t in ("events", "alerts", "recommendations", "outbox", "runs",
                  "model_catalog", "jobs", "projects"):
            c.execute(f"DELETE FROM {t}")


def dumps(x) -> str:
    return json.dumps(x, separators=(",", ":"))
