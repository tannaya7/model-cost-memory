"""Index the project key lookup.

Revision ID: 0033
Revises: 0032

Every request that carries a project key looks the project up by the hash of that key (auth/access.py). Nothing indexed that column, so
each of those requests read the whole projects table. The table is small (one row per project, not per call), so a plain CREATE INDEX
is safe here: it holds a short lock on a small table and does not block ingestion (the runs table is untouched). It is not UNIQUE on
purpose: keys are random 256-bit values, but a unique rule would make a freak collision refuse a new project instead of being noticed.
"""

from alembic import op

revision = "0033"
down_revision = "0032"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("CREATE INDEX IF NOT EXISTS idx_projects_key_hash ON projects (api_key_hash)")  # index-ok: small table, see above


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_projects_key_hash")
