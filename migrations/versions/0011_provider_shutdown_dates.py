"""Each provider's own shutdown date for a model.

Revision ID: 0011
Revises: 0010

The catalog keeps one shutdown date per model name, taken from one provider's entry, but providers
retire the same model on different dates: Vertex AI retired gemini-2.5-flash on 2026-10-20 while the
Gemini API still serves it, and 207 model names in the price list have providers that disagree. A
job's model was then treated as RETIRED (never recommended, a forced SWITCH, a false alert) while it
was still being served to that job. model_prices now carries each provider's date, and a job's model
status is read for the provider its runs name (catalog/lifecycle.py).

The next catalog sync, which runs at startup, fills the dates in.
"""

from alembic import op

revision = "0011"
down_revision = "0010"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE model_prices ADD COLUMN shutdown_date DATE")


def downgrade() -> None:
    op.execute("ALTER TABLE model_prices DROP COLUMN IF EXISTS shutdown_date")
