"""Usage limits, and the reasoning effort of each run.

Revision ID: 0013
Revises: 0012

Usage limits: plans and providers cap use per window (a 5-hour session, a 7-day week, a day's quota),
sometimes for one model only. A project records the limits it works under; the server forecasts from
its recorded runs whether one runs out before it resets, and if so suggests, per job, the cheaper
option the engine has shown still does the job (limits.py).

Effort: the same model at low and at medium reasoning effort costs different amounts and can pass
different shares of a job's checks, so runs record the effort they asked for and the engine compares
each model and effort as its own option (options.py). NULL for runs that do not say.
"""

from alembic import op

revision = "0013"
down_revision = "0012"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE runs ADD COLUMN effort TEXT")
    op.execute("""
        CREATE TABLE usage_limits (
            limit_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            project_id    TEXT NOT NULL REFERENCES projects(project_id),
            name          TEXT NOT NULL,
            window_hours  INTEGER NOT NULL CONSTRAINT usage_limits_window_check CHECK (window_hours > 0),
            resets_at     TIMESTAMPTZ NOT NULL,
            measure       TEXT NOT NULL CONSTRAINT usage_limits_measure_check
                          CHECK (measure IN ('USD','TOKENS','REQUESTS','PERCENT')),
            size          NUMERIC(16,4),
            model         TEXT,
            reported_used NUMERIC(5,4) CONSTRAINT usage_limits_reported_check
                          CHECK (reported_used IS NULL OR (reported_used >= 0 AND reported_used <= 1)),
            reported_at   TIMESTAMPTZ,
            created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
            CONSTRAINT usage_limits_size_check CHECK (measure = 'PERCENT' OR size > 0)
        )
    """)
    op.execute("CREATE INDEX idx_usage_limits_project ON usage_limits (project_id)")


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS usage_limits")
    op.execute("ALTER TABLE runs DROP COLUMN IF EXISTS effort")
