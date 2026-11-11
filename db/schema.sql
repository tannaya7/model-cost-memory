-- Model & Cost Memory: database schema (PostgreSQL 16+)
-- Source of truth: docs/ARCHITECTURE.md. Migrations (Alembic) will be generated from this in Week 2.
-- This file runs ONLY when the database volume is empty (first start). Editing it later changes
-- nothing on an existing database; from Week 2 on, Alembic migrations are the only way to change
-- the schema. Development uses Neon: apply this file to an empty database with `psql`.
-- gen_random_uuid() is built in from PostgreSQL 13, so the base tables need no extension. Similar-run
-- search uses pgvector (CREATE EXTENSION vector), available on Neon and in the pgvector/pgvector image.
--           CREATE EXTENSION IF NOT EXISTS vector;    (pgvector, once approved)

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE users (                                -- Google sign-in; no passwords are stored
    user_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    google_sub  TEXT NOT NULL UNIQUE,               -- Google's stable account id
    email       TEXT NOT NULL,
    name        TEXT,
    picture_url TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE projects (
    project_id    TEXT PRIMARY KEY,
    api_key_hash  TEXT NOT NULL,                    -- the key itself is shown once, never stored
    webhook_url   TEXT,                             -- regression alerts; optional
    store_tool_arguments BOOLEAN NOT NULL DEFAULT false,  -- opt in to keeping tool-call arguments
    retest_monthly_cap_usd NUMERIC(8,2) NOT NULL DEFAULT 10,
    webhook_secret TEXT,                            -- signs webhook payloads (HMAC-SHA256)
    retest_allowed BOOLEAN NOT NULL DEFAULT true,   -- project-wide switch, on top of each job's consent
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    owner_user_id UUID REFERENCES users(user_id),   -- NULL = created by the operator script
    name          TEXT,                             -- display name chosen in the web app
    key_prefix    TEXT                              -- first characters of the live key, for display
);
CREATE INDEX idx_projects_owner ON projects(owner_user_id);

CREATE TABLE provider_keys (                        -- the customer's key for re-tests, asked for when first needed
    project_id   TEXT PRIMARY KEY REFERENCES projects(project_id),
    provider     TEXT NOT NULL,                     -- matches model_catalog.provider, e.g. 'openai', 'gemini'
    base_url     TEXT NOT NULL,                     -- an OpenAI-compatible endpoint
    key_encrypted TEXT NOT NULL,                    -- encrypted with the server's SECRET_KEY
    key_hint     TEXT NOT NULL,                     -- last four characters, for display
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE jobs (
    job_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id    TEXT NOT NULL REFERENCES projects(project_id),
    name          TEXT NOT NULL,                    -- 'invoice-extract'
    description   TEXT,                             -- shown in the job list
    check_kind    TEXT NOT NULL CHECK (check_kind IN
                    ('ANSWER_KEY','TEST_COMMAND','SCHEMA','LATE_LABEL')),
    check_config  JSONB NOT NULL,
    retest_consent BOOLEAN NOT NULL DEFAULT false, -- may prompts go to another provider?
    UNIQUE (project_id, name)
);

CREATE TABLE retests (                              -- replaying sampled past runs on a candidate model
    retest_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id          UUID NOT NULL REFERENCES jobs(job_id),
    project_id      TEXT NOT NULL REFERENCES projects(project_id),
    candidate_model TEXT NOT NULL,
    trigger         TEXT NOT NULL CHECK (trigger IN ('MANUAL','NEW_MODEL','UNSURE','FIRST_KEY')),
    status          TEXT NOT NULL DEFAULT 'QUEUED' CHECK (status IN
                      ('QUEUED','RUNNING','DONE','STOPPED_BUDGET','STOPPED_CAP','FAILED')),
    budget_usd      NUMERIC(10,4) NOT NULL CHECK (budget_usd > 0),
    spent_usd       NUMERIC(12,6) NOT NULL DEFAULT 0,
    runs_planned    INT NOT NULL DEFAULT 0,
    runs_done       INT NOT NULL DEFAULT 0,
    passed          INT NOT NULL DEFAULT 0,
    failed          INT NOT NULL DEFAULT 0,
    message         TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at      TIMESTAMPTZ,
    finished_at     TIMESTAMPTZ
);
CREATE INDEX idx_retests_queued ON retests(created_at) WHERE status = 'QUEUED';
CREATE INDEX idx_retests_job ON retests(job_id, created_at DESC);

CREATE TABLE runs (
    run_id            UUID PRIMARY KEY,                  -- supplied by the SDK, so a retried send
                                                         -- hits the same row (INSERT ... ON CONFLICT DO NOTHING)
    job_id            UUID NOT NULL REFERENCES jobs(job_id),
    project_id        TEXT NOT NULL REFERENCES projects(project_id),
    prompt            TEXT NOT NULL,
    prompt_hash       TEXT NOT NULL,                -- dedupe + cache key
    model             TEXT NOT NULL,
    model_version     TEXT NOT NULL,                -- provider-resolved; what decay is keyed to
    prompt_version    TEXT,                         -- optional template version (Should)
    effort            TEXT,                         -- reasoning effort the call asked for, e.g. low (0013)
    tokens_in         INT NOT NULL DEFAULT 0,
    tokens_out        INT NOT NULL DEFAULT 0,      -- includes thinking tokens (billed as output)
    cache_read_tokens  INT NOT NULL DEFAULT 0,     -- priced lower than normal input
    cache_write_tokens INT NOT NULL DEFAULT 0,     -- priced higher than normal input
    cost_usd          NUMERIC(12,6),                -- usage × catalog price (3.13); NULL = price unknown
    latency_ms        INT,
    output            TEXT,
    tool_calls        JSONB,                        -- optional; names + ids only by default (Could)
    outcome           TEXT NOT NULL DEFAULT 'UNKNOWN'
                        CHECK (outcome IN ('PASS','FAIL','UNKNOWN')),
    outcome_reason    TEXT,                         -- why it passed, failed or is unknown
    run_kind          TEXT NOT NULL DEFAULT 'PRODUCTION'
                        CHECK (run_kind IN ('PRODUCTION','SHADOW','RETEST')),
    memory_type       TEXT NOT NULL DEFAULT 'EPISODIC'   -- one run
                        CHECK (memory_type IN ('EPISODIC','SEMANTIC')),
    importance_score  REAL NOT NULL DEFAULT 1.0,
    stability         REAL NOT NULL DEFAULT 1.0,    -- days; 3.4
    embedding         vector(384),                  -- prompt embedding, written by the sync worker
    embedding_model   TEXT,                         -- which embedder produced it (vectors are only comparable within one)
    state             TEXT NOT NULL DEFAULT 'CAPTURED'
                        CHECK (state IN ('CAPTURED','CHECKED','INDEXED',
                                         'CONSOLIDATED','ARCHIVED','INGESTION_FAILED')),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    invalid_at        TIMESTAMPTZ,
    retest_id         UUID REFERENCES retests(retest_id),  -- which re-test produced a RETEST run
    expected          JSONB,                        -- answer key, kept only for jobs with re-test consent
    provider          TEXT                          -- who served the call, e.g. 'groq'; picks the price (0010)
);
CREATE INDEX idx_runs_retest ON runs(retest_id) WHERE retest_id IS NOT NULL;
CREATE INDEX idx_runs_job_model ON runs(job_id, model, model_version);
CREATE INDEX idx_runs_job_created ON runs(job_id, created_at DESC);   -- "recent runs for this job"
CREATE INDEX idx_runs_prompt_hash ON runs(prompt_hash);
CREATE INDEX idx_runs_embedding ON runs USING hnsw (embedding vector_cosine_ops);
CREATE INDEX idx_runs_embedding_cache ON runs(project_id, prompt_hash, embedding_model) WHERE embedding IS NOT NULL;

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
    supersession_reason TEXT,                       -- NEW_EVIDENCE | MODEL_UPGRADE | EVIDENCE_DECAYED | REGRESSION | MODEL_RETIRED
    current_model      TEXT,                            -- what production used when this was decided
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
    claimed_at   TIMESTAMPTZ,                       -- set when a worker takes the row
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now() -- every status change
);
CREATE INDEX idx_outbox_pending ON outbox(status, created_at) WHERE status = 'PENDING';
-- A worker that crashes leaves its rows PROCESSING; the scheduler returns rows claimed more than
-- N minutes ago to PENDING.
CREATE INDEX idx_outbox_stuck ON outbox(claimed_at) WHERE status = 'PROCESSING';
-- The outbox is a queue, not evidence: the scheduler deletes DONE rows after a retention window.
CREATE INDEX idx_outbox_done ON outbox(updated_at) WHERE status = 'DONE';

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

-- Each provider's own price for a model: the same open-weight model costs different amounts on
-- different providers. A run that names its provider is priced from here (a MANUAL catalog row wins).
CREATE TABLE model_prices (
    model              TEXT NOT NULL,
    provider           TEXT NOT NULL,
    price_in_per_mtok  NUMERIC(10,4),
    price_out_per_mtok NUMERIC(10,4),
    shutdown_date      DATE,                        -- this provider's own date; providers differ (0011)
    first_seen_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (model, provider)
);

CREATE TABLE alerts (
    alert_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id         UUID NOT NULL REFERENCES jobs(job_id),
    kind           TEXT NOT NULL CHECK (kind IN
                     ('VERSION_REGRESSION','SILENT_DROP','MODEL_DEPRECATED')),
    detail         JSONB NOT NULL,                  -- rates before/after, p-value, run ids
    delivered_at   TIMESTAMPTZ,                     -- null until the webhook accepts it
    resolved_at    TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    dedupe_key     TEXT NOT NULL DEFAULT '',        -- one open alert per finding
    delivery_attempts INT NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ,                    -- webhook retry with backoff
    last_error     TEXT
);
CREATE UNIQUE INDEX idx_alerts_open ON alerts(job_id, dedupe_key) WHERE resolved_at IS NULL;
CREATE INDEX idx_alerts_undelivered ON alerts(next_attempt_at) WHERE delivered_at IS NULL;

CREATE TABLE usage_limits (                         -- limits the project works under (0013)
    limit_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id    TEXT NOT NULL REFERENCES projects(project_id),
    name          TEXT NOT NULL,                    -- e.g. Weekly, Session (5h), one model's limit
    window_hours  INTEGER NOT NULL CHECK (window_hours > 0),
    resets_at     TIMESTAMPTZ NOT NULL,             -- end of a window; the next ones follow every window_hours
    measure       TEXT NOT NULL CHECK (measure IN ('USD','TOKENS','REQUESTS','PERCENT')),
    size          NUMERIC(16,4),                    -- in the measure's unit; none for PERCENT
    model         TEXT,                             -- only this model family counts
    reported_used NUMERIC(5,4) CHECK (reported_used IS NULL OR (reported_used >= 0 AND reported_used <= 1)),
    reported_at   TIMESTAMPTZ,                      -- PERCENT: when the user last read the share used
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (measure = 'PERCENT' OR size > 0)
);
CREATE INDEX idx_usage_limits_project ON usage_limits(project_id);

CREATE TABLE flow_events (                          -- the live data-flow view; deleted after a day
    event_id   BIGSERIAL PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(project_id),
    run_id     UUID,
    stage      TEXT NOT NULL CHECK (stage IN ('sdk','api','check','index','consolidate')),
    message    TEXT NOT NULL,
    data       JSONB,
    ts         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_flow_events_project ON flow_events(project_id, event_id);
CREATE INDEX idx_flow_events_ts ON flow_events(ts);
