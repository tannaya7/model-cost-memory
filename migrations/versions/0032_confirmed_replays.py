"""Replays start only after the person confirms a preview, and automatic replays become an opt-in.

Revision ID: 0032
Revises: 0031

projects.auto_retests   default FALSE. The automatic triggers (a new model appears, the engine is unsure, a provider key is first
                        added) now run only for a project whose admin turned this on.
retests.*               what the person confirmed and what was recorded: a hash of the single-use confirmation, who confirmed and
                        when, the preview they saw (data categories, destination, cost range, retention note), the price basis,
                        the evaluator, the destination host and the ids of the sampled runs. Never prompt text.
"""

from alembic import op

revision = "0032"
down_revision = "0031"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE projects ADD COLUMN auto_retests BOOLEAN NOT NULL DEFAULT false")
    op.execute("ALTER TABLE retests ADD COLUMN confirmation_hash TEXT UNIQUE")
    op.execute("ALTER TABLE retests ADD COLUMN confirmed_by UUID REFERENCES users(user_id) ON DELETE SET NULL")
    op.execute("ALTER TABLE retests ADD COLUMN confirmed_at TIMESTAMPTZ")
    op.execute("ALTER TABLE retests ADD COLUMN preview JSONB")
    op.execute("ALTER TABLE retests ADD COLUMN price_basis JSONB")
    op.execute("ALTER TABLE retests ADD COLUMN evaluator TEXT")
    op.execute("ALTER TABLE retests ADD COLUMN provider_host TEXT")
    op.execute("ALTER TABLE retests ADD COLUMN sample_run_ids JSONB")


def downgrade() -> None:
    for col in ("sample_run_ids", "provider_host", "evaluator", "price_basis", "preview", "confirmed_at", "confirmed_by", "confirmation_hash"):
        op.execute(f"ALTER TABLE retests DROP COLUMN {col}")
    op.execute("ALTER TABLE projects DROP COLUMN auto_retests")
