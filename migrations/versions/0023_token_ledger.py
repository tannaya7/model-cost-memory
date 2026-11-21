"""The canonical token ledger on each run.

Revision ID: 0023
Revises: 0022

Four nullable columns on runs: usage_shape (which provider layout was read; 'none' = the response had no usage
block), usage_raw (the usage block as numbers only), reasoning_tokens and tool_use_input_tokens. NULL means
"not reported / unknown", which is different from 0. Nothing is rewritten: old runs keep NULL, and their stored
costs and token counts do not change. ADD COLUMN with no default is a metadata-only change in Postgres, so
the runs table is not rewritten or locked for long.
"""

from alembic import op

revision = "0023"
down_revision = "0022"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE runs ADD COLUMN usage_shape TEXT")
    op.execute("ALTER TABLE runs ADD COLUMN usage_raw JSONB")
    op.execute("ALTER TABLE runs ADD COLUMN reasoning_tokens INTEGER")
    op.execute("ALTER TABLE runs ADD COLUMN tool_use_input_tokens INTEGER")
    op.execute("ALTER TABLE runs ADD CONSTRAINT runs_usage_shape_check CHECK (usage_shape IS NULL OR usage_shape IN "
               "('anthropic_messages','openai_responses','openai_chat','deepseek_chat','gemini','none')) NOT VALID")


def downgrade() -> None:
    op.execute("ALTER TABLE runs DROP CONSTRAINT runs_usage_shape_check")
    op.execute("ALTER TABLE runs DROP COLUMN tool_use_input_tokens")
    op.execute("ALTER TABLE runs DROP COLUMN reasoning_tokens")
    op.execute("ALTER TABLE runs DROP COLUMN usage_raw")
    op.execute("ALTER TABLE runs DROP COLUMN usage_shape")
