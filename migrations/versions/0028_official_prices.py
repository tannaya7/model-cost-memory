"""What each maker's own pricing page states, with when it was read.

Revision ID: 0028
Revises: 0027

price_sources     one row per maker's pricing page we read (status, last check, last good check)
official_prices   the standard price a page states for each model, with the time it was read

These sit beside the catalog and never change it: the catalog's price comes from a community list, and this is the
maker's own word, kept so the two can be compared and told apart on screen.
"""

from alembic import op

revision = "0028"
down_revision = "0027"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE price_sources (
            source_id       TEXT PRIMARY KEY,
            name            TEXT NOT NULL,
            provider        TEXT NOT NULL,
            url             TEXT NOT NULL,
            status          TEXT NOT NULL DEFAULT 'NEVER' CHECK (status IN ('NEVER','OK','UNREADABLE','FETCH_FAILED')),
            last_checked_at TIMESTAMPTZ,
            last_ok_at      TIMESTAMPTZ,
            detail          TEXT,
            model_count     INTEGER NOT NULL DEFAULT 0
        )""")
    op.execute("""
        CREATE TABLE official_prices (
            provider        TEXT NOT NULL,
            model           TEXT NOT NULL,
            input_per_mtok  NUMERIC(12,6),
            output_per_mtok NUMERIC(12,6),
            note            TEXT,
            read_at         TIMESTAMPTZ NOT NULL,
            PRIMARY KEY (provider, model)
        )""")


def downgrade() -> None:
    op.execute("DROP TABLE official_prices")
    op.execute("DROP TABLE price_sources")
