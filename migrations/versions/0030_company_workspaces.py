"""Optional company workspaces: a person can belong to several companies and keep their own personal projects.

Revision ID: 0030
Revises: 0029

organisations   a company workspace (a person's personal workspace is implicit: their projects with no organisation)
memberships     who belongs to which company, with a role; leaving or removal ends the row, it is never silently re-used
org_invites     a single-use, expiring invite for one email address; only a hash of the token is stored
org_events      who did what in a company (invites, joins, leaves, removals, role changes); never prompt or run text
projects.organisation_id   NULL = a personal project (the owner is the person). Set = a company project: membership decides access.

Nothing is moved or merged: every existing project keeps organisation_id NULL and its owner, so behaviour is unchanged until
someone creates a company. Slugs are unique per workspace (a personal "production" and a company "production" can both exist).
"""

from alembic import op

revision = "0030"
down_revision = "0029"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE organisations (
            org_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            name        TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
            created_by  UUID REFERENCES users(user_id) ON DELETE SET NULL,
            created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
            deleted_at  TIMESTAMPTZ
        )""")
    op.execute("""
        CREATE TABLE memberships (
            org_id        UUID NOT NULL REFERENCES organisations(org_id),
            user_id       UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
            role          TEXT NOT NULL CHECK (role IN ('owner','admin','member','viewer')),
            status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','ended')),
            ended_reason  TEXT CHECK (ended_reason IN ('left','removed')),
            created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
            joined_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
            ended_at      TIMESTAMPTZ,
            PRIMARY KEY (org_id, user_id),
            CHECK ((status = 'active') = (ended_at IS NULL))
        )""")
    op.execute("CREATE INDEX idx_memberships_user ON memberships (user_id) WHERE status = 'active'")
    op.execute("""
        CREATE TABLE org_invites (
            invite_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id      UUID NOT NULL REFERENCES organisations(org_id),
            email       TEXT NOT NULL,
            role        TEXT NOT NULL CHECK (role IN ('admin','member','viewer')),
            token_hash  TEXT NOT NULL UNIQUE,
            created_by  UUID REFERENCES users(user_id) ON DELETE SET NULL,
            created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
            expires_at  TIMESTAMPTZ NOT NULL,
            used_at     TIMESTAMPTZ,
            used_by     UUID REFERENCES users(user_id) ON DELETE SET NULL,
            revoked_at  TIMESTAMPTZ
        )""")
    op.execute("CREATE INDEX idx_org_invites_org ON org_invites (org_id, created_at DESC)")
    op.execute("""
        CREATE TABLE org_events (
            event_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id          UUID NOT NULL REFERENCES organisations(org_id),
            actor_user_id   UUID REFERENCES users(user_id) ON DELETE SET NULL,
            action          TEXT NOT NULL,
            target_user_id  UUID REFERENCES users(user_id) ON DELETE SET NULL,
            detail          JSONB NOT NULL DEFAULT '{}'::jsonb,
            at              TIMESTAMPTZ NOT NULL DEFAULT now()
        )""")
    op.execute("CREATE INDEX idx_org_events_org ON org_events (org_id, at DESC)")
    op.execute("ALTER TABLE projects ADD COLUMN organisation_id UUID REFERENCES organisations(org_id)")
    op.execute("CREATE INDEX idx_projects_org ON projects (organisation_id) WHERE organisation_id IS NOT NULL")
    # Slugs are unique within a workspace, not across all of a person's access.
    op.execute("DROP INDEX uq_projects_owner_slug")
    op.execute("DROP INDEX uq_projects_ownerless_slug")
    op.execute("CREATE UNIQUE INDEX uq_projects_owner_slug ON projects (owner_user_id, slug) "
               "WHERE owner_user_id IS NOT NULL AND organisation_id IS NULL")
    op.execute("CREATE UNIQUE INDEX uq_projects_ownerless_slug ON projects (slug) "
               "WHERE owner_user_id IS NULL AND organisation_id IS NULL")
    op.execute("CREATE UNIQUE INDEX uq_projects_org_slug ON projects (organisation_id, slug) WHERE organisation_id IS NOT NULL")


def downgrade() -> None:
    op.execute("DROP INDEX uq_projects_org_slug")
    op.execute("DROP INDEX uq_projects_ownerless_slug")
    op.execute("DROP INDEX uq_projects_owner_slug")
    op.execute("CREATE UNIQUE INDEX uq_projects_owner_slug ON projects (owner_user_id, slug) WHERE owner_user_id IS NOT NULL")
    op.execute("CREATE UNIQUE INDEX uq_projects_ownerless_slug ON projects (slug) WHERE owner_user_id IS NULL")
    op.execute("DROP INDEX idx_projects_org")
    op.execute("ALTER TABLE projects DROP COLUMN organisation_id")
    op.execute("DROP TABLE org_events")
    op.execute("DROP TABLE org_invites")
    op.execute("DROP TABLE memberships")
    op.execute("DROP TABLE organisations")
