"""A company privacy notice with recorded acknowledgment, and an optional self-declared job role.

Revision ID: 0031
Revises: 0030

org_notice_acks     which person was shown which version of a company's notice, and when. Proof that the notice was
                    shown, not a legal consent and not a compliance claim. Removed with the account.
memberships.job_role  optional, chosen by the person themselves from a short fixed list. Never inferred, never used for
                    access, budgets, ranking or evaluation. Cleared when the membership ends.
"""

from alembic import op

revision = "0031"
down_revision = "0030"
branch_labels = None
depends_on = None

ROLES = "('engineering','product','data_science','operations','support','finance','legal','other')"


def upgrade() -> None:
    op.execute("""
        CREATE TABLE org_notice_acks (
            org_id           UUID NOT NULL REFERENCES organisations(org_id),
            user_id          UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
            version          TEXT NOT NULL,
            acknowledged_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (org_id, user_id, version)
        )""")
    op.execute(f"ALTER TABLE memberships ADD COLUMN job_role TEXT CONSTRAINT memberships_job_role_check CHECK (job_role IN {ROLES})")


def downgrade() -> None:
    op.execute("ALTER TABLE memberships DROP COLUMN job_role")
    op.execute("DROP TABLE org_notice_acks")
