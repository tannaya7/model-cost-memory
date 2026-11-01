"""A re-test started when the provider key is first given.

Revision ID: 0012
Revises: 0011

A job that has only ever used one model got no re-test unless a person asked: no cheaper model is
measured, so the engine is never unsure about one, and a new catalog model may never come. When the
key is first given, each such job now gets one re-test of a cheaper model (retest/runner.py,
start_on_first_key), recorded with the trigger FIRST_KEY.
"""

from alembic import op

revision = "0012"
down_revision = "0011"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE retests DROP CONSTRAINT retests_trigger_check")
    op.execute("ALTER TABLE retests ADD CONSTRAINT retests_trigger_check "
               "CHECK (trigger IN ('MANUAL','NEW_MODEL','UNSURE','FIRST_KEY'))")


def downgrade() -> None:
    op.execute("UPDATE retests SET trigger = 'MANUAL' WHERE trigger = 'FIRST_KEY'")
    op.execute("ALTER TABLE retests DROP CONSTRAINT retests_trigger_check")
    op.execute("ALTER TABLE retests ADD CONSTRAINT retests_trigger_check "
               "CHECK (trigger IN ('MANUAL','NEW_MODEL','UNSURE'))")
