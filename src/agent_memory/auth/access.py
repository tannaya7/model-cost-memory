"""Deciding which project a request may see.

Three ways in, checked in this order:

1. **Project key** (`X-API-Key` or `Authorization: Bearer`): the SDK, scripts and the key-only web
   setup. An invalid key is a 401, never a fall-through.
2. **Signed-in user** (session cookie) with `X-Project-Id`: a project the user owns, or a company project they are
   an active member of (viewers read only). With no header, a user who has exactly one personal project gets that one.
3. **The public demo** (`DEMO_PROJECT_ID`): anyone may *read* that one project, never change it, and
   never start a re-test, so the public cannot spend the API budget. Only the pages the demo shows are
   open (DEMO_READABLE): jobs, runs, recommendations and their history, alerts, insights, usage limits,
   the model catalog, the live flow and the AI news. Re-test history, the provider-key status and the re-test cap
   are not: they describe the operator's account, not the demo, and are refused with 403.
"""

from __future__ import annotations

import uuid

from fastapi import Depends, Header, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import get_settings
from ..db import get_session
from ..logging_config import set_context
from ..models import Membership, Organisation, Project, User
from ..security import extract_key, hash_key

READ_METHODS = ("GET", "HEAD", "OPTIONS")

from .permissions import ROLE_RANK, role_can, required_permission  # noqa: E402,F401  (the one permission table)


async def role_in(session: AsyncSession, user_id, org_id) -> str | None:
    """The person's role in a company, only while the membership is active and the company is not deleted."""
    return (await session.execute(
        select(Membership.role).join(Organisation, Organisation.org_id == Membership.org_id).where(
            Membership.org_id == org_id, Membership.user_id == user_id, Membership.status == "active",
            Organisation.deleted_at.is_(None)))).scalar_one_or_none()


async def project_role(session: AsyncSession, user: User, project: Project | None) -> str | None:
    """What this person may do in this project: 'owner' for their own personal project, their company role for a
    company project, or None (no access). Decided from the database every time, never from the browser."""
    if project is None:
        return None
    if project.organisation_id is None:
        return "owner" if project.owner_user_id == user.user_id else None
    return await role_in(session, user.user_id, project.organisation_id)

# The route templates the public demo may read, without a key or a sign-in.
DEMO_READABLE = frozenset({
    "/v1/jobs", "/v1/jobs/{job}/recommendation", "/v1/jobs/{job}/history", "/v1/jobs/{job}/regressions",
    "/v1/jobs/{job}/insights", "/v1/runs", "/v1/runs/{run_id}", "/v1/insights/spend", "/v1/alerts",
    "/v1/models", "/v1/flow", "/v1/flow/stream", "/v1/limits", "/v1/news", "/v1/insights/daily",
})


def _route_template(request: Request) -> str | None:
    route = request.scope.get("route")
    return getattr(route, "path", None)


async def optional_user(request: Request, session: AsyncSession = Depends(get_session)) -> User | None:
    raw = request.session.get("user_id") if "session" in request.scope else None
    if not raw:
        return None
    try:
        user = await session.get(User, uuid.UUID(raw))
    except ValueError:
        return None
    # A cookie made before the last logout carries an older counter. A cookie from before this check existed carries none, which counts as 0.
    if user is None or request.session.get("epoch", 0) != user.session_epoch:
        return None
    return user


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
    role: str | None = None
    if key:
        project = (
            await session.execute(select(Project).where(Project.api_key_hash == hash_key(key)))
        ).scalar_one_or_none()
        if project is None:
            raise HTTPException(401, "Missing or invalid project key", headers={"WWW-Authenticate": "Bearer"})
        role = "key"
    elif user is not None:
        if x_project_id:
            project = await session.get(Project, x_project_id)
            role = await project_role(session, user, project)
            if role is None:
                raise HTTPException(404, "No such project among yours")
        else:  # no header: the personal workspace, as before
            owned = select(Project).where(Project.owner_user_id == user.user_id, Project.organisation_id.is_(None))
            mine = (await session.execute(owned.limit(2))).scalars().all()
            if len(mine) != 1:
                raise HTTPException(400, "Choose a project: send X-Project-Id" if mine else "Create a project first")
            project = mine[0]
            role = "owner"
    else:
        demo = get_settings().demo_project_id
        if demo and request.method in READ_METHODS:
            if _route_template(request) not in DEMO_READABLE:
                raise HTTPException(403, "The public demo does not show this. Sign in, or use a project key")
            project = await session.get(Project, demo)
            role = "demo"
    if project is None:
        raise HTTPException(401, "Missing or invalid project key", headers={"WWW-Authenticate": "Bearer"})
    # Deny by default: whoever this is, the route's permission must be in the table for their role.
    permission = required_permission(request.method, _route_template(request))
    if not role_can(role, permission):
        raise HTTPException(403, _DENIED.get(permission, "Your role does not allow this"))
    request.state.role = role
    set_context(project_id=project.project_id)  # every log line in this request now carries the project
    return project


_DENIED = {
    "data.write": "Your role in this company can look but not change things",
    "retest.start": "Only an admin or owner can start a trial, because it spends the company's provider budget",
    "limits.change": "Only an admin or owner can change usage limits",
    "providerkey.change": "Only an admin or owner can see or change the stored provider key",
    "export.run": "Only an admin or owner can export data. A file can leave the product, so it needs the same care as the settings",
}


def can_see_content(request: Request) -> bool:
    """Whether this request's caller may read prompt and answer text. Viewers get the numbers only."""
    return role_can(getattr(request.state, "role", None), "content.view")


async def owned_project(
    project_id: str, user: User = Depends(current_user), session: AsyncSession = Depends(get_session)
) -> Project:
    """A project the signed-in user manages, for the setup pages: their own personal project, or a company project
    where they are an admin or owner. 404 for anyone else's (a company member below admin gets 403)."""
    project = await session.get(Project, project_id)
    role = await project_role(session, user, project)
    if role is None:
        raise HTTPException(404, "No such project among yours")
    if not role_can(role, "settings.view"):
        raise HTTPException(403, "Only an admin or owner of the company can change this")
    return project


async def signed_in_project(
    session: AsyncSession = Depends(get_session),
    user: User = Depends(current_user),
    x_project_id: str | None = Header(default=None),
) -> Project:
    """The project the signed-in owner is working in, for settings that only the owner may change (a project
    key, which an SDK or script holds, is not enough; a key alone gets 401). Same project choice as
    `current_project` for a signed-in user: X-Project-Id, or the only project they own."""
    if x_project_id:
        project = await session.get(Project, x_project_id)
        role = await project_role(session, user, project)
        if role is None:
            raise HTTPException(404, "No such project among yours")
        if not role_can(role, "settings.view"):
            raise HTTPException(403, "Only an admin or owner of the company can change this")
    else:
        owned = select(Project).where(Project.owner_user_id == user.user_id, Project.organisation_id.is_(None))
        mine = (await session.execute(owned.limit(2))).scalars().all()
        if len(mine) != 1:
            raise HTTPException(400, "Choose a project: send X-Project-Id" if mine else "Create a project first")
        project = mine[0]
    set_context(project_id=project.project_id)
    return project
