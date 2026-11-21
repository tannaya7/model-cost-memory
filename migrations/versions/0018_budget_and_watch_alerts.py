"""A server-side monthly budget, and three new alert kinds.

Revision ID: 0018
Revises: 0017

projects.monthly_budget_usd: optional, positive. Soft: it only raises alerts (alerts/watch.py).
alerts.kind: adds TOKEN_BURST, BUDGET, TRIAL_BUDGET and MODEL_RETIRING.
"""

from alembic import op

revision = "0018"
down_revision = "0017"
branch_labels = None
depends_on = None

OLD = "('VERSION_REGRESSION','SILENT_DROP','MODEL_DEPRECATED')"
NEW = "('VERSION_REGRESSION','SILENT_DROP','MODEL_DEPRECATED','TOKEN_BURST','BUDGET','TRIAL_BUDGET','MODEL_RETIRING')"


def upgrade() -> None:
    op.execute("ALTER TABLE projects ADD COLUMN monthly_budget_usd NUMERIC(12,2)")
    op.execute("ALTER TABLE projects ADD CONSTRAINT projects_budget_check "
               "CHECK (monthly_budget_usd IS NULL OR monthly_budget_usd > 0)")
    op.execute("ALTER TABLE alerts DROP CONSTRAINT alerts_kind_check")
    op.execute(f"ALTER TABLE alerts ADD CONSTRAINT alerts_kind_check CHECK (kind IN {NEW})")


def downgrade() -> None:
    op.execute("DELETE FROM alerts WHERE kind IN ('TOKEN_BURST','BUDGET','TRIAL_BUDGET','MODEL_RETIRING')")
    op.execute("ALTER TABLE alerts DROP CONSTRAINT alerts_kind_check")
    op.execute(f"ALTER TABLE alerts ADD CONSTRAINT alerts_kind_check CHECK (kind IN {OLD})")
    op.execute("ALTER TABLE projects DROP CONSTRAINT projects_budget_check")
    op.execute("ALTER TABLE projects DROP COLUMN monthly_budget_usd")
