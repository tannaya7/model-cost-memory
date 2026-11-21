"""AI news: headlines from a fixed set of public feeds.

Revision ID: 0016
Revises: 0015

news_items holds the latest headlines (news/feeds.py), shared by every project; the API marks the ones
that mention a model a project uses. Items older than 30 days are deleted at each refresh.
"""

from alembic import op

revision = "0016"
down_revision = "0015"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE news_items (
            item_id      TEXT PRIMARY KEY,
            source       TEXT NOT NULL,
            kind         TEXT NOT NULL,
            title        TEXT NOT NULL,
            link         TEXT NOT NULL,
            summary      TEXT NOT NULL DEFAULT '',
            published_at TIMESTAMPTZ NOT NULL,
            fetched_at   TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    """)
    op.execute("CREATE INDEX idx_news_published ON news_items (published_at DESC)")


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS news_items")
