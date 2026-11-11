"""A run whose price is unknown stores no cost, rather than a cost of zero.

Revision ID: 0009
Revises: 0008

- runs.cost_usd becomes nullable with no default. Before, a run on a model missing from the catalog
  (and sent without a cost) was stored at $0, so it looked free: it dragged its model's mean cost down
  and understated spend. NULL means "price unknown"; the engine averages cost over priced runs only,
  and spend reports how many runs it could not price. A model that really is free has a catalog price
  of 0 and still stores 0. Existing rows are left as they are: a stored 0 cannot be told apart.

Changing a column's nullability and default only touches the catalog, so it is instant on a large table.
"""

from alembic import op

revision = "0009"
down_revision = "0008"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE runs ALTER COLUMN cost_usd DROP NOT NULL")
    op.execute("ALTER TABLE runs ALTER COLUMN cost_usd DROP DEFAULT")


def downgrade() -> None:
    op.execute("UPDATE runs SET cost_usd = 0 WHERE cost_usd IS NULL")
    op.execute("ALTER TABLE runs ALTER COLUMN cost_usd SET DEFAULT 0")
    op.execute("ALTER TABLE runs ALTER COLUMN cost_usd SET NOT NULL")
