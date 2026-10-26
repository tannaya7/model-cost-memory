"""Record which model production used when a recommendation was made.

Revision ID: 0004
Revises: 0003

- recommendations.current_model: the decision history shows what was recommended *instead of* what, so a
  HOLD can be told apart from a DOWNGRADE long after the fact. NULL for a job with no production runs yet.
"""

from alembic import op

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE recommendations ADD COLUMN current_model TEXT")


def downgrade() -> None:
    op.execute("ALTER TABLE recommendations DROP COLUMN IF EXISTS current_model")
