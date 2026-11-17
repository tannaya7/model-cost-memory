"""A short readable name for each project, for the web address.

Revision ID: 0022
Revises: 0021

projects.slug: lowercase a-z, 0-9 and single hyphens, e.g. 'production'. Generated slugs are 3 to 40 characters; the database check allows 1 to 40 so that a project keeping its own short id as its slug (the demo project, old test rows) is valid. It is what the
browser address shows (/p/production); the long project_id stays in the backend and the API.

Existing rows are backfilled deterministically (oldest first, then project_id): a project with an owner gets a
slug from its name, with -2, -3 ... on a clash within that owner and on reserved words; an operator-made
project with no owner keeps its id when that is already slug-like (the public 'demo'). Then the column becomes
NOT NULL with a check and two unique indexes.

Uniqueness is per owner for now. When company accounts arrive, move it to the organisation: replace
uq_projects_owner_slug with an index on (organisation_id, slug). Slugs are stable: renaming a project
does not change its slug.
"""

import re
import unicodedata

import sqlalchemy as sa
from alembic import op

revision = "0022"
down_revision = "0021"
branch_labels = None
depends_on = None

RESERVED = {"new", "key", "use-key", "settings", "api", "admin", "www", "demo"}
SLUG_RE = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")


def _slug(name: str | None) -> str:
    folded = unicodedata.normalize("NFKD", name or "").encode("ascii", "ignore").decode()
    base = re.sub(r"[^a-z0-9]+", "-", folded.lower()).strip("-")[:40].strip("-")
    return base if len(base) >= 3 else "project"


def _pick(name: str | None, taken: set[str]) -> str:
    base = _slug(name)
    candidate, n = base, 1
    while candidate in taken or candidate in RESERVED:
        n += 1
        suffix = f"-{n}"
        candidate = base[: 40 - len(suffix)].strip("-") + suffix
    return candidate


def upgrade() -> None:
    op.execute("ALTER TABLE projects ADD COLUMN slug TEXT")
    conn = op.get_bind()
    rows = conn.execute(sa.text(
        "SELECT project_id, name, owner_user_id FROM projects ORDER BY created_at, project_id")).all()
    taken: dict[object, set[str]] = {}
    for project_id, name, owner in rows:
        used = taken.setdefault(owner, set())
        if owner is None and SLUG_RE.match(project_id) and 3 <= len(project_id) <= 40 and project_id not in used:
            slug = project_id  # operator-made: the id is already a readable name ('demo')
        else:
            slug = _pick(name or project_id, used)
        used.add(slug)
        conn.execute(sa.text("UPDATE projects SET slug = :s WHERE project_id = :p"), {"s": slug, "p": project_id})
    op.execute("ALTER TABLE projects ALTER COLUMN slug SET NOT NULL")
    op.execute("ALTER TABLE projects ADD CONSTRAINT projects_slug_check "
               "CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) BETWEEN 1 AND 40)")
    op.execute("CREATE UNIQUE INDEX uq_projects_owner_slug ON projects(owner_user_id, slug) "
               "WHERE owner_user_id IS NOT NULL")
    op.execute("CREATE UNIQUE INDEX uq_projects_ownerless_slug ON projects(slug) WHERE owner_user_id IS NULL")


def downgrade() -> None:
    op.execute("DROP INDEX uq_projects_ownerless_slug")
    op.execute("DROP INDEX uq_projects_owner_slug")
    op.execute("ALTER TABLE projects DROP CONSTRAINT projects_slug_check")
    op.execute("ALTER TABLE projects DROP COLUMN slug")
