"""Creating projects and their API keys."""

from __future__ import annotations

import re
from decimal import Decimal

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from .models import Project
from .security import generate_key, hash_key

PROJECT_ID = re.compile(r"^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$")


class ProjectExists(ValueError):
    """A project with this id already exists."""


async def create_project(
    session: AsyncSession,
    project_id: str,
    *,
    webhook_url: str | None = None,
    retest_monthly_cap_usd: Decimal | float = 10,
    store_tool_arguments: bool = False,
) -> tuple[Project, str]:
    """Create a project and return it with its key. The key is returned once and never stored."""
    if not PROJECT_ID.match(project_id):
        raise ValueError("project id must be 3-40 characters: lowercase letters, digits and hyphens")
    key = generate_key()
    project = Project(
        project_id=project_id, api_key_hash=hash_key(key), webhook_url=webhook_url,
        retest_monthly_cap_usd=Decimal(str(retest_monthly_cap_usd)), store_tool_arguments=store_tool_arguments,
    )
    session.add(project)
    try:
        await session.commit()
    except IntegrityError as exc:
        await session.rollback()
        raise ProjectExists(project_id) from exc
    return project, key
