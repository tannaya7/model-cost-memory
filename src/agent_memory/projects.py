"""Creating projects and their API keys."""

from __future__ import annotations

import re
import secrets
from decimal import Decimal

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
    name: str | None = None,
    owner_user_id=None,
) -> tuple[Project, str]:
    """Create a project and return it with its key. The key is returned once and never stored."""
    if not PROJECT_ID.match(project_id):
        raise ValueError("project id must be 3-40 characters: lowercase letters, digits and hyphens")
    project = Project(
        project_id=project_id, webhook_url=webhook_url, name=name or project_id, owner_user_id=owner_user_id,
        retest_monthly_cap_usd=Decimal(str(retest_monthly_cap_usd)), store_tool_arguments=store_tool_arguments,
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
