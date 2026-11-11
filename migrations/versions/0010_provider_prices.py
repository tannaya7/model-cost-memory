"""Each provider's own price for a model, and the provider a run was sent to.

Revision ID: 0010
Revises: 0009

- model_prices: one row per (model, provider) from the price list. The catalog keeps one row per model
  name, but the same open-weight model is sold by several providers at different prices (gpt-oss-20b
  costs $0.075 per million input tokens on Groq and $0.20 on Cloudflare; Gemma is free through the
  Gemini API and paid elsewhere). A run that says which provider served it is priced from that
  provider's row; one that does not is priced from the catalog as before. A MANUAL catalog row still
  wins over both.
- runs.provider: optional, sent by the SDK. A nullable column with no default is instant to add.

The table is filled by the next catalog sync, which runs at startup.
"""

from alembic import op

revision = "0010"
down_revision = "0009"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE model_prices (
            model              TEXT NOT NULL,
            provider           TEXT NOT NULL,
            price_in_per_mtok  NUMERIC(10,4),
            price_out_per_mtok NUMERIC(10,4),
            first_seen_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (model, provider)
        )
    """)
    op.execute("ALTER TABLE runs ADD COLUMN provider TEXT")


def downgrade() -> None:
    op.execute("ALTER TABLE runs DROP COLUMN IF EXISTS provider")
    op.execute("DROP TABLE IF EXISTS model_prices")
