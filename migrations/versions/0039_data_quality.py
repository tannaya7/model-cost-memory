"""Data quality: flags on a call, and a count of duplicate deliveries that were ignored.

Revision ID: 0039
Revises: 0038

runs.data_flags       the quality flags found when the call was recorded (see data_quality.py). NULL means none were found. Nothing is
                      guessed for older calls: they stay NULL, which the coverage page shows as "not checked", not as "clean".
ingest_duplicates     how many times a call that was already recorded was sent again (the same run_id), per project and UTC day. The second
                      copy is ignored, as before; now it is counted, so duplicate delivery is visible instead of silent.
"""

from alembic import op

revision = "0039"
down_revision = "0038"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE runs ADD COLUMN data_flags TEXT[]")
    op.execute("""
        CREATE TABLE ingest_duplicates (
            project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
            day        DATE NOT NULL,
            duplicates INTEGER NOT NULL DEFAULT 0 CHECK (duplicates >= 0),
            PRIMARY KEY (project_id, day)
        )""")


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS ingest_duplicates")
    op.execute("ALTER TABLE runs DROP COLUMN IF EXISTS data_flags")
