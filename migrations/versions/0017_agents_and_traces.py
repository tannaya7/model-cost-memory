"""Which agent made a call, which user task it served, and what tool definitions cost.

Revision ID: 0017
Revises: 0016

All four columns are optional: rows and SDKs from before this carry NULL.
"""

from alembic import op

revision = "0017"
down_revision = "0016"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE runs ADD COLUMN agent TEXT")
    op.execute("ALTER TABLE runs ADD COLUMN trace_id TEXT")
    op.execute("ALTER TABLE runs ADD COLUMN tools_tokens INTEGER")
    op.execute("ALTER TABLE runs ADD COLUMN tool_call_count INTEGER")
    # CONCURRENTLY does not block writes to runs while it builds; it cannot run inside a transaction.
    with op.get_context().autocommit_block():
        op.execute(
            "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_runs_project_trace "
            "ON runs (project_id, trace_id) WHERE trace_id IS NOT NULL"
        )


def downgrade() -> None:
    with op.get_context().autocommit_block():
        op.execute("DROP INDEX CONCURRENTLY IF EXISTS idx_runs_project_trace")
    for column in ("tool_call_count", "tools_tokens", "trace_id", "agent"):
        op.execute(f"ALTER TABLE runs DROP COLUMN {column}")
