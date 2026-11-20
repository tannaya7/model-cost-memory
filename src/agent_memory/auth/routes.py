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
import uuid
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import RedirectResponse, Response
from sqlalchemy import Text, cast, func, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import get_settings
from ..db import get_session
from ..insights.projection import is_timezone
from ..models import Project, Run, User
from ..projects import ProjectExists, create_project, rotate_key, slug_for
from ..recommend.summary import summary_host
from ..retention import delete_project
from ..schemas import AuthConfig, DevLogin, ProjectCreate, ProjectCreated, ProjectKey, ProjectOut, ProjectPatch, ToolInputsDeleted, UiFlagsPatch, UserOut
from ..alerts.notifier import retry_given_up_alerts
from ..security import generate_webhook_secret
from ..urls import UnsafeUrl, check_outbound
from .access import current_user, optional_user, owned_project, role_in
from .orgs import audit_project, delete_account
from .permissions import role_can

MAX_PROJECTS_PER_USER = 50  # generous: a person has a handful; this stops runaway creation

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
            # PKCE (S256) on top of the client secret; authlib also sends and checks the state and the nonce,
            # and verifies the ID token's signature, issuer, audience and expiry against Google's published keys.
            client_kwargs={"scope": "openid email profile", "code_challenge_method": "S256"},
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
    request.session["epoch"] = await session.scalar(select(User.session_epoch).where(User.user_id == user_id))
    log.info("signed in", extra={"user_id": str(user_id)})
    return await session.get(User, user_id)


def _safe_next(path: str | None) -> str:
    """Only paths on this site, so the sign-in cannot be used to redirect elsewhere."""
    if not path or not path.startswith("/") or path.startswith("//") or "\\" in path:
        return "/"  # a backslash is read as a slash by browsers, so "/\\evil.example" would leave the site
    return "/" if any(ord(c) < 32 or ord(c) == 127 for c in path) else path


@router.get("/auth/config", response_model=AuthConfig, tags=["auth"])
async def auth_config() -> AuthConfig:
    s = get_settings()
    return AuthConfig(google=bool(s.google_client_id and s.google_client_secret), dev_login=s.dev_login,
                      demo_project_id=s.demo_project_id or None, auto_replays=s.auto_replays)


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
    # Invites and company access are tied to the email address, so only an address Google says it has verified counts.
    if info.get("email_verified") not in (True, "true"):
        log.warning("google sign-in refused: email not verified")
        return RedirectResponse(f"{get_settings().public_url}/signin?error=unverified", status_code=303)
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
async def logout(request: Request, session: AsyncSession = Depends(get_session), user: User | None = Depends(optional_user)) -> None:
    """End this session and every copy of its cookie: the counter rises, so a cookie someone else holds stops working too. The same
    counter signs the person out on their other devices; they sign in again there."""
    if user is not None:
        await session.execute(update(User).where(User.user_id == user.user_id).values(session_epoch=User.session_epoch + 1))
        await session.commit()
        log.info("signed out", extra={"user_id": str(user.user_id)})
    request.session.clear()


@router.get("/v1/me", response_model=UserOut, tags=["auth"])
async def me(user: User = Depends(current_user)) -> UserOut:
    return UserOut.model_validate(user)


@router.patch("/v1/me/ui-flags", response_model=UserOut, tags=["auth"])
async def patch_ui_flags(
    body: UiFlagsPatch, user: User = Depends(current_user), session: AsyncSession = Depends(get_session)
) -> UserOut:
    """Remember which first-visit guides this person has seen. Only tour_seen and first_results_seen, as
    true or false; any other key or value is refused. Only the flags sent change."""
    user.ui_flags = {**(user.ui_flags or {}), **body.model_dump(exclude_none=True)}
    await session.commit()
    return UserOut.model_validate(user)


def _project_out(p: Project, role: str = "owner") -> ProjectOut:
    """A project as the caller may see it: below admin, the webhook address and secret and the key prefix are left out."""
    details = role_can(role, "settings.view")
    return ProjectOut(
        project_id=p.project_id, organisation_id=p.organisation_id, role=role, slug=p.slug, name=p.name or p.project_id,
        webhook_url=p.webhook_url if details else None,
        webhook_secret=p.webhook_secret if details else None, retest_monthly_cap_usd=float(p.retest_monthly_cap_usd),
        retest_allowed=p.retest_allowed, key_prefix=p.key_prefix if details else None, created_at=p.created_at,
        content_retention_days=p.content_retention_days,
        monthly_budget_usd=float(p.monthly_budget_usd) if p.monthly_budget_usd is not None else None,
        store_tool_arguments=bool(p.store_tool_arguments),
        billing_mode=p.billing_mode or "per_use",
        budget_timezone=p.budget_timezone or "UTC",
        budget_alert_levels=sorted(p.budget_alert_levels) if p.budget_alert_levels is not None else [85, 95],
        budget_alert_projected=bool(p.budget_alert_projected) if p.budget_alert_projected is not None else True,
        budget_alert_webhook=bool(p.budget_alert_webhook),
        notice_alert_webhook=bool(p.notice_alert_webhook),
        ai_summary_consent=bool(p.ai_summary_consent), auto_retests=bool(p.auto_retests),
        ai_summary_host=summary_host(),
    )


@router.get("/v1/projects", response_model=list[ProjectOut], tags=["projects"])
async def list_projects(
    workspace: str | None = Query(default=None, description="A company id; leave out for your personal projects"),
    user: User = Depends(current_user), session: AsyncSession = Depends(get_session),
):
    """The projects in one workspace: your personal ones by default, or those of a company you are in."""
    if workspace is None or workspace == "personal":
        where, role = (Project.owner_user_id == user.user_id) & Project.organisation_id.is_(None), "owner"
    else:
        try:
            org_id = uuid.UUID(workspace)
        except ValueError:
            raise HTTPException(404, "No such company among yours")
        role = await role_in(session, user.user_id, org_id)
        if role is None:
            raise HTTPException(404, "No such company among yours")
        where = Project.organisation_id == org_id
    rows = (await session.execute(select(Project).where(where).order_by(Project.created_at))).scalars().all()
    return [_project_out(p, role) for p in rows]


@router.post("/v1/projects", response_model=ProjectCreated, status_code=201, tags=["projects"])
async def new_project(
    body: ProjectCreate, user: User = Depends(current_user), session: AsyncSession = Depends(get_session)
) -> ProjectCreated:
    """Create a project in your personal workspace, or in a company where you are a member or higher.
    Its key is in the response once; copy it into the SDK."""
    org_id = body.organisation_id
    if org_id is not None:
        role = await role_in(session, user.user_id, org_id)
        if role is None:
            raise HTTPException(404, "No such company among yours")
        if not role_can(role, "project.create"):
            raise HTTPException(403, "Only an admin or owner can create a project in a company")
        scope = Project.organisation_id == org_id
    else:
        scope = (Project.owner_user_id == user.user_id) & Project.organisation_id.is_(None)
    owned = (await session.execute(select(func.count()).select_from(Project).where(scope))).scalar_one()
    if owned >= MAX_PROJECTS_PER_USER:
        raise HTTPException(409, f"You already have {MAX_PROJECTS_PER_USER} projects, which is the most "
                                 "one account can have. Delete one you no longer use first.")
    for _ in range(3):  # the slug has a random suffix; retry the rare collision
        try:
            project, key = await create_project(session, slug_for(body.name), name=body.name.strip(),
                                                owner_user_id=user.user_id, organisation_id=org_id,
                                                billing_mode=body.billing_mode or "per_use")
            if org_id is not None:
                await audit_project(session, project, user, "project_created")
                await session.commit()
            return ProjectCreated(project=_project_out(project, role if org_id is not None else "owner"), api_key=key)
        except ProjectExists:
            continue
    raise HTTPException(409, "Could not create a unique project id; try again")


@router.get("/v1/projects/{project_id}", response_model=ProjectOut, tags=["projects"])
async def get_project(project: Project = Depends(owned_project)) -> ProjectOut:
    return _project_out(project)


@router.patch("/v1/projects/{project_id}", response_model=ProjectOut, tags=["projects"])
async def patch_project(
    body: ProjectPatch, project: Project = Depends(owned_project), session: AsyncSession = Depends(get_session),
    user: User = Depends(current_user),
) -> ProjectOut:
    """Change the name, the alert webhook (https only; null removes it), the monthly re-test cap, the
    project-wide re-test switch or how long run content is kept. Only the fields sent change. A shorter
    retention applies at the next daily clean-up."""
    sent = body.model_fields_set
    if "name" in sent and body.name:
        project.name = body.name.strip()
    if "webhook_url" in sent:
        if body.webhook_url is not None:
            try:
                await check_outbound(body.webhook_url, allow_private=get_settings().allow_private_urls)
            except UnsafeUrl as exc:
                raise HTTPException(422, f"webhook_url: {exc}") from exc
        changed = body.webhook_url != project.webhook_url
        project.webhook_url = body.webhook_url
        project.webhook_secret = project.webhook_secret or generate_webhook_secret()
        if changed and body.webhook_url is not None:
            await retry_given_up_alerts(session, project.project_id)
    if "retest_monthly_cap_usd" in sent and body.retest_monthly_cap_usd is not None:
        project.retest_monthly_cap_usd = Decimal(str(body.retest_monthly_cap_usd))
    if "monthly_budget_usd" in sent:  # null clears it
        project.monthly_budget_usd = (
            None if body.monthly_budget_usd is None else Decimal(str(body.monthly_budget_usd)))
    if "retest_allowed" in sent and body.retest_allowed is not None:
        project.retest_allowed = body.retest_allowed
    if "content_retention_days" in sent and body.content_retention_days is not None:
        project.content_retention_days = body.content_retention_days
    if "store_tool_arguments" in sent and body.store_tool_arguments is not None:
        project.store_tool_arguments = body.store_tool_arguments
    if "billing_mode" in sent and body.billing_mode is not None:
        project.billing_mode = body.billing_mode
    if "budget_timezone" in sent and body.budget_timezone is not None:
        if not is_timezone(body.budget_timezone):
            raise HTTPException(422, "budget_timezone: not a known timezone name (for example Europe/Berlin or UTC)")
        project.budget_timezone = body.budget_timezone
    if "budget_alert_levels" in sent and body.budget_alert_levels is not None:
        project.budget_alert_levels = body.budget_alert_levels
    if "budget_alert_projected" in sent and body.budget_alert_projected is not None:
        project.budget_alert_projected = body.budget_alert_projected
    if "budget_alert_webhook" in sent and body.budget_alert_webhook is not None:
        if body.budget_alert_webhook and not project.webhook_url:
            raise HTTPException(422, "budget_alert_webhook: add a webhook address first, then turn this on")
        project.budget_alert_webhook = body.budget_alert_webhook
    if "notice_alert_webhook" in sent and body.notice_alert_webhook is not None:
        if body.notice_alert_webhook and not project.webhook_url:
            raise HTTPException(422, "notice_alert_webhook: add a webhook address first, then turn this on")
        project.notice_alert_webhook = body.notice_alert_webhook
    if "auto_retests" in sent and body.auto_retests is not None:  # opt in: paid replays that start without a per-replay confirmation
        if body.auto_retests and not get_settings().auto_replays:
            raise HTTPException(422, "Automatic trials are switched off on this server. Every trial starts only after you review and confirm it.")
        project.auto_retests = body.auto_retests
    if "ai_summary_consent" in sent and body.ai_summary_consent is not None:
        if body.ai_summary_consent and summary_host() is None:
            raise HTTPException(422, "ai_summary_consent: this server has no summary service, so there is nothing to turn on")
        project.ai_summary_consent = body.ai_summary_consent
    # The audit line names the settings that were sent, never their values (a webhook address can hold a secret).
    await audit_project(session, project, user, "project_settings_changed", fields=sorted(sent))
    await session.commit()
    return _project_out(project, await role_in(session, user.user_id, project.organisation_id) or "owner"
                        if project.organisation_id else "owner")


@router.delete("/v1/projects/{project_id}/tool-inputs", response_model=ToolInputsDeleted, tags=["projects"])
async def delete_tool_inputs(
    project: Project = Depends(owned_project), session: AsyncSession = Depends(get_session)
) -> ToolInputsDeleted:
    """Remove the stored inputs of tool calls from every run of this project. Tool names, ids, counts, costs
    and everything else stay. It does not change the switch: new inputs are kept again if it is on."""
    rows = (await session.execute(
        select(Run).where(Run.project_id == project.project_id, Run.tool_calls.is_not(None),
                          cast(Run.tool_calls, Text).like('%"arguments"%')))).scalars().all()
    for run in rows:
        run.tool_calls = [{k: v for k, v in c.items() if k != "arguments"} if isinstance(c, dict) else c
                          for c in run.tool_calls]
    await session.commit()
    return ToolInputsDeleted(runs_cleared=len(rows))


@router.delete("/v1/projects/{project_id}", status_code=204, tags=["projects"])
async def delete_project_endpoint(
    confirm: str = Query(description="The project id again, so a project is never deleted by accident"),
    project: Project = Depends(owned_project), session: AsyncSession = Depends(get_session),
    user: User = Depends(current_user),
) -> Response:
    """Delete the project and everything recorded under it: jobs, runs with their prompts and answers,
    re-tests, recommendations, alerts, the stored provider key and usage limits. It cannot be undone,
    and the project key stops working at once."""
    if confirm != project.project_id:
        raise HTTPException(422, "confirm must equal the project id")
    project_id = project.project_id
    await audit_project(session, project, user, "project_deleted")
    await delete_project(session, project_id)
    await session.commit()
    log.info("project deleted by its owner", extra={"project_id": project_id})
    return Response(status_code=204)


@router.post("/v1/projects/{project_id}/key", response_model=ProjectKey, tags=["projects"])
async def new_project_key(
    project: Project = Depends(owned_project), session: AsyncSession = Depends(get_session),
    user: User = Depends(current_user),
) -> ProjectKey:
    key = rotate_key(project)
    await audit_project(session, project, user, "project_key_replaced")
    await session.commit()
    log.info("project key rotated", extra={"project_id": project.project_id})
    return ProjectKey(api_key=key)


@router.delete("/v1/me", status_code=204, tags=["auth"])
async def delete_my_account(
    request: Request,
    confirm: str = Query(description="Your email address again, so an account is never deleted by accident"),
    user: User = Depends(current_user), session: AsyncSession = Depends(get_session),
) -> Response:
    """Delete your account and your personal projects with everything recorded under them. Companies you were in keep
    their projects and lose only you. Refused while you are the only owner of a company: hand it over or delete it first."""
    if confirm.strip().lower() != user.email.strip().lower():
        raise HTTPException(422, "confirm must equal your email address")
    blocking = await delete_account(session, user)
    if blocking:
        await session.rollback()
        raise HTTPException(409, "You are the only owner of: " + ", ".join(blocking)
                            + ". Make someone else an owner, or delete the company, first.")
    await session.commit()
    request.session.clear()
    return Response(status_code=204)
