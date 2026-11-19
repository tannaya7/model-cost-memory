"""Logging out cancels every copy of the sign-in cookie.

Revision ID: 0034
Revises: 0033

users.session_epoch   a counter carried inside each sign-in cookie. Logging out raises it, so a cookie copied before the logout no longer
                      matches and the person is treated as signed out. Existing cookies carry no counter and count as 0, which is every
                      user's starting value, so nobody is signed out by this migration.
"""

from alembic import op

revision = "0034"
down_revision = "0033"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE users ADD COLUMN session_epoch INTEGER NOT NULL DEFAULT 0")


def downgrade() -> None:
    op.execute("ALTER TABLE users DROP COLUMN IF EXISTS session_epoch")
