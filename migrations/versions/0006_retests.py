"""Re-tests: the runs replayed on a candidate model, the provider key they use, and their answer keys.

Revision ID: 0006
Revises: 0005

- retests: one replay of sampled past runs on a candidate model, under a budget. Started by a person,
  by a new model in the catalog, or by the engine being unsure. Progress is saved as each result
  arrives, so the page can poll it.
- provider_keys: the customer's own key for the provider re-tests call, asked for only when a re-test
  is first needed. Encrypted with the server's SECRET_KEY; only the last four characters are shown.
- runs.retest_id: which re-test produced a RETEST run.
- runs.expected: the answer key of an ANSWER_KEY run, kept only when the job has re-test consent,
  because a replayed run can only be checked against the same answers.
- projects.retest_allowed: a project-wide switch for re-tests, on top of each job's consent.
"""

from alembic import op

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE retests (
            retest_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            job_id          UUID NOT NULL REFERENCES jobs(job_id),
            project_id      TEXT NOT NULL REFERENCES projects(project_id),
            candidate_model TEXT NOT NULL,
            trigger         TEXT NOT NULL CHECK (trigger IN ('MANUAL','NEW_MODEL','UNSURE')),
            status          TEXT NOT NULL DEFAULT 'QUEUED' CHECK (status IN
                              ('QUEUED','RUNNING','DONE','STOPPED_BUDGET','STOPPED_CAP','FAILED')),
            budget_usd      NUMERIC(10,4) NOT NULL CHECK (budget_usd > 0),
            spent_usd       NUMERIC(12,6) NOT NULL DEFAULT 0,
            runs_planned    INT NOT NULL DEFAULT 0,
            runs_done       INT NOT NULL DEFAULT 0,
            passed          INT NOT NULL DEFAULT 0,
            failed          INT NOT NULL DEFAULT 0,
            message         TEXT,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
            started_at      TIMESTAMPTZ,
            finished_at     TIMESTAMPTZ
        )
    """)
    op.execute("CREATE INDEX idx_retests_queued ON retests(created_at) WHERE status = 'QUEUED'")
    op.execute("CREATE INDEX idx_retests_job ON retests(job_id, created_at DESC)")
    op.execute("""
        CREATE TABLE provider_keys (
            project_id   TEXT PRIMARY KEY REFERENCES projects(project_id),
            provider     TEXT NOT NULL,
            base_url     TEXT NOT NULL,
            key_encrypted TEXT NOT NULL,
            key_hint     TEXT NOT NULL,
            created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    """)
    op.execute("ALTER TABLE runs ADD COLUMN retest_id UUID REFERENCES retests(retest_id)")
    op.execute("ALTER TABLE runs ADD COLUMN expected JSONB")
    # runs is the table that grows: build its index without locking writes. CONCURRENTLY cannot run
    # inside a transaction, hence the autocommit block. (0003's index predates this rule; it was built
    # while the table was small.)
    with op.get_context().autocommit_block():
        op.execute("CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_runs_retest ON runs(retest_id) "
                   "WHERE retest_id IS NOT NULL")
    op.execute("ALTER TABLE projects ADD COLUMN retest_allowed BOOLEAN NOT NULL DEFAULT true")


def downgrade() -> None:
    op.execute("ALTER TABLE projects DROP COLUMN IF EXISTS retest_allowed")
    op.execute("DROP INDEX IF EXISTS idx_runs_retest")
    op.execute("ALTER TABLE runs DROP COLUMN IF EXISTS expected")
    op.execute("ALTER TABLE runs DROP COLUMN IF EXISTS retest_id")
    op.execute("DROP TABLE IF EXISTS provider_keys")
    op.execute("DROP TABLE IF EXISTS retests")
