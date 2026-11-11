"""Record which embedder wrote each vector, and let a project opt in to storing tool-call arguments.

Revision ID: 0003
Revises: 0002

- runs.embedding_model: vectors from different embedders are not comparable, so a stored vector may only be
  reused (the persistent embedding cache) or searched against vectors from the same embedder. Existing rows
  stay NULL and are simply not eligible for reuse.
- projects.store_tool_arguments: tool-call arguments can hold sensitive data, so by default only tool names
  and call ids are kept; a project must opt in to keep arguments.
"""

from alembic import op

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE runs ADD COLUMN embedding_model TEXT")
    op.execute(
        "CREATE INDEX idx_runs_embedding_cache ON runs(project_id, prompt_hash, embedding_model) "
        "WHERE embedding IS NOT NULL"
    )
    op.execute("ALTER TABLE projects ADD COLUMN store_tool_arguments BOOLEAN NOT NULL DEFAULT false")


def downgrade() -> None:
    op.execute("ALTER TABLE projects DROP COLUMN IF EXISTS store_tool_arguments")
    op.execute("DROP INDEX IF EXISTS idx_runs_embedding_cache")
    op.execute("ALTER TABLE runs DROP COLUMN IF EXISTS embedding_model")
