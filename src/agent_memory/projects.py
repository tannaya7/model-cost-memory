"""Creating projects and their API keys."""

from __future__ import annotations

import re
import secrets
import unicodedata
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from .models import Project
from .security import generate_key, generate_webhook_secret, hash_key

PROJECT_ID = re.compile(r"^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$")


class ProjectExists(ValueError):
    """A project with this id already exists."""


KEY_PREFIX_SHOWN = 13  # "mcm_live_" and four characters: enough to tell keys apart, useless to an attacker


def slug_for(name: str) -> str:
    """A project id from a display name: "Acme Invoices!" -> "acme-invoices-3f9a"."""
    base = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:30] or "project"
    return f"{base}-{secrets.token_hex(2)}"


SLUG = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
SLUG_MIN, SLUG_MAX = 3, 40
# Words the web app uses as its own addresses; an owned project never takes one of these as its short name.
RESERVED_SLUGS = frozenset({"new", "key", "use-key", "settings", "api", "admin", "www", "demo"})


def make_slug(name: str | None) -> str:
    """The short address name for a project name: "Acme Shop!" -> "acme-shop", "Café" -> "cafe".

    Lowercase a-z, 0-9 and single hyphens, 3 to 40 characters. Empty or too short -> "project".
    """
    folded = unicodedata.normalize("NFKD", name or "").encode("ascii", "ignore").decode()
    base = re.sub(r"[^a-z0-9]+", "-", folded.lower()).strip("-")[:SLUG_MAX].strip("-")
    return base if len(base) >= SLUG_MIN else "project"


def pick_slug(name: str | None, taken: set[str] | frozenset[str]) -> str:
    """make_slug, with -2, -3 ... added until it is neither taken nor reserved."""
    base = make_slug(name)
    candidate, n = base, 1
    while candidate in taken or candidate in RESERVED_SLUGS:
        n += 1
        suffix = f"-{n}"
        candidate = base[: SLUG_MAX - len(suffix)].strip("-") + suffix
    return candidate


async def unique_slug_for(session: AsyncSession, owner_user_id, name: str | None, organisation_id=None) -> str:
    """A slug for a new project that nothing else in the same workspace uses: the company's, or the person's personal one."""
    if organisation_id is not None:
        where = Project.organisation_id == organisation_id
    else:
        where = (Project.owner_user_id == owner_user_id) & Project.organisation_id.is_(None)
    rows = await session.execute(select(Project.slug).where(where))
    return pick_slug(name, set(rows.scalars()))


def rotate_key(project: Project) -> str:
    """Give the project a new key; the old one stops working. Returns the key, shown once."""
    key = generate_key()
    project.api_key_hash, project.key_prefix = hash_key(key), key[:KEY_PREFIX_SHOWN]
    return key


async def create_project(
    session: AsyncSession,
    project_id: str,
    *,
    webhook_url: str | None = None,
    retest_monthly_cap_usd: Decimal | float = 10,
    store_tool_arguments: bool = False,
    billing_mode: str = "per_use",
    name: str | None = None,
    owner_user_id=None,
    slug: str | None = None,
    organisation_id=None,
) -> tuple[Project, str]:
    """Create a project and return it with its key. The key is returned once and never stored."""
    if not PROJECT_ID.match(project_id):
        raise ValueError("project id must be 3-40 characters: lowercase letters, digits and hyphens")
    if slug is None:
        # Owned projects get a readable name from their display name; operator-made ones keep their id.
        slug = await unique_slug_for(session, owner_user_id, name, organisation_id) if owner_user_id is not None else project_id
    project = Project(
        project_id=project_id, slug=slug, webhook_url=webhook_url, name=name or project_id, owner_user_id=owner_user_id,
        organisation_id=organisation_id,
        retest_monthly_cap_usd=Decimal(str(retest_monthly_cap_usd)), store_tool_arguments=store_tool_arguments,
        billing_mode=billing_mode,
        webhook_secret=generate_webhook_secret(),
    )
    key = rotate_key(project)
    session.add(project)
    try:
        await session.commit()
    except IntegrityError as exc:
        await session.rollback()
        raise ProjectExists(project_id) from exc
    return project, key
