"""An optional label for the customer's own feature or workflow.

Revision ID: 0038
Revises: 0037

runs.feature   a short label chosen by the customer's own app and sent with a call (for example `support_summary`). It is optional, it is not a
               verified identity and not an invoice-grade chargeback record, and nothing is ever inferred from prompt text to fill it. Calls
               that carry none stay NULL and are shown as "Unlabelled".

The index is partial (only labelled calls) and built CONCURRENTLY, so it does not block ingestion while it builds on a large runs table.
"""

from alembic import op

revision = "0038"
down_revision = "0037"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE runs ADD COLUMN feature TEXT")
    with op.get_context().autocommit_block():
        op.execute("CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_runs_project_feature ON runs (project_id, feature) WHERE feature IS NOT NULL")


def downgrade() -> None:
    with op.get_context().autocommit_block():
        op.execute("DROP INDEX CONCURRENTLY IF EXISTS idx_runs_project_feature")
    op.execute("ALTER TABLE runs DROP COLUMN IF EXISTS feature")
