"""Summaries written once per verdict, and alerts that stop retrying.

Revision ID: 0014
Revises: 0013

recommendation_summaries: the optional two-sentence summary was cached in memory by the exact figures,
which change with every new run, so polling a busy job paid for a call on almost every change and a
restart forgot them all. Now one row per verdict (summary_key), with a server-wide daily limit counted
from attempted_at (recommend/summary.py).

alerts.delivery_failed_at: webhook delivery used to retry forever; it now gives up after a fixed number
of attempts and records when (alerts/notifier.py). Saving a new webhook URL clears it.
"""

from alembic import op

revision = "0014"
down_revision = "0013"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE alerts ADD COLUMN delivery_failed_at TIMESTAMPTZ")
    op.execute("""
        CREATE TABLE recommendation_summaries (
            summary_key    TEXT PRIMARY KEY,
            job_id         UUID NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
            summary        TEXT,
            prompt_version TEXT NOT NULL,
            attempts       INTEGER NOT NULL DEFAULT 1,
            attempted_at   TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    """)
    op.execute("CREATE INDEX idx_summaries_attempted ON recommendation_summaries (attempted_at)")


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS recommendation_summaries")
    op.execute("ALTER TABLE alerts DROP COLUMN IF EXISTS delivery_failed_at")
