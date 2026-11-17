"""An optional, opt-in AI-written summary of what a task does.

Revision ID: 0019
Revises: 0018

projects.task_summary_consent: off by default. While false nothing is ever sent to an outside AI service.
task_summaries: one row per job, with the fingerprint of the sample calls it was written from, so it is
written again only when the samples change.
"""

from alembic import op

revision = "0019"
down_revision = "0018"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE projects ADD COLUMN task_summary_consent BOOLEAN NOT NULL DEFAULT false")
    op.execute("""
        CREATE TABLE task_summaries (
            job_id         UUID PRIMARY KEY REFERENCES jobs(job_id) ON DELETE CASCADE,
            fingerprint    TEXT NOT NULL,
            summary        TEXT,
            prompt_version TEXT NOT NULL,
            attempts       INTEGER NOT NULL DEFAULT 1,
            attempted_at   TIMESTAMPTZ NOT NULL DEFAULT now()
        )""")
    op.execute("CREATE INDEX idx_task_summaries_attempted ON task_summaries(attempted_at)")


def downgrade() -> None:
    op.execute("DROP TABLE task_summaries")
    op.execute("ALTER TABLE projects DROP COLUMN task_summary_consent")
