"""A person can stop a trial that is queued or running.

Revision ID: 0036
Revises: 0035

retests.stop_requested_at   when a person pressed Stop. A queued trial is then closed at once and never sends anything; a running one
                            finishes the calls already in flight (they are already paid for) and starts no new ones.
status STOPPED_USER         the new closing state: "stopped by you". Partial results are kept, like a budget stop.

The downgrade turns any STOPPED_USER row into FAILED (its message says why) before it removes the value from the rule, so it never
fails on data it just created.
"""

from alembic import op

revision = "0036"
down_revision = "0035"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE retests ADD COLUMN stop_requested_at TIMESTAMPTZ")
    op.execute("ALTER TABLE retests DROP CONSTRAINT retests_status_check")
    op.execute("ALTER TABLE retests ADD CONSTRAINT retests_status_check CHECK (status IN "
               "('QUEUED','RUNNING','DONE','STOPPED_BUDGET','STOPPED_CAP','STOPPED_USER','FAILED'))")


def downgrade() -> None:
    op.execute("UPDATE retests SET status = 'FAILED' WHERE status = 'STOPPED_USER'")
    op.execute("ALTER TABLE retests DROP CONSTRAINT retests_status_check")
    op.execute("ALTER TABLE retests ADD CONSTRAINT retests_status_check CHECK (status IN "
               "('QUEUED','RUNNING','DONE','STOPPED_BUDGET','STOPPED_CAP','FAILED'))")
    op.execute("ALTER TABLE retests DROP COLUMN IF EXISTS stop_requested_at")
