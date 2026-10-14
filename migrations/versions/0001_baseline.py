"""Baseline schema: the seven tables from db/schema.sql.

Revision ID: 0001
Revises: none
"""

from alembic import op

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None

# Generated from db/schema.sql (comments stripped, one statement per entry). A test asserts that
# this migration and db/schema.sql produce the same tables and columns.
STATEMENTS = [
    """CREATE TABLE projects (
    project_id    TEXT PRIMARY KEY,
    api_key_hash  TEXT NOT NULL,
    webhook_url   TEXT,
    retest_monthly_cap_usd NUMERIC(8,2) NOT NULL DEFAULT 10,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
)""",
    """CREATE TABLE jobs (
    job_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id    TEXT NOT NULL REFERENCES projects(project_id),
    name          TEXT NOT NULL,
    description   TEXT,
    check_kind    TEXT NOT NULL CHECK (check_kind IN
                    ('ANSWER_KEY','TEST_COMMAND','SCHEMA','LATE_LABEL')),
    check_config  JSONB NOT NULL,
    retest_consent BOOLEAN NOT NULL DEFAULT false,
    UNIQUE (project_id, name)
)""",
    """CREATE TABLE runs (
    run_id            UUID PRIMARY KEY,

    job_id            UUID NOT NULL REFERENCES jobs(job_id),
    project_id        TEXT NOT NULL REFERENCES projects(project_id),
    prompt            TEXT NOT NULL,
    prompt_hash       TEXT NOT NULL,
    model             TEXT NOT NULL,
    model_version     TEXT NOT NULL,
    prompt_version    TEXT,
    tokens_in         INT NOT NULL DEFAULT 0,
    tokens_out        INT NOT NULL DEFAULT 0,
    cache_read_tokens  INT NOT NULL DEFAULT 0,
    cache_write_tokens INT NOT NULL DEFAULT 0,
    cost_usd          NUMERIC(12,6) NOT NULL DEFAULT 0,
    latency_ms        INT,
    output            TEXT,
    tool_calls        JSONB,
    outcome           TEXT NOT NULL DEFAULT 'UNKNOWN'
                        CHECK (outcome IN ('PASS','FAIL','UNKNOWN')),
    outcome_reason    TEXT,
    run_kind          TEXT NOT NULL DEFAULT 'PRODUCTION'
                        CHECK (run_kind IN ('PRODUCTION','SHADOW','RETEST')),
    memory_type       TEXT NOT NULL DEFAULT 'EPISODIC'
                        CHECK (memory_type IN ('EPISODIC','SEMANTIC')),
    importance_score  REAL NOT NULL DEFAULT 1.0,
    stability         REAL NOT NULL DEFAULT 1.0,
    state             TEXT NOT NULL DEFAULT 'CAPTURED'
                        CHECK (state IN ('CAPTURED','CHECKED','INDEXED',
                                         'CONSOLIDATED','ARCHIVED','INGESTION_FAILED')),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    invalid_at        TIMESTAMPTZ
)""",
    """CREATE INDEX idx_runs_job_model ON runs(job_id, model, model_version)""",
    """CREATE INDEX idx_runs_job_created ON runs(job_id, created_at DESC)""",
    """CREATE INDEX idx_runs_prompt_hash ON runs(prompt_hash)""",
    """CREATE TABLE recommendations (
    recommendation_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id             UUID NOT NULL REFERENCES jobs(job_id),
    model              TEXT NOT NULL,
    model_version      TEXT NOT NULL,
    verdict            TEXT NOT NULL CHECK (verdict IN
                         ('SWITCH','HOLD','DOWNGRADE','INSUFFICIENT_EVIDENCE')),
    weighted_pass_rate REAL,
    mean_cost_usd      NUMERIC(12,6),
    n_runs             INT NOT NULL,
    evidence_weight    REAL NOT NULL,
    consolidated_from  UUID[] NOT NULL DEFAULT '{}',
    superseded_by_id   UUID REFERENCES recommendations(recommendation_id),
    supersession_reason TEXT,
    memory_type        TEXT NOT NULL DEFAULT 'SEMANTIC',
    valid_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    invalid_at         TIMESTAMPTZ
)""",
    """CREATE INDEX idx_rec_current ON recommendations(job_id) WHERE invalid_at IS NULL""",
    """CREATE TABLE outbox (
    outbox_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id       UUID REFERENCES runs(run_id),
    op           TEXT NOT NULL CHECK (op IN ('UPSERT','INVALIDATE','RETEST')),
    payload      JSONB NOT NULL,
    status       TEXT NOT NULL DEFAULT 'PENDING'
                   CHECK (status IN ('PENDING','PROCESSING','DONE','FAILED')),
    retry_count  INT NOT NULL DEFAULT 0,
    last_error   TEXT,
    claimed_at   TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
)""",
    """CREATE INDEX idx_outbox_pending ON outbox(status, created_at) WHERE status = 'PENDING'""",
    """CREATE INDEX idx_outbox_stuck ON outbox(claimed_at) WHERE status = 'PROCESSING'""",
    """CREATE INDEX idx_outbox_done ON outbox(updated_at) WHERE status = 'DONE'""",
    """CREATE TABLE model_catalog (
    model          TEXT NOT NULL,
    model_version  TEXT NOT NULL,
    provider       TEXT NOT NULL,
    status         TEXT NOT NULL DEFAULT 'ACTIVE'
                     CHECK (status IN ('ACTIVE','DEPRECATED','RETIRED')),
    shutdown_date  DATE,
    price_in_per_mtok  NUMERIC(10,4),
    price_out_per_mtok NUMERIC(10,4),
    source         TEXT NOT NULL DEFAULT 'SYNC' CHECK (source IN ('SYNC','MANUAL')),
    first_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (model, model_version)
)""",
    """CREATE TABLE alerts (
    alert_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id         UUID NOT NULL REFERENCES jobs(job_id),
    kind           TEXT NOT NULL CHECK (kind IN
                     ('VERSION_REGRESSION','SILENT_DROP','MODEL_DEPRECATED')),
    detail         JSONB NOT NULL,
    delivered_at   TIMESTAMPTZ,
    resolved_at    TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
)""",
]

TABLES = ["alerts", "model_catalog", "outbox", "recommendations", "runs", "jobs", "projects"]


def upgrade() -> None:
    for statement in STATEMENTS:
        op.execute(statement)


def downgrade() -> None:
    for table in TABLES:
        op.execute(f"DROP TABLE IF EXISTS {table} CASCADE")
