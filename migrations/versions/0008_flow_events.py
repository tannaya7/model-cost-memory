"""Flow events: a short-lived trail of each run crossing the pipeline, for the live data-flow view.

Revision ID: 0008
Revises: 0007

- flow_events: one row per step a run takes (sdk -> api -> check -> index -> consolidate), written in
  the same transaction as the step itself, so the view never shows a step that did not happen. The
  increasing event_id lets the browser resume where it left off (SSE Last-Event-ID). They are a view
  aid, not evidence: the janitor deletes them after a day.
"""

from alembic import op

revision = "0008"
down_revision = "0007"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE flow_events (
            event_id   BIGSERIAL PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES projects(project_id),
            run_id     UUID,
            stage      TEXT NOT NULL CHECK (stage IN ('sdk','api','check','index','consolidate')),
            message    TEXT NOT NULL,
            data       JSONB,
            ts         TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    """)
    op.execute("CREATE INDEX idx_flow_events_project ON flow_events(project_id, event_id)")
    op.execute("CREATE INDEX idx_flow_events_ts ON flow_events(ts)")


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS flow_events")
