"""Alert delivery with retries, one open alert per finding, and a webhook signing secret.

Revision ID: 0005
Revises: 0004

- alerts.dedupe_key: what the alert is about ("VERSION_REGRESSION|model|version"); a partial unique index
  keeps one *open* alert per finding, so each sweep does not raise it again. Once resolved, it can recur.
- alerts.delivery_attempts / next_attempt_at / last_error: the webhook is retried with backoff; the alert
  stays open and visible from the API whether or not delivery succeeds.
- projects.webhook_secret: each payload is signed (HMAC-SHA256) so the receiver can verify it came from us.
"""

from alembic import op

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE alerts ADD COLUMN dedupe_key TEXT NOT NULL DEFAULT ''")
    op.execute("ALTER TABLE alerts ADD COLUMN delivery_attempts INT NOT NULL DEFAULT 0")
    op.execute("ALTER TABLE alerts ADD COLUMN next_attempt_at TIMESTAMPTZ")
    op.execute("ALTER TABLE alerts ADD COLUMN last_error TEXT")
    op.execute("CREATE UNIQUE INDEX idx_alerts_open ON alerts(job_id, dedupe_key) WHERE resolved_at IS NULL")
    op.execute("CREATE INDEX idx_alerts_undelivered ON alerts(next_attempt_at) WHERE delivered_at IS NULL")
    op.execute("ALTER TABLE projects ADD COLUMN webhook_secret TEXT")


def downgrade() -> None:
    op.execute("ALTER TABLE projects DROP COLUMN IF EXISTS webhook_secret")
    op.execute("DROP INDEX IF EXISTS idx_alerts_undelivered")
    op.execute("DROP INDEX IF EXISTS idx_alerts_open")
    for column in ("last_error", "next_attempt_at", "delivery_attempts", "dedupe_key"):
        op.execute(f"ALTER TABLE alerts DROP COLUMN IF EXISTS {column}")
