"""Deciding which project a request may see.

Three ways in, checked in this order:

1. **Project key** (`X-API-Key` or `Authorization: Bearer`): the SDK, scripts and the key-only web
   setup. An invalid key is a 401, never a fall-through.
2. **Signed-in user** (session cookie) with `X-Project-Id`: only a project the user owns. With no
   header, a user who owns exactly one project gets that one.
3. **The public demo** (`DEMO_PROJECT_ID`): anyone may *read* that one project, never change it, and
   never start a re-test, so the public cannot spend the API budget.
"""

from __future__ import annotations

import uuid

from fastapi import Depends, Header, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import get_settings
from ..db import get_session
from ..logging_config import set_context
from ..models import Project, User
from ..security import extract_key, hash_key

READ_METHODS = ("GET", "HEAD", "OPTIONS")


async def optional_user(request: Request, session: AsyncSession = Depends(get_session)) -> User | None:
    raw = request.session.get("user_id") if "session" in request.scope else None
    if not raw:
        return None
    try:
        return await session.get(User, uuid.UUID(raw))
    except ValueError:
        return None


async def current_user(user: User | None = Depends(optional_user)) -> User:
    if user is None:
        raise HTTPException(401, "Sign in first")
    set_context(user_id=str(user.user_id))
    return user


async def current_project(
    request: Request,
    session: AsyncSession = Depends(get_session),
    user: User | None = Depends(optional_user),
    x_api_key: str | None = Header(default=None),
    authorization: str | None = Header(default=None),
    x_project_id: str | None = Header(default=None),
) -> Project:
    """The project this request acts on, or 401/403/404."""
    key = extract_key(x_api_key, authorization)
    project = None
    if key:
        project = (
            await session.execute(select(Project).where(Project.api_key_hash == hash_key(key)))
        ).scalar_one_or_none()
        if project is None:
            raise HTTPException(401, "Missing or invalid project key", headers={"WWW-Authenticate": "Bearer"})
    elif user is not None:
        owned = select(Project).where(Project.owner_user_id == user.user_id)
        if x_project_id:
            project = (await session.execute(owned.where(Project.project_id == x_project_id))).scalar_one_or_none()
            if project is None:
                raise HTTPException(404, "No such project among yours")
        else:
            mine = (await session.execute(owned.limit(2))).scalars().all()
            if len(mine) != 1:
                raise HTTPException(400, "Choose a project: send X-Project-Id" if mine else "Create a project first")
            project = mine[0]
    else:
        demo = get_settings().demo_project_id
        if demo and request.method in READ_METHODS:
            project = await session.get(Project, demo)
    if project is None:
        raise HTTPException(401, "Missing or invalid project key", headers={"WWW-Authenticate": "Bearer"})
    set_context(project_id=project.project_id)  # every log line in this request now carries the project
    return project


async def owned_project(
    project_id: str, user: User = Depends(current_user), session: AsyncSession = Depends(get_session)
) -> Project:
    """A project the signed-in user owns, for the setup pages; 404 for anyone else's."""
    project = await session.get(Project, project_id)
    if project is None or project.owner_user_id != user.user_id:
        raise HTTPException(404, "No such project among yours")
    return project
