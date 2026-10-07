-- Model & Cost Memory: database schema (PostgreSQL 16+)
-- Source of truth: docs/ARCHITECTURE.md. Migrations (Alembic) will be generated from this in Week 2.
-- Requires: CREATE EXTENSION IF NOT EXISTS pgcrypto;  (gen_random_uuid)
--           CREATE EXTENSION IF NOT EXISTS vector;    (pgvector, once approved)

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE projects (
    project_id    TEXT PRIMARY KEY,
    api_key_hash  TEXT NOT NULL,                    -- the key itself is shown once, never stored
    webhook_url   TEXT,                             -- regression alerts; optional
    retest_monthly_cap_usd NUMERIC(8,2) NOT NULL DEFAULT 10,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE jobs (
    job_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id    TEXT NOT NULL REFERENCES projects(project_id),
    name          TEXT NOT NULL,                    -- 'invoice-extract'
    check_kind    TEXT NOT NULL CHECK (check_kind IN
                    ('ANSWER_KEY','TEST_COMMAND','SCHEMA','LATE_LABEL')),
    check_config  JSONB NOT NULL,
    retest_consent BOOLEAN NOT NULL DEFAULT false, -- may prompts go to another provider?
    UNIQUE (project_id, name)
);

CREATE TABLE runs (
    run_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id            UUID NOT NULL REFERENCES jobs(job_id),
    project_id        TEXT NOT NULL,
    prompt            TEXT NOT NULL,
    prompt_hash       TEXT NOT NULL,                -- dedupe + cache key
    model             TEXT NOT NULL,
    model_version     TEXT NOT NULL,                -- provider-resolved; what decay is keyed to
    prompt_version    TEXT,                         -- optional template version (Should)
    tokens_in         INT NOT NULL DEFAULT 0,
    tokens_out        INT NOT NULL DEFAULT 0,
    cost_usd          NUMERIC(12,6) NOT NULL DEFAULT 0,
    latency_ms        INT,
    output            TEXT,
    tool_calls        JSONB,                        -- optional; names + ids only by default (Could)
    outcome           TEXT NOT NULL DEFAULT 'UNKNOWN'
                        CHECK (outcome IN ('PASS','FAIL','UNKNOWN')),
    run_kind          TEXT NOT NULL DEFAULT 'PRODUCTION'
                        CHECK (run_kind IN ('PRODUCTION','SHADOW','RETEST')),
    memory_type       TEXT NOT NULL DEFAULT 'EPISODIC'   -- one run
                        CHECK (memory_type IN ('EPISODIC','SEMANTIC')),
    importance_score  REAL NOT NULL DEFAULT 1.0,
    stability         REAL NOT NULL DEFAULT 1.0,    -- days; 3.4
    state             TEXT NOT NULL DEFAULT 'CAPTURED'
                        CHECK (state IN ('CAPTURED','CHECKED','INDEXED',
                                         'CONSOLIDATED','ARCHIVED','INGESTION_FAILED')),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    invalid_at        TIMESTAMPTZ
);
CREATE INDEX idx_runs_job_model ON runs(job_id, model, model_version);
CREATE INDEX idx_runs_prompt_hash ON runs(prompt_hash);
-- with pgvector (1.7): embedding vector(384) on runs, HNSW index, filtered by project_id

CREATE TABLE recommendations (
    recommendation_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id             UUID NOT NULL REFERENCES jobs(job_id),
    model              TEXT NOT NULL,
    model_version      TEXT NOT NULL,
    verdict            TEXT NOT NULL CHECK (verdict IN
                         ('SWITCH','HOLD','DOWNGRADE','INSUFFICIENT_EVIDENCE')),
    weighted_pass_rate REAL,
    mean_cost_usd      NUMERIC(12,6),
    n_runs             INT NOT NULL,
    evidence_weight    REAL NOT NULL,               -- sum of R(t)
    consolidated_from  UUID[] NOT NULL DEFAULT '{}',-- the proof
    superseded_by_id   UUID REFERENCES recommendations(recommendation_id),
    supersession_reason TEXT,                       -- MODEL_UPGRADE | EVIDENCE_DECAYED | REGRESSION
    memory_type        TEXT NOT NULL DEFAULT 'SEMANTIC',  -- derived from many
    valid_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    invalid_at         TIMESTAMPTZ
);
CREATE INDEX idx_rec_current ON recommendations(job_id) WHERE invalid_at IS NULL;

CREATE TABLE outbox (
    outbox_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id       UUID REFERENCES runs(run_id),
    op           TEXT NOT NULL CHECK (op IN ('UPSERT','INVALIDATE','RETEST')),
    payload      JSONB NOT NULL,
    status       TEXT NOT NULL DEFAULT 'PENDING'
                   CHECK (status IN ('PENDING','PROCESSING','DONE','FAILED')),
    retry_count  INT NOT NULL DEFAULT 0,
    last_error   TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_outbox_pending ON outbox(status, created_at) WHERE status = 'PENDING';

CREATE TABLE model_catalog (
    model          TEXT NOT NULL,
    model_version  TEXT NOT NULL,
    provider       TEXT NOT NULL,
    status         TEXT NOT NULL DEFAULT 'ACTIVE'
                     CHECK (status IN ('ACTIVE','DEPRECATED','RETIRED')),
    shutdown_date  DATE,                            -- set when DEPRECATED
    price_in_per_mtok  NUMERIC(10,4),               -- for the savings forecast and price changes
    price_out_per_mtok NUMERIC(10,4),
    source         TEXT NOT NULL DEFAULT 'SYNC' CHECK (source IN ('SYNC','MANUAL')),
    first_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (model, model_version)
);

CREATE TABLE alerts (
    alert_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id         UUID NOT NULL REFERENCES jobs(job_id),
    kind           TEXT NOT NULL CHECK (kind IN
                     ('VERSION_REGRESSION','SILENT_DROP','MODEL_DEPRECATED')),
    detail         JSONB NOT NULL,                  -- rates before/after, p-value, run ids
    delivered_at   TIMESTAMPTZ,                     -- null until the webhook accepts it
    resolved_at    TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
