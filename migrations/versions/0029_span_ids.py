"""Optional span ids, so a task's calls can be shown as a tree of parents and children.

Revision ID: 0029

runs.span_id          this call's own id, chosen by the app (optional, at most 200 characters)
runs.parent_span_id   the span_id of the call that started this one (optional)

Both are labels the app supplies. A call with neither is shown as "no structure recorded", a child whose parent was never
recorded as "parent not recorded", and nothing is ever inferred. Nothing here changes how any call is judged or priced.
"""

from alembic import op

revision = "0029"
down_revision = "0028"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE runs ADD COLUMN span_id TEXT")
    op.execute("ALTER TABLE runs ADD COLUMN parent_span_id TEXT")
    op.execute("CREATE INDEX idx_runs_span ON runs (project_id, trace_id, span_id) WHERE span_id IS NOT NULL")


def downgrade() -> None:
    op.execute("DROP INDEX idx_runs_span")
    op.execute("ALTER TABLE runs DROP COLUMN parent_span_id")
    op.execute("ALTER TABLE runs DROP COLUMN span_id")
