"""Remove the unused SHADOW run kind.

Revision ID: 0035
Revises: 0034

The product never sends a customer's calls anywhere else to compare them (no shadow traffic), and nothing in it creates a run of kind
SHADOW. The label only invited the idea, so it is removed from the allowed values: a run is PRODUCTION (the app's own call) or RETEST
(a confirmed replay).

Safe on a large runs table: the new rule is added NOT VALID (a brief lock) and checked afterwards with VALIDATE, which reads the table
without blocking inserts. If a SHADOW row somehow exists, the check fails and the migration stops with the rule left unchanged, rather
than rewriting anyone's data.
"""

from alembic import op

revision = "0035"
down_revision = "0034"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE runs DROP CONSTRAINT runs_run_kind_check")
    op.execute("ALTER TABLE runs ADD CONSTRAINT runs_run_kind_check CHECK (run_kind IN ('PRODUCTION','RETEST')) NOT VALID")
    op.execute("ALTER TABLE runs VALIDATE CONSTRAINT runs_run_kind_check")


def downgrade() -> None:
    op.execute("ALTER TABLE runs DROP CONSTRAINT runs_run_kind_check")
    op.execute("ALTER TABLE runs ADD CONSTRAINT runs_run_kind_check CHECK (run_kind IN ('PRODUCTION','SHADOW','RETEST'))")
