"""Add the prompt embedding to runs, with an HNSW index for similar-run search.

Revision ID: 0002
Revises: 0001
"""

from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS vector")
    op.execute("ALTER TABLE runs ADD COLUMN embedding vector(384)")
    op.execute("CREATE INDEX idx_runs_embedding ON runs USING hnsw (embedding vector_cosine_ops)")


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_runs_embedding")
    op.execute("ALTER TABLE runs DROP COLUMN IF EXISTS embedding")
