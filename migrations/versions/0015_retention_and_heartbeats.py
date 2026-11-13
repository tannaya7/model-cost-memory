"""Prompt retention, and scheduler heartbeats.

Revision ID: 0015
Revises: 0014

projects.content_retention_days (default 90): after that many days a run's prompt, answer, tool calls,
answer key and prompt embedding are cleared (retention.py). Pass/fail, model, tokens, cost and the
prompt's hash stay, which is everything the statistics read.

runs.prompt becomes nullable, and runs.content_removed_at records when the content was cleared. The
partial index lists only runs that still hold content, so the daily clean-up reads a shrinking set.

scheduler_heartbeats: when each scheduled job last succeeded or failed, for GET /healthz/scheduler
(heartbeat.py).
"""

from alembic import op

revision = "0015"
down_revision = "0014"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        ALTER TABLE projects ADD COLUMN content_retention_days INTEGER NOT NULL DEFAULT 90
            CONSTRAINT projects_retention_check CHECK (content_retention_days BETWEEN 1 AND 3650)
    """)
    op.execute("ALTER TABLE runs ALTER COLUMN prompt DROP NOT NULL")
    op.execute("ALTER TABLE runs ADD COLUMN content_removed_at TIMESTAMPTZ")
    op.execute("CREATE INDEX idx_runs_content_kept ON runs(created_at) WHERE content_removed_at IS NULL")
    op.execute("""
        CREATE TABLE scheduler_heartbeats (
            job           TEXT PRIMARY KEY,
            last_ok_at    TIMESTAMPTZ,
            last_error    TEXT,
            last_error_at TIMESTAMPTZ
        )
    """)


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS scheduler_heartbeats")
    op.execute("DROP INDEX IF EXISTS idx_runs_content_kept")
    op.execute("ALTER TABLE runs DROP COLUMN IF EXISTS content_removed_at")
    op.execute("UPDATE runs SET prompt = '' WHERE prompt IS NULL")
    op.execute("ALTER TABLE runs ALTER COLUMN prompt SET NOT NULL")
    op.execute("ALTER TABLE projects DROP COLUMN IF EXISTS content_retention_days")
