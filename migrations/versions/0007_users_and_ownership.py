"""Google sign-in: users, and which user owns each project.

Revision ID: 0007
Revises: 0006

- users: one row per Google account (google_sub is Google's stable id). No passwords are stored.
- projects.owner_user_id: NULL for projects created by the operator script; a signed-in user sees only
  the projects they own.
- projects.name: the display name chosen in the web app (project_id stays the stable slug).
- projects.key_prefix: the first characters of the current project key, so the settings page can say
  which key is live without the key itself being stored.
"""

from alembic import op

revision = "0007"
down_revision = "0006"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE users (
            user_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            google_sub  TEXT NOT NULL UNIQUE,
            email       TEXT NOT NULL,
            name        TEXT,
            picture_url TEXT,
            created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    """)
    op.execute("ALTER TABLE projects ADD COLUMN owner_user_id UUID REFERENCES users(user_id)")
    op.execute("CREATE INDEX idx_projects_owner ON projects(owner_user_id)")
    op.execute("ALTER TABLE projects ADD COLUMN name TEXT")
    op.execute("ALTER TABLE projects ADD COLUMN key_prefix TEXT")


def downgrade() -> None:
    for column in ("key_prefix", "name"):
        op.execute(f"ALTER TABLE projects DROP COLUMN IF EXISTS {column}")
    op.execute("DROP INDEX IF EXISTS idx_projects_owner")
    op.execute("ALTER TABLE projects DROP COLUMN IF EXISTS owner_user_id")
    op.execute("DROP TABLE IF EXISTS users")
