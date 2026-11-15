"""Which first-visit guides a person has already seen.

Revision ID: 0020
Revises: 0019

users.ui_flags: a small JSON object, per account, holding only the booleans tour_seen and
first_results_seen. Nothing else is ever stored in it (the API accepts only those two keys).
"""

from alembic import op

revision = "0020"
down_revision = "0019"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE users ADD COLUMN ui_flags JSONB NOT NULL DEFAULT '{}'::jsonb")


def downgrade() -> None:
    op.execute("ALTER TABLE users DROP COLUMN ui_flags")
