"""Sign-in and project ownership routes (technical plan 3.3, added 12 Oct).

    GET  /auth/config               what sign-in this server offers
    GET  /auth/google/login         start Google sign-in (?next=/path to come back to)
    GET  /auth/google/callback      finish it: create or update the user, set the session cookie
    POST /auth/dev/login            development only (DEV_LOGIN=true): sign in as an email, no Google
    POST /auth/logout               end the session
    GET  /v1/me                     the signed-in user
    GET  /v1/projects               the user's own projects; POST creates one and returns its key once
    GET  /v1/projects/{id}          one of them; PATCH changes name, webhook, re-test cap and switch
    POST /v1/projects/{id}/key      a new project key, shown once; the old one stops working
"""

from __future__ import annotations

import logging
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import RedirectResponse
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import get_settings
from ..db import get_session
from ..models import Project, User
from ..projects import ProjectExists, create_project, rotate_key, slug_for
from ..schemas import AuthConfig, DevLogin, ProjectCreate, ProjectCreated, ProjectKey, ProjectOut, ProjectPatch, UserOut
from ..security import generate_webhook_secret
from .access import current_user, owned_project

log = logging.getLogger("agent_memory.auth")
router = APIRouter()
_oauth = None


def _google():
    """The authlib client, registered on first use from the settings of the moment."""
    global _oauth
    settings = get_settings()
    if not (settings.google_client_id and settings.google_client_secret):
        raise HTTPException(404, "Google sign-in is not configured on this server")
    if _oauth is None:
        from authlib.integrations.starlette_client import OAuth

        _oauth = OAuth()
        _oauth.register(
            "google", client_id=settings.google_client_id, client_secret=settings.google_client_secret,
            server_metadata_url="https://accounts.google.com/.well-known/openid-configuration",
            client_kwargs={"scope": "openid email profile"},
        )
    return _oauth.google


async def _sign_in(request: Request, session: AsyncSession, sub: str, email: str, name: str | None,
                   picture: str | None) -> User:
    values = {"google_sub": sub, "email": email, "name": name, "picture_url": picture}
    user_id = (
        await session.execute(
            insert(User).values(**values)
            .on_conflict_do_update(index_elements=["google_sub"], set_={"email": email, "name": name,
                                                                         "picture_url": picture})
            .returning(User.user_id)
        )
    ).scalar_one()
    await session.commit()
    request.session.clear()
    request.session["user_id"] = str(user_id)
    log.info("signed in", extra={"user_id": str(user_id)})
    return await session.get(User, user_id)


def _safe_next(path: str | None) -> str:
    """Only paths on this site, so the sign-in cannot be used to redirect elsewhere."""
    return path if path and path.startswith("/") and not path.startswith("//") else "/"


@router.get("/auth/config", response_model=AuthConfig, tags=["auth"])
async def auth_config() -> AuthConfig:
    s = get_settings()
    return AuthConfig(google=bool(s.google_client_id and s.google_client_secret), dev_login=s.dev_login,
                      demo_project_id=s.demo_project_id or None)


@router.get("/auth/google/login", tags=["auth"])
async def google_login(request: Request, next: str | None = None):
    google = _google()
    request.session["next"] = _safe_next(next)
    return await google.authorize_redirect(request, f"{get_settings().public_url}/auth/google/callback")


@router.get("/auth/google/callback", tags=["auth"])
async def google_callback(request: Request, session: AsyncSession = Depends(get_session)):
    google = _google()
    try:
        token = await google.authorize_access_token(request)
    except Exception as exc:  # authlib raises several types for a cancelled or tampered sign-in
        log.warning("google sign-in failed: %s", type(exc).__name__)
        return RedirectResponse(f"{get_settings().public_url}/signin?error=google", status_code=303)
    info = token.get("userinfo") or {}
    if not info.get("sub") or not info.get("email"):
        return RedirectResponse(f"{get_settings().public_url}/signin?error=google", status_code=303)
    next_path = _safe_next(request.session.get("next"))
    await _sign_in(request, session, info["sub"], info["email"], info.get("name"), info.get("picture"))
    return RedirectResponse(f"{get_settings().public_url}{next_path}", status_code=303)


@router.post("/auth/dev/login", response_model=UserOut, tags=["auth"])
async def dev_login(body: DevLogin, request: Request, session: AsyncSession = Depends(get_session)) -> UserOut:
    """Local development only: sign in as any email. Off unless DEV_LOGIN=true."""
    if not get_settings().dev_login:
        raise HTTPException(404, "Not available")
    user = await _sign_in(request, session, f"dev:{body.email.lower()}", body.email.lower(), body.name, None)
    return UserOut.model_validate(user)


@router.post("/auth/logout", status_code=204, tags=["auth"])
async def logout(request: Request) -> None:
    request.session.clear()


@router.get("/v1/me", response_model=UserOut, tags=["auth"])
async def me(user: User = Depends(current_user)) -> UserOut:
    return UserOut.model_validate(user)


def _project_out(p: Project) -> ProjectOut:
    return ProjectOut(
        project_id=p.project_id, name=p.name or p.project_id, webhook_url=p.webhook_url,
        webhook_secret=p.webhook_secret, retest_monthly_cap_usd=float(p.retest_monthly_cap_usd),
        retest_allowed=p.retest_allowed, key_prefix=p.key_prefix, created_at=p.created_at,
    )


@router.get("/v1/projects", response_model=list[ProjectOut], tags=["projects"])
async def list_projects(user: User = Depends(current_user), session: AsyncSession = Depends(get_session)):
    rows = (
        await session.execute(select(Project).where(Project.owner_user_id == user.user_id).order_by(Project.created_at))
    ).scalars().all()
    return [_project_out(p) for p in rows]


@router.post("/v1/projects", response_model=ProjectCreated, status_code=201, tags=["projects"])
async def new_project(
    body: ProjectCreate, user: User = Depends(current_user), session: AsyncSession = Depends(get_session)
) -> ProjectCreated:
    """Create a project you own. Its key is in the response once; copy it into the SDK."""
    for _ in range(3):  # the slug has a random suffix; retry the rare collision
        try:
            project, key = await create_project(session, slug_for(body.name), name=body.name.strip(),
                                                owner_user_id=user.user_id)
            return ProjectCreated(project=_project_out(project), api_key=key)
        except ProjectExists:
            continue
    raise HTTPException(409, "Could not create a unique project id; try again")


@router.get("/v1/projects/{project_id}", response_model=ProjectOut, tags=["projects"])
async def get_project(project: Project = Depends(owned_project)) -> ProjectOut:
    return _project_out(project)


@router.patch("/v1/projects/{project_id}", response_model=ProjectOut, tags=["projects"])
async def patch_project(
    body: ProjectPatch, project: Project = Depends(owned_project), session: AsyncSession = Depends(get_session)
) -> ProjectOut:
    """Change the name, the alert webhook (https only; null removes it), the monthly re-test cap or
    the project-wide re-test switch. Only the fields sent change."""
    sent = body.model_fields_set
    if "name" in sent and body.name:
        project.name = body.name.strip()
    if "webhook_url" in sent:
        project.webhook_url = body.webhook_url
        project.webhook_secret = project.webhook_secret or generate_webhook_secret()
    if "retest_monthly_cap_usd" in sent and body.retest_monthly_cap_usd is not None:
        project.retest_monthly_cap_usd = Decimal(str(body.retest_monthly_cap_usd))
    if "retest_allowed" in sent and body.retest_allowed is not None:
        project.retest_allowed = body.retest_allowed
    await session.commit()
    return _project_out(project)


@router.post("/v1/projects/{project_id}/key", response_model=ProjectKey, tags=["projects"])
async def new_project_key(
    project: Project = Depends(owned_project), session: AsyncSession = Depends(get_session)
) -> ProjectKey:
    key = rotate_key(project)
    await session.commit()
    log.info("project key rotated", extra={"project_id": project.project_id})
    return ProjectKey(api_key=key)
