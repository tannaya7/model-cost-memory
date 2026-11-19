"""Per-project opt-in for the plain-language summary of a recommendation.

Revision ID: 0027
Revises: 0026

projects.ai_summary_consent   may the computed figures of this project's recommendations (model names, pass rates, ranges,
                              costs; never prompts, answers or run text) be sent to an outside AI service to write a
                              two-sentence summary. Default OFF: until the owner turns it on, nothing is sent and any
                              earlier summary is not shown.
"""

from alembic import op

revision = "0027"
down_revision = "0026"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE projects ADD COLUMN ai_summary_consent BOOLEAN NOT NULL DEFAULT FALSE")


def downgrade() -> None:
    op.execute("ALTER TABLE projects DROP COLUMN ai_summary_consent")
