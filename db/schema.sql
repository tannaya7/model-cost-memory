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
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    ui_flags    JSONB NOT NULL DEFAULT '{}'::jsonb,     -- first-visit guides seen: only tour_seen, first_results_seen
    session_epoch INTEGER NOT NULL DEFAULT 0            -- raised by logout, so copied sign-in cookies stop working (0034)
);

CREATE TABLE organisations (                        -- a company workspace (0030); a personal workspace is implicit
    org_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
    created_by  UUID REFERENCES users(user_id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at  TIMESTAMPTZ
);

CREATE TABLE memberships (                          -- who is in which company; leaving or removal ends the row
    org_id        UUID NOT NULL REFERENCES organisations(org_id),
    user_id       UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    role          TEXT NOT NULL CHECK (role IN ('owner','admin','member','viewer')),
    status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','ended')),
    ended_reason  TEXT CHECK (ended_reason IN ('left','removed')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    joined_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at      TIMESTAMPTZ,
    job_role      TEXT CONSTRAINT memberships_job_role_check CHECK (job_role IN ('engineering','product','data_science','operations','support','finance','legal','other')),
    PRIMARY KEY (org_id, user_id),
    CHECK ((status = 'active') = (ended_at IS NULL))
);
CREATE INDEX idx_memberships_user ON memberships (user_id) WHERE status = 'active';

CREATE TABLE org_notice_acks (                     -- a person was shown a version of a company's notice (0031); not a legal consent
    org_id           UUID NOT NULL REFERENCES organisations(org_id),
    user_id          UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    version          TEXT NOT NULL,
    acknowledged_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, user_id, version)
);

CREATE TABLE org_invites (                          -- single-use, expiring; only a hash of the token is stored
    invite_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id      UUID NOT NULL REFERENCES organisations(org_id),
    email       TEXT NOT NULL,
    role        TEXT NOT NULL CHECK (role IN ('admin','member','viewer')),
    token_hash  TEXT NOT NULL UNIQUE,
    created_by  UUID REFERENCES users(user_id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ NOT NULL,
    used_at     TIMESTAMPTZ,
    used_by     UUID REFERENCES users(user_id) ON DELETE SET NULL,
    revoked_at  TIMESTAMPTZ
);
CREATE INDEX idx_org_invites_org ON org_invites (org_id, created_at DESC);

CREATE TABLE org_events (                           -- who did what in a company; never prompt or run text
    event_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          UUID NOT NULL REFERENCES organisations(org_id),
    actor_user_id   UUID REFERENCES users(user_id) ON DELETE SET NULL,
    action          TEXT NOT NULL,
    target_user_id  UUID REFERENCES users(user_id) ON DELETE SET NULL,
    detail          JSONB NOT NULL DEFAULT '{}'::jsonb,
    at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_org_events_org ON org_events (org_id, at DESC);

CREATE TABLE projects (
    project_id    TEXT PRIMARY KEY,
    slug          TEXT NOT NULL                     -- short readable name in the web address; stable (0022)
        CONSTRAINT projects_slug_check CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) BETWEEN 1 AND 40),
    api_key_hash  TEXT NOT NULL,                    -- the key itself is shown once, never stored
    webhook_url   TEXT,                             -- regression alerts; optional
    billing_mode  TEXT NOT NULL DEFAULT 'per_use'   -- how the project pays for AI (0021)
        CONSTRAINT projects_billing_mode_check CHECK (billing_mode IN ('per_use','subscription','both')),
    budget_timezone TEXT NOT NULL DEFAULT 'UTC',    -- IANA timezone the budget month and days are counted in (0025)
    budget_alert_levels INTEGER[] NOT NULL DEFAULT '{85,95}'  -- percent of the budget that raise an in-app alert (0025)
        CONSTRAINT projects_budget_levels_check CHECK (cardinality(budget_alert_levels) <= 6
            AND 0 < ALL (budget_alert_levels) AND 100 >= ALL (budget_alert_levels)),
    budget_alert_projected BOOLEAN NOT NULL DEFAULT TRUE,      -- raise a projected-over-budget warning (0025)
    budget_alert_webhook BOOLEAN NOT NULL DEFAULT FALSE,       -- also send budget alerts to the webhook: opt in (0025)
    notice_alert_webhook BOOLEAN NOT NULL DEFAULT FALSE,       -- also send model notices to the webhook: opt in (0026)
    ai_summary_consent BOOLEAN NOT NULL DEFAULT FALSE,         -- figures may be sent to an outside AI for a summary: opt in (0027)
    store_tool_arguments BOOLEAN NOT NULL DEFAULT false,  -- opt in to keeping tool-call arguments
    retest_monthly_cap_usd NUMERIC(8,2) NOT NULL DEFAULT 10,
    webhook_secret TEXT,                            -- signs webhook payloads (HMAC-SHA256)
    retest_allowed BOOLEAN NOT NULL DEFAULT true,   -- project-wide switch, on top of each job's consent
    auto_retests BOOLEAN NOT NULL DEFAULT false,    -- automatic paid replays: opt in (0032)
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    owner_user_id UUID REFERENCES users(user_id),   -- NULL = created by the operator script
    organisation_id UUID REFERENCES organisations(org_id),  -- NULL = a personal project; set = a company project (0030)
    name          TEXT,                             -- display name chosen in the web app
    key_prefix    TEXT,                             -- first characters of the live key, for display
    content_retention_days INTEGER NOT NULL DEFAULT 90  -- days runs keep their prompt and answer (0015)
        CONSTRAINT projects_retention_check CHECK (content_retention_days BETWEEN 1 AND 3650),
    monthly_budget_usd NUMERIC(12,2)                -- optional soft budget; alerts only (0018)
        CONSTRAINT projects_budget_check CHECK (monthly_budget_usd IS NULL OR monthly_budget_usd > 0),
    task_summary_consent BOOLEAN NOT NULL DEFAULT false  -- opt in to an AI-written task summary (0019)
);
CREATE INDEX idx_projects_owner ON projects(owner_user_id);
CREATE INDEX idx_projects_key_hash ON projects(api_key_hash);   -- every key-carrying request looks the project up by this (0033)
CREATE UNIQUE INDEX uq_projects_owner_slug ON projects(owner_user_id, slug) WHERE owner_user_id IS NOT NULL AND organisation_id IS NULL;
CREATE UNIQUE INDEX uq_projects_ownerless_slug ON projects(slug) WHERE owner_user_id IS NULL AND organisation_id IS NULL;
CREATE UNIQUE INDEX uq_projects_org_slug ON projects(organisation_id, slug) WHERE organisation_id IS NOT NULL;
CREATE INDEX idx_projects_org ON projects(organisation_id) WHERE organisation_id IS NOT NULL;

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
                      ('QUEUED','RUNNING','DONE','STOPPED_BUDGET','STOPPED_CAP','STOPPED_USER','FAILED')),
    stop_requested_at TIMESTAMPTZ,                  -- a person pressed Stop (0036)
    budget_usd      NUMERIC(10,4) NOT NULL CHECK (budget_usd > 0),
    spent_usd       NUMERIC(12,6) NOT NULL DEFAULT 0,
    runs_planned    INT NOT NULL DEFAULT 0,
    runs_done       INT NOT NULL DEFAULT 0,
    passed          INT NOT NULL DEFAULT 0,
    failed          INT NOT NULL DEFAULT 0,
    message         TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at      TIMESTAMPTZ,
    finished_at     TIMESTAMPTZ,
    confirmation_hash TEXT UNIQUE,                  -- single-use confirmation of the preview (0032)
    confirmed_by    UUID REFERENCES users(user_id) ON DELETE SET NULL,
    confirmed_at    TIMESTAMPTZ,
    preview         JSONB,                          -- what the person was shown: categories, destination, cost range
    price_basis     JSONB,
    evaluator       TEXT,
    provider_host   TEXT,
    sample_run_ids  JSONB
);
CREATE INDEX idx_retests_queued ON retests(created_at) WHERE status = 'QUEUED';
CREATE INDEX idx_retests_job ON retests(job_id, created_at DESC);

CREATE TABLE runs (
    run_id            UUID PRIMARY KEY,                  -- supplied by the SDK, so a retried send
                                                         -- hits the same row (INSERT ... ON CONFLICT DO NOTHING)
    job_id            UUID NOT NULL REFERENCES jobs(job_id),
    project_id        TEXT NOT NULL REFERENCES projects(project_id),
    prompt            TEXT,                         -- NULL once retention cleared it (0015)
    prompt_hash       TEXT NOT NULL,                -- dedupe + cache key: HMAC of the prompt's SHA-256 under a per-project key (0037)
    hash_version      SMALLINT NOT NULL DEFAULT 2,  -- 1 = plain SHA-256 (before 0037), 2 = keyed
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
                        CHECK (run_kind IN ('PRODUCTION','RETEST')),   -- no SHADOW kind (0035)
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
    provider          TEXT,                         -- who served the call, e.g. 'groq'; picks the price (0010)
    content_removed_at TIMESTAMPTZ,                 -- when retention cleared prompt, output, tool calls, answer key, embedding (0015)
    agent             TEXT,                         -- which agent or role made the call (0017)
    trace_id          TEXT,                         -- shared by every call serving one user task (0017)
    span_id           TEXT,                         -- this call's own id, chosen by the app (0029)
    parent_span_id    TEXT,                         -- the span_id of the call that started this one (0029)
    tools_tokens      INTEGER,                      -- estimated tokens of the tool definitions sent, chars / 4 (0017)
    tool_call_count   INTEGER,                      -- number of tool calls in the response (0017)
    usage_shape       TEXT,                         -- provider usage layout read by the SDK; 'none' = no usage block (0023)
    usage_raw         JSONB,                        -- the usage block as numbers only, for audit (0023)
    reasoning_tokens  INTEGER,                      -- reasoning/thinking tokens when reported separately; NULL = not reported (0023)
    tool_use_input_tokens INTEGER,                  -- Gemini tool-result input tokens, not priced; NULL = not reported (0023)
    CONSTRAINT runs_usage_shape_check CHECK (usage_shape IS NULL OR usage_shape IN
        ('anthropic_messages','openai_responses','openai_chat','deepseek_chat','gemini','none')),
    price_version_id  UUID,                         -- the price version that priced this run; FK added below (0024)
    price_status      TEXT,                         -- why the run is or is not priced; NULL = before versions (0024)
    cache_write_1h_tokens INTEGER,                  -- part of cache_write_tokens written to the 1-hour cache; NULL = not reported (0024)
    price_factor      NUMERIC(6,4),                 -- a verified modifier applied to the list price, e.g. 0.5 batch (0024)
    CONSTRAINT runs_price_status_check CHECK (price_status IS NULL OR price_status IN
        ('PRICED','PARTLY_PRICED','CALLER_COST','NO_USAGE','UNPRICED_UNKNOWN_MODEL','UNPRICED_NOT_YET_EFFECTIVE',
         'UNPRICED_EXPIRED'))
);
CREATE INDEX idx_runs_content_kept ON runs(created_at) WHERE content_removed_at IS NULL;
CREATE INDEX idx_runs_retest ON runs(retest_id) WHERE retest_id IS NOT NULL;
CREATE INDEX idx_runs_job_model ON runs(job_id, model, model_version);
CREATE INDEX idx_runs_job_created ON runs(job_id, created_at DESC);   -- "recent runs for this job"
CREATE INDEX idx_runs_prompt_hash ON runs(prompt_hash);
CREATE INDEX idx_runs_project_trace ON runs(project_id, trace_id) WHERE trace_id IS NOT NULL;   -- (0017)
CREATE INDEX idx_runs_span ON runs(project_id, trace_id, span_id) WHERE span_id IS NOT NULL;      -- (0029)
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
                     ('VERSION_REGRESSION','SILENT_DROP','MODEL_DEPRECATED','TOKEN_BURST','BUDGET','TRIAL_BUDGET','MODEL_RETIRING','MODEL_NOTICE')),
    detail         JSONB NOT NULL,                  -- rates before/after, p-value, run ids
    delivered_at   TIMESTAMPTZ,                     -- null until the webhook accepts it
    resolved_at    TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    dedupe_key     TEXT NOT NULL DEFAULT '',        -- one open alert per finding
    delivery_attempts INT NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ,                    -- webhook retry with backoff
    last_error     TEXT,
    delivery_failed_at TIMESTAMPTZ                  -- gave up after the last retry (0014)
);
CREATE UNIQUE INDEX idx_alerts_open ON alerts(job_id, dedupe_key) WHERE resolved_at IS NULL;
CREATE INDEX idx_alerts_undelivered ON alerts(next_attempt_at) WHERE delivered_at IS NULL;

CREATE TABLE recommendation_summaries (             -- the optional summary, once per verdict (0014)
    summary_key    TEXT PRIMARY KEY,                -- job + summary model + prompt + what the verdict says
    job_id         UUID NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
    summary        TEXT,                            -- null while being written, or after a failed call
    prompt_version TEXT NOT NULL,
    attempts       INTEGER NOT NULL DEFAULT 1,
    attempted_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_summaries_attempted ON recommendation_summaries(attempted_at);

CREATE TABLE task_summaries (                       -- the optional AI summary of what a task does (0019)
    job_id         UUID PRIMARY KEY REFERENCES jobs(job_id) ON DELETE CASCADE,
    fingerprint    TEXT NOT NULL,                   -- of the sample calls it was written from
    summary        TEXT,                            -- null after a failed call
    prompt_version TEXT NOT NULL,
    attempts       INTEGER NOT NULL DEFAULT 1,
    attempted_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_task_summaries_attempted ON task_summaries(attempted_at);

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

CREATE TABLE scheduler_heartbeats (                 -- when each scheduled job last succeeded or failed (0015)
    job           TEXT PRIMARY KEY,                 -- a job id, or 'scheduler' for when the leader started
    last_ok_at    TIMESTAMPTZ,
    last_error    TEXT,
    last_error_at TIMESTAMPTZ
);

CREATE TABLE news_items (                           -- AI headlines from public feeds, shared by all projects (0016)
    item_id      TEXT PRIMARY KEY,                  -- hash of the link
    source       TEXT NOT NULL,
    kind         TEXT NOT NULL,                     -- lab, press or community
    title        TEXT NOT NULL,
    link         TEXT NOT NULL,                     -- http(s) only
    summary      TEXT NOT NULL DEFAULT '',          -- plain text, never HTML
    published_at TIMESTAMPTZ NOT NULL,
    fetched_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_news_published ON news_items (published_at DESC);

-- Price history (0024): every price a model has had, written by a trigger on model_catalog / model_prices
CREATE TABLE price_versions (
    version_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scope             TEXT NOT NULL CHECK (scope IN ('catalog','provider')),
    model             TEXT NOT NULL,
    model_version     TEXT NOT NULL DEFAULT '',
    provider          TEXT NOT NULL,
    input_per_mtok    NUMERIC(12,6) NOT NULL,
    output_per_mtok   NUMERIC(12,6) NOT NULL,
    cache_read_per_mtok      NUMERIC(12,6),
    cache_write_5m_per_mtok  NUMERIC(12,6),
    cache_write_1h_per_mtok  NUMERIC(12,6),
    cache_basis       TEXT NOT NULL DEFAULT 'FAMILY_FACTOR' CHECK (cache_basis IN ('FAMILY_FACTOR','EXPLICIT')),
    modifiers         JSONB,
    effective_from    TIMESTAMPTZ NOT NULL DEFAULT now(),
    effective_to      TIMESTAMPTZ,
    source_kind       TEXT NOT NULL CHECK (source_kind IN ('SYNC','MANUAL','BACKFILL')),
    source_url        TEXT,
    checked_at        TIMESTAMPTZ,
    applicability     TEXT,
    CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
CREATE UNIQUE INDEX uq_price_versions_open ON price_versions (scope, model, model_version, provider) WHERE effective_to IS NULL;
CREATE INDEX idx_price_versions_lookup ON price_versions (model, effective_from DESC);
ALTER TABLE runs ADD CONSTRAINT runs_price_version_fk FOREIGN KEY (price_version_id) REFERENCES price_versions(version_id);
CREATE INDEX idx_runs_price_version ON runs (price_version_id) WHERE price_version_id IS NOT NULL;
CREATE OR REPLACE FUNCTION mcm_record_price_version() RETURNS trigger AS $fn$
DECLARE
    v_scope   TEXT := TG_ARGV[0];
    v_model   TEXT;
    v_version TEXT := '';
    v_kind    TEXT := 'SYNC';
    v_same    BOOLEAN := TRUE;
BEGIN
    -- clock_timestamp(), not now(): now() is when the TRANSACTION began, which can be long before this change and
    -- would date it before calls that were already priced. Each table's own columns are read only inside its own branch: model_prices has no model_version or source.
    IF TG_OP = 'DELETE' THEN
        v_model := OLD.model;
        IF v_scope = 'catalog' THEN v_version := OLD.model_version; END IF;
        -- A deleted row ends the version in force: a removed price must stop pricing runs.
        UPDATE price_versions SET effective_to = clock_timestamp()
         WHERE scope = v_scope AND model = v_model AND model_version = v_version AND effective_to IS NULL;
        RETURN OLD;
    END IF;
    v_model := NEW.model;
    IF v_scope = 'catalog' THEN
        v_version := NEW.model_version;
        v_kind := NEW.source;
        IF TG_OP = 'UPDATE' THEN v_same := OLD.source IS NOT DISTINCT FROM NEW.source; END IF;
    END IF;
    IF NEW.price_in_per_mtok IS NULL OR NEW.price_out_per_mtok IS NULL THEN
        -- A price taken away ends the version in force too.
        UPDATE price_versions SET effective_to = clock_timestamp()
         WHERE scope = v_scope AND model = v_model AND model_version = v_version AND effective_to IS NULL;
        RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE'
       AND OLD.price_in_per_mtok IS NOT DISTINCT FROM NEW.price_in_per_mtok
       AND OLD.price_out_per_mtok IS NOT DISTINCT FROM NEW.price_out_per_mtok
       AND OLD.provider IS NOT DISTINCT FROM NEW.provider
       AND v_same THEN
        RETURN NEW;
    END IF;
    UPDATE price_versions SET effective_to = clock_timestamp()
     WHERE scope = v_scope AND model = v_model AND model_version = v_version AND effective_to IS NULL;
    INSERT INTO price_versions (scope, model, model_version, provider, input_per_mtok, output_per_mtok,
                                source_kind, source_url, checked_at, effective_from, applicability)
    VALUES (v_scope, v_model, v_version, NEW.provider, NEW.price_in_per_mtok, NEW.price_out_per_mtok, v_kind,
            CASE WHEN v_kind = 'MANUAL' THEN NULL ELSE 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json' END, clock_timestamp(), clock_timestamp(),
            CASE WHEN v_kind = 'MANUAL' THEN 'Entered by hand; not checked against a provider page'
                 ELSE 'Public list price from the source above; not a negotiated, discounted or invoice price' END);
    RETURN NEW;
END
$fn$ LANGUAGE plpgsql;
CREATE TRIGGER trg_catalog_price_version AFTER INSERT OR UPDATE ON model_catalog FOR EACH ROW EXECUTE FUNCTION mcm_record_price_version('catalog');
CREATE TRIGGER trg_provider_price_version AFTER INSERT OR UPDATE ON model_prices FOR EACH ROW EXECUTE FUNCTION mcm_record_price_version('provider');
CREATE TRIGGER trg_catalog_price_closed AFTER DELETE ON model_catalog FOR EACH ROW EXECUTE FUNCTION mcm_record_price_version('catalog');
CREATE TRIGGER trg_provider_price_closed AFTER DELETE ON model_prices FOR EACH ROW EXECUTE FUNCTION mcm_record_price_version('provider');

-- Official model notices (0026): what each provider's own deprecation page says, and when it was checked
CREATE TABLE notice_sources (
    source_id       TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    provider        TEXT NOT NULL,
    url             TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'NEVER' CHECK (status IN ('NEVER','OK','UNREADABLE','FETCH_FAILED')),
    last_checked_at TIMESTAMPTZ,
    last_ok_at      TIMESTAMPTZ,
    detail          TEXT,
    notice_count    INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE model_notices (
    notice_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id     TEXT NOT NULL REFERENCES notice_sources(source_id) ON DELETE CASCADE,
    provider      TEXT NOT NULL,
    model         TEXT NOT NULL,
    status        TEXT NOT NULL,
    notice_date   DATE,
    wording       TEXT NOT NULL CHECK (wording IN ('not_sooner_than','tentative','earliest_possible','scheduled')),
    deprecated_on DATE,
    replacement   TEXT,
    section       TEXT,
    notice_url    TEXT NOT NULL,
    listed        BOOLEAN NOT NULL DEFAULT TRUE,
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    checked_at    TIMESTAMPTZ NOT NULL
);
CREATE UNIQUE INDEX uq_model_notices ON model_notices (source_id, model, status, COALESCE(notice_date, DATE '0001-01-01'));
CREATE INDEX idx_model_notices_model ON model_notices (model) WHERE listed;

-- What each maker's own pricing page states (0028): the standard price per model, and when the page was read
CREATE TABLE price_sources (
    source_id       TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    provider        TEXT NOT NULL,
    url             TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'NEVER' CHECK (status IN ('NEVER','OK','UNREADABLE','FETCH_FAILED')),
    last_checked_at TIMESTAMPTZ,
    last_ok_at      TIMESTAMPTZ,
    detail          TEXT,
    model_count     INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE official_prices (
    provider        TEXT NOT NULL,
    model           TEXT NOT NULL,
    input_per_mtok  NUMERIC(12,6),
    output_per_mtok NUMERIC(12,6),
    note            TEXT,
    read_at         TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (provider, model)
);
