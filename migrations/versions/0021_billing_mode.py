"""How a project pays for AI: per use, a subscription, or both.

Revision ID: 0021
Revises: 0020

projects.billing_mode: 'per_use' (default, so every existing project behaves exactly as before),
'subscription' or 'both'. It only changes wording and which alerts fire; no figure is recomputed.
"""

from alembic import op

revision = "0021"
down_revision = "0020"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE projects ADD COLUMN billing_mode TEXT NOT NULL DEFAULT 'per_use'")
    op.execute("ALTER TABLE projects ADD CONSTRAINT projects_billing_mode_check "
               "CHECK (billing_mode IN ('per_use','subscription','both'))")


def downgrade() -> None:
    op.execute("ALTER TABLE projects DROP CONSTRAINT projects_billing_mode_check")
    op.execute("ALTER TABLE projects DROP COLUMN billing_mode")
