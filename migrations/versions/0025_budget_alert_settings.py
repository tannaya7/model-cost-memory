"""Budget alert settings: the timezone of the month, which thresholds warn, and where alerts may go.

Revision ID: 0025
Revises: 0024

projects.budget_timezone         the IANA timezone the budget month and days are counted in (default UTC)
projects.budget_alert_levels     the percentages of the budget that raise an in-app alert (default 85 and 95)
projects.budget_alert_projected  whether a "projected over budget" warning is raised (default on)
projects.budget_alert_webhook    whether budget alerts are ALSO sent to the project's webhook (default OFF: opt in)

Budget alerts are always shown in the app. Nothing leaves it unless the owner turns the webhook on here, so projects
that already had a webhook stop receiving budget alerts there until they choose to. No stored figure changes.
"""

from alembic import op

revision = "0025"
down_revision = "0024"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE projects ADD COLUMN budget_timezone TEXT NOT NULL DEFAULT 'UTC'")
    op.execute("ALTER TABLE projects ADD COLUMN budget_alert_levels INTEGER[] NOT NULL DEFAULT '{85,95}'")
    op.execute("ALTER TABLE projects ADD COLUMN budget_alert_projected BOOLEAN NOT NULL DEFAULT TRUE")
    op.execute("ALTER TABLE projects ADD COLUMN budget_alert_webhook BOOLEAN NOT NULL DEFAULT FALSE")
    op.execute("ALTER TABLE projects ADD CONSTRAINT projects_budget_levels_check "
               "CHECK (cardinality(budget_alert_levels) <= 6 AND 0 < ALL (budget_alert_levels) AND 100 >= ALL (budget_alert_levels))")


def downgrade() -> None:
    op.execute("ALTER TABLE projects DROP CONSTRAINT projects_budget_levels_check")
    for column in ("budget_alert_webhook", "budget_alert_projected", "budget_alert_levels", "budget_timezone"):
        op.execute(f"ALTER TABLE projects DROP COLUMN {column}")
