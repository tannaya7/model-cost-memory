"""Official model notices: what each provider's own deprecation page says, when it was checked, and where.

Revision ID: 0026
Revises: 0025

notice_sources   one row per provider page we read (status, last check, last good check)
model_notices    one row per model the page lists with a date or a deprecated/retired status, with the exact link
alerts.kind      adds MODEL_NOTICE
projects.notice_alert_webhook   whether model notices are ALSO sent to the project's webhook (default OFF: opt in)

Notices are information only. Nothing here changes a model, a setting or an application.
"""

from alembic import op

revision = "0026"
down_revision = "0025"
branch_labels = None
depends_on = None

OLD = "('VERSION_REGRESSION','SILENT_DROP','MODEL_DEPRECATED','TOKEN_BURST','BUDGET','TRIAL_BUDGET','MODEL_RETIRING')"
NEW = "('VERSION_REGRESSION','SILENT_DROP','MODEL_DEPRECATED','TOKEN_BURST','BUDGET','TRIAL_BUDGET','MODEL_RETIRING','MODEL_NOTICE')"


def upgrade() -> None:
    op.execute("""
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
        )""")
    op.execute("""
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
        )""")
    op.execute("CREATE UNIQUE INDEX uq_model_notices ON model_notices "
               "(source_id, model, status, COALESCE(notice_date, DATE '0001-01-01'))")
    op.execute("CREATE INDEX idx_model_notices_model ON model_notices (model) WHERE listed")
    op.execute("ALTER TABLE projects ADD COLUMN notice_alert_webhook BOOLEAN NOT NULL DEFAULT FALSE")
    op.execute("ALTER TABLE alerts DROP CONSTRAINT alerts_kind_check")
    op.execute(f"ALTER TABLE alerts ADD CONSTRAINT alerts_kind_check CHECK (kind IN {NEW})")


def downgrade() -> None:
    op.execute("DELETE FROM alerts WHERE kind = 'MODEL_NOTICE'")
    op.execute("ALTER TABLE alerts DROP CONSTRAINT alerts_kind_check")
    op.execute(f"ALTER TABLE alerts ADD CONSTRAINT alerts_kind_check CHECK (kind IN {OLD})")
    op.execute("ALTER TABLE projects DROP COLUMN notice_alert_webhook")
    op.execute("DROP TABLE model_notices")
    op.execute("DROP TABLE notice_sources")
