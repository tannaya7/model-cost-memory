"""Optional company workspaces (0030).

A person always has a personal workspace: their own projects, as before. They may also create a company or be
invited to one, and belong to several. Nothing here moves or merges data:

- Joining a company gives access to that company's projects. The person's personal projects stay theirs and private.
- Leaving or being removed ends the membership. The company keeps its projects; the person keeps their personal
  projects; no project changes owner or workspace.
- The last owner cannot leave, be removed or be demoted: a company is handed over or deleted first.
- An invite is for one email address, single-use, expires after 7 days, and only a hash of its token is stored.
- Roles: owner > admin > member > viewer. Viewers read only. Admins manage members, invites and project settings.
  Only owners make admins, delete the company or hand over ownership.

Access is always decided from an active membership in the database, never from anything the browser sends.
"""

from __future__ import annotations

import hashlib
import secrets
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..insights.company import DAYS as OVERVIEW_DAYS
from ..exports import COMPANY_COLUMNS, COMPANY_TEXT, csv_file, write_csv
from ..insights.company import company_overview
from ..models import Membership, OrgEvent, OrgInvite, Organisation, Project, User
from ..retention import delete_project
from ..schemas import (
    CompanyOverviewOut, EventOut, InviteAccept, InviteCreate, InviteCreated, InviteOut, MemberOut, MemberRolePatch, OrgCreate, OrgOut, WorkspaceOut,
)
from .access import current_user, project_role, role_in
from .permissions import ORG_PERMISSIONS, ROLE_RANK, matrix, role_can

router = APIRouter(tags=["workspaces"])

INVITE_DAYS = 7
MAX_ORGS_CREATED = 10
MAX_PENDING_INVITES = 50
GENERIC_INVITE = "This invite is not valid. It may have expired, been used or been withdrawn. Ask for a new one."


def _now() -> datetime:
    return datetime.now(timezone.utc)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


async def _event(session: AsyncSession, org_id, actor, action: str, target=None, **detail) -> None:
    session.add(OrgEvent(org_id=org_id, actor_user_id=actor, action=action, target_user_id=target, detail=detail))


async def _require_role(session: AsyncSession, user: User, org_id: uuid.UUID, permission: str) -> str:
    """The caller's role in an active company if it has the permission, else 404 (no membership: the company is not
    revealed) or 403. Checked against the database on every call."""
    role = await role_in(session, user.user_id, org_id)
    if role is None:
        raise HTTPException(404, "No such company among yours")
    if not role_can(role, permission):
        raise HTTPException(403, f"Your role ({role}) cannot do this: {ORG_PERMISSIONS[permission][1].lower()}")
    return role


async def audit_project(session: AsyncSession, project: Project, user: User, action: str, **detail) -> None:
    """Record a sensitive action on a company project in the company's audit trail. Labels only, never values."""
    if project.organisation_id is not None:
        await _event(session, project.organisation_id, user.user_id, action, None, project_id=project.project_id, **detail)


async def _active_owners(session: AsyncSession, org_id: uuid.UUID) -> list[uuid.UUID]:
    """Active owners, locked so two simultaneous leaves cannot both remove the last owner."""
    rows = await session.execute(
        select(Membership.user_id).where(
            Membership.org_id == org_id, Membership.status == "active", Membership.role == "owner").with_for_update())
    return list(rows.scalars())


async def _end(session: AsyncSession, m: Membership, reason: str) -> None:
    m.status, m.ended_reason, m.ended_at, m.job_role = "ended", reason, _now(), None  # a job role never outlives the membership


@router.get("/v1/workspaces", response_model=list[WorkspaceOut])
async def list_workspaces(user: User = Depends(current_user), session: AsyncSession = Depends(get_session)):
    """Your personal workspace first, then every company you are an active member of."""
    personal = (await session.execute(select(func.count()).select_from(Project).where(
        Project.owner_user_id == user.user_id, Project.organisation_id.is_(None)))).scalar_one()
    out = [WorkspaceOut(kind="personal", org_id=None, name="Personal", role="owner", project_count=personal, member_count=1)]
    rows = (await session.execute(
        select(Organisation, Membership.role).join(Membership, Membership.org_id == Organisation.org_id).where(
            Membership.user_id == user.user_id, Membership.status == "active", Organisation.deleted_at.is_(None))
        .order_by(Organisation.created_at))).all()
    for org, role in rows:
        projects = (await session.execute(select(func.count()).select_from(Project).where(
            Project.organisation_id == org.org_id))).scalar_one()
        members = (await session.execute(select(func.count()).select_from(Membership).where(
            Membership.org_id == org.org_id, Membership.status == "active"))).scalar_one()
        out.append(WorkspaceOut(kind="company", org_id=org.org_id, name=org.name, role=role,
                                project_count=projects, member_count=members))
    return out


@router.post("/v1/organisations", response_model=OrgOut, status_code=201)
async def create_organisation(body: OrgCreate, user: User = Depends(current_user),
                              session: AsyncSession = Depends(get_session)) -> OrgOut:
    """Create a company. You become its owner. Your personal projects stay where they are."""
    made = (await session.execute(select(func.count()).select_from(Organisation).where(
        Organisation.created_by == user.user_id, Organisation.deleted_at.is_(None)))).scalar_one()
    if made >= MAX_ORGS_CREATED:
        raise HTTPException(409, f"You have already created {MAX_ORGS_CREATED} companies, the most one person can have")
    org = Organisation(name=body.name.strip(), created_by=user.user_id)
    session.add(org)
    await session.flush()
    session.add(Membership(org_id=org.org_id, user_id=user.user_id, role="owner"))
    await _event(session, org.org_id, user.user_id, "company_created")
    await session.commit()
    return OrgOut(org_id=org.org_id, name=org.name, role="owner")


@router.delete("/v1/organisations/{org_id}", status_code=204)
async def delete_organisation(org_id: uuid.UUID, confirm: str = Query(description="The company name again"),
                              user: User = Depends(current_user), session: AsyncSession = Depends(get_session)) -> Response:
    """Owner only. A company with projects cannot be deleted: its projects are never moved or deleted silently."""
    await _require_role(session, user, org_id, "company.delete")
    org = await session.get(Organisation, org_id)
    if confirm != org.name:
        raise HTTPException(422, "confirm must equal the company name")
    left = (await session.execute(select(func.count()).select_from(Project).where(Project.organisation_id == org_id))).scalar_one()
    if left:
        raise HTTPException(409, f"This company still has {left} project{'s' if left != 1 else ''}. "
                                 "Delete them first; projects are never moved or deleted for you.")
    now = _now()
    org.deleted_at = now
    await session.execute(update(Membership).where(Membership.org_id == org_id, Membership.status == "active").values(
        status="ended", ended_reason="removed", ended_at=now, job_role=None))
    await session.execute(update(OrgInvite).where(OrgInvite.org_id == org_id, OrgInvite.used_at.is_(None),
                                                  OrgInvite.revoked_at.is_(None)).values(revoked_at=now))
    await _event(session, org_id, user.user_id, "company_deleted")
    await session.commit()
    return Response(status_code=204)


@router.get("/v1/organisations/{org_id}/members", response_model=list[MemberOut])
async def list_members(org_id: uuid.UUID, user: User = Depends(current_user), session: AsyncSession = Depends(get_session)):
    mine = await _require_role(session, user, org_id, "members.view")
    rows = (await session.execute(
        select(Membership, User).join(User, User.user_id == Membership.user_id).where(
            Membership.org_id == org_id, Membership.status == "active").order_by(Membership.joined_at))).all()
    emails = role_can(mine, "members.view_emails")  # addresses are for admins; everyone else sees names and roles
    return [MemberOut(user_id=u.user_id, email=u.email if emails else None, name=u.name, role=m.role, joined_at=m.joined_at)
            for m, u in rows]


@router.patch("/v1/organisations/{org_id}/members/{user_id}", response_model=MemberOut)
async def change_role(org_id: uuid.UUID, user_id: uuid.UUID, body: MemberRolePatch, user: User = Depends(current_user),
                      session: AsyncSession = Depends(get_session)) -> MemberOut:
    """Owners change any role. Admins may only move members and viewers between those two roles."""
    mine = await _require_role(session, user, org_id, "members.change_role")
    owners = await _active_owners(session, org_id)
    m = await session.get(Membership, (org_id, user_id))
    if m is None or m.status != "active":
        raise HTTPException(404, "No such member")
    if not role_can(mine, "roles.grant_admin") and (ROLE_RANK[m.role] >= ROLE_RANK["admin"] or ROLE_RANK[body.role] >= ROLE_RANK["admin"]):
        raise HTTPException(403, "Only an owner can change an admin or owner, or make one")
    if m.role == "owner" and body.role != "owner" and owners == [user_id]:
        raise HTTPException(409, "This is the last owner. Make someone else an owner first, or delete the company.")
    old, m.role = m.role, body.role
    await _event(session, org_id, user.user_id, "role_changed", user_id, old=old, new=body.role)
    await session.commit()
    target = await session.get(User, user_id)
    return MemberOut(user_id=user_id, email=target.email, name=target.name, role=m.role, joined_at=m.joined_at)


@router.delete("/v1/organisations/{org_id}/members/{user_id}", status_code=204)
async def remove_member(org_id: uuid.UUID, user_id: uuid.UUID, user: User = Depends(current_user),
                        session: AsyncSession = Depends(get_session)) -> Response:
    """End someone's membership. They lose access to the company's projects at once and keep their personal ones.
    The company's projects and their keys stay as they are: rotate a project key if the person had seen it."""
    mine = await _require_role(session, user, org_id, "members.remove")
    owners = await _active_owners(session, org_id)
    m = await session.get(Membership, (org_id, user_id))
    if m is None or m.status != "active":
        raise HTTPException(404, "No such member")
    if user_id == user.user_id:
        raise HTTPException(409, "Use Leave to remove yourself")
    if not role_can(mine, "roles.grant_admin") and ROLE_RANK[m.role] >= ROLE_RANK["admin"]:
        raise HTTPException(403, "Only an owner can remove an admin or owner")
    if m.role == "owner" and owners == [user_id]:
        raise HTTPException(409, "This is the last owner and cannot be removed")
    await _end(session, m, "removed")
    await _event(session, org_id, user.user_id, "member_removed", user_id, role=m.role)
    await session.commit()
    return Response(status_code=204)


@router.post("/v1/organisations/{org_id}/leave", status_code=204)
async def leave_organisation(org_id: uuid.UUID, user: User = Depends(current_user),
                             session: AsyncSession = Depends(get_session)) -> Response:
    """Leave a company. Your personal projects are untouched; the company keeps its projects. The last owner cannot leave."""
    await _require_role(session, user, org_id, "company.leave")
    owners = await _active_owners(session, org_id)
    m = await session.get(Membership, (org_id, user.user_id))
    if m.role == "owner" and owners == [user.user_id]:
        raise HTTPException(409, "You are the last owner. Make someone else an owner first, or delete the company.")
    await _end(session, m, "left")
    await _event(session, org_id, user.user_id, "member_left", user.user_id, role=m.role)
    await session.commit()
    return Response(status_code=204)


def _invite_out(i: OrgInvite) -> InviteOut:
    state = ("used" if i.used_at else "withdrawn" if i.revoked_at else
             "expired" if i.expires_at <= _now() else "pending")
    return InviteOut(invite_id=i.invite_id, email=i.email, role=i.role, state=state,
                     created_at=i.created_at, expires_at=i.expires_at)


@router.post("/v1/organisations/{org_id}/invites", response_model=InviteCreated, status_code=201)
async def create_invite(org_id: uuid.UUID, body: InviteCreate, user: User = Depends(current_user),
                        session: AsyncSession = Depends(get_session)) -> InviteCreated:
    """Invite one email address. No email is sent: the link is shown once for you to pass on yourself."""
    mine = await _require_role(session, user, org_id, "members.invite")
    if ROLE_RANK[body.role] > ROLE_RANK[mine]:
        raise HTTPException(403, "You cannot invite someone to a higher role than your own")
    if body.role == "admin" and not role_can(mine, "roles.grant_admin"):
        raise HTTPException(403, "Only an owner can invite an admin")
    pending = (await session.execute(select(func.count()).select_from(OrgInvite).where(
        OrgInvite.org_id == org_id, OrgInvite.used_at.is_(None), OrgInvite.revoked_at.is_(None),
        OrgInvite.expires_at > _now()))).scalar_one()
    if pending >= MAX_PENDING_INVITES:
        raise HTTPException(409, f"This company already has {MAX_PENDING_INVITES} open invites. Withdraw some first.")
    token = secrets.token_urlsafe(32)
    invite = OrgInvite(org_id=org_id, email=body.email.strip().lower(), role=body.role, token_hash=hash_token(token),
                       created_by=user.user_id, expires_at=_now() + timedelta(days=INVITE_DAYS))
    session.add(invite)
    await session.flush()
    await _event(session, org_id, user.user_id, "invite_created", role=body.role)
    await session.commit()
    return InviteCreated(invite=_invite_out(invite), token=token, link=f"/join/{token}")


@router.get("/v1/organisations/{org_id}/invites", response_model=list[InviteOut])
async def list_invites(org_id: uuid.UUID, user: User = Depends(current_user), session: AsyncSession = Depends(get_session)):
    await _require_role(session, user, org_id, "members.invite")
    rows = (await session.execute(select(OrgInvite).where(OrgInvite.org_id == org_id)
                                  .order_by(OrgInvite.created_at.desc()).limit(100))).scalars().all()
    return [_invite_out(i) for i in rows]


@router.delete("/v1/organisations/{org_id}/invites/{invite_id}", status_code=204)
async def withdraw_invite(org_id: uuid.UUID, invite_id: uuid.UUID, user: User = Depends(current_user),
                          session: AsyncSession = Depends(get_session)) -> Response:
    await _require_role(session, user, org_id, "members.invite")
    invite = await session.get(OrgInvite, invite_id)
    if invite is None or invite.org_id != org_id:
        raise HTTPException(404, "No such invite")
    if invite.used_at is None and invite.revoked_at is None:
        invite.revoked_at = _now()
        await _event(session, org_id, user.user_id, "invite_withdrawn")
        await session.commit()
    return Response(status_code=204)


@router.post("/v1/invites/accept", response_model=WorkspaceOut)
async def accept_invite(body: InviteAccept, user: User = Depends(current_user),
                        session: AsyncSession = Depends(get_session)) -> WorkspaceOut:
    """Join a company with an invite link. The signed-in address must be the one invited. Joining never moves
    your personal projects. If you left or were removed before, this starts a new membership with the invited role."""
    invite = (await session.execute(select(OrgInvite).where(OrgInvite.token_hash == hash_token(body.token))
                                    .with_for_update())).scalar_one_or_none()
    org = await session.get(Organisation, invite.org_id) if invite else None
    if (invite is None or invite.used_at or invite.revoked_at or invite.expires_at <= _now()
            or org is None or org.deleted_at is not None):
        raise HTTPException(404, GENERIC_INVITE)
    if invite.email != user.email.strip().lower():
        raise HTTPException(403, "This invite was sent to a different email address than the one you are signed in with. "
                                 "Sign in with that address, or ask for a new invite.")
    m = await session.get(Membership, (invite.org_id, user.user_id))
    now = _now()
    if m is not None and m.status == "active":
        raise HTTPException(409, "You are already in this company")
    if m is None:
        session.add(Membership(org_id=invite.org_id, user_id=user.user_id, role=invite.role))
    else:
        m.role, m.status, m.ended_reason, m.ended_at, m.joined_at, m.job_role = invite.role, "active", None, None, now, None
    invite.used_at, invite.used_by = now, user.user_id
    await _event(session, invite.org_id, user.user_id, "invite_accepted", user.user_id, role=invite.role)
    await session.commit()
    return WorkspaceOut(kind="company", org_id=org.org_id, name=org.name, role=invite.role, project_count=0, member_count=0)


async def _company_view(session: AsyncSession, user: User, org_id: uuid.UUID, days: int, permission: str):
    """The caller's role, the company, the projects this role may open, and the aggregate overview of exactly those.
    Used by the screen and by the CSV, so a file can never hold more than the screen is allowed to show."""
    if days not in OVERVIEW_DAYS:
        raise HTTPException(422, f"days must be one of {list(OVERVIEW_DAYS)}")
    role = await _require_role(session, user, org_id, permission)
    org = await session.get(Organisation, org_id)
    candidates = (await session.execute(select(Project).where(Project.organisation_id == org_id)
                                        .order_by(Project.created_at))).scalars().all()
    allowed = [p for p in candidates if role_can(await project_role(session, user, p), "metrics.view")]
    return role, org, allowed, await company_overview(session, allowed, days=days)


@router.get("/v1/organisations/{org_id}/overview/export.csv")
async def export_overview(org_id: uuid.UUID, days: int = Query(default=30, description="Period in days: 7, 14, 30 or 90"),
                          user: User = Depends(current_user), session: AsyncSession = Depends(get_session)) -> Response:
    """The company overview as a CSV file, for admins and owners. The same numbers as the screen, for the same projects, with no text and
    no person in it. Each row says its period, units and cost basis. Text values a spreadsheet could run as a formula are neutralized."""
    role, org, allowed, found = await _company_view(session, user, org_id, days, "overview.export")
    period = {"period_start": found.since.date().isoformat(), "period_end": found.until.date().isoformat(), "currency": "USD",
              "cost_basis": found.totals["billable_basis"]}
    by_label = "caller-supplied label (not verified, not chargeback-grade)"
    rows = [{"section": "totals", "name": "all projects you may open", "calls": found.totals["calls"], "tokens": found.totals["tokens"],
             "cost_usd": found.totals["billable_usd"], "unpriced_calls": found.totals["unpriced_calls"],
             "attribution": "aggregate", "chargeback_grade": False, **period}]
    for p in found.projects:
        rows.append({"section": "project", "name": p["name"], "project": p["name"], "pay_mode": p["pay_mode"], "calls": p["calls"], "tokens": p["tokens"],
                     "cost_usd": p["cost_usd"], "unpriced_calls": p["unpriced_calls"], "attribution": "verified (the project key)",
                     "chargeback_grade": False, **period})
    for t in found.tasks:
        rows.append({"section": "ai_task", "name": t["task"], "project": t["project"], "pay_mode": t["pay_mode"], "calls": t["calls"], "tokens": t["tokens"],
                     "cost_usd": t["cost_usd"], "unpriced_calls": t["unpriced_calls"], "attribution": by_label, "chargeback_grade": False, **period})
    for m in found.models:
        rows.append({"section": "model", "name": m["model"], "calls": m["calls"], "tokens": m["tokens"], "cost_usd": m["cost_usd"],
                     "unpriced_calls": m["unpriced_calls"], "attribution": by_label, "chargeback_grade": False, **period})
    for d in found.trend:
        rows.append({"section": "day", "name": d["day"].isoformat(), "day": d["day"].isoformat(), "calls": d["calls"], "tokens": d["tokens"],
                     "cost_usd": d["billable_usd"], "attribution": "aggregate (pay-per-use projects only for cost)", "chargeback_grade": False, **period})
    body, changed = write_csv(COMPANY_COLUMNS, rows, text_columns=COMPANY_TEXT)
    await _event(session, org_id, user.user_id, "overview_exported", None, days=days, rows=len(rows))
    await session.commit()
    name = f"model-cost-memory-company-last-{days}-days.csv"
    return Response(content=csv_file(body), media_type="text/csv; charset=utf-8", headers={
        "Content-Disposition": f'attachment; filename="{name}"', "Cache-Control": "no-store", "X-Export-Rows": str(len(rows)),
        "X-Export-Neutralized": str(changed), "X-Content-Type-Options": "nosniff"})


@router.get("/v1/organisations/{org_id}/overview", response_model=CompanyOverviewOut)
async def overview(org_id: uuid.UUID, days: int = Query(default=30, description="Period in days: 7, 14, 30 or 90"),
                   user: User = Depends(current_user), session: AsyncSession = Depends(get_session)) -> CompanyOverviewOut:
    """Counts, tokens and list-price cost across the company's projects, by project, task and model and over time.
    Aggregates only: no prompt or answer text and no per-person figures exist in it. Only projects the caller may
    open are included, each checked on its own."""
    role, org, allowed, found = await _company_view(session, user, org_id, days, "overview.view")
    members = (await session.execute(select(func.count()).select_from(Membership).where(
        Membership.org_id == org_id, Membership.status == "active"))).scalar_one()
    return CompanyOverviewOut(
        org_id=org_id, name=org.name, days=days, since=found.since, until=found.until, your_role=role,
        projects_shown=len(allowed), members=members, totals=found.totals, by_mode=found.by_mode, coverage=found.coverage,
        projects=found.projects, trend=found.trend, tasks=found.tasks, models=found.models, attribution=found.attribution,
        notes=found.notes)


@router.get("/v1/permissions")
async def permission_matrix(user: User = Depends(current_user)) -> dict:
    """What each role may do, for companies and for projects. The same table the server enforces."""
    return matrix()


@router.get("/v1/organisations/{org_id}/events", response_model=list[EventOut])
async def audit_trail(org_id: uuid.UUID, user: User = Depends(current_user), session: AsyncSession = Depends(get_session)):
    """The company's audit trail, newest first: who did what and when. Labels and ids only, never prompt or run text."""
    await _require_role(session, user, org_id, "audit.view")
    rows = (await session.execute(select(OrgEvent).where(OrgEvent.org_id == org_id)
                                  .order_by(OrgEvent.at.desc()).limit(200))).scalars().all()
    people = {u.user_id: u for u in (await session.execute(select(User).where(User.user_id.in_(
        {e.actor_user_id for e in rows} | {e.target_user_id for e in rows} - {None})))).scalars()}
    name = lambda uid: (people[uid].name or people[uid].email) if uid in people else None  # noqa: E731
    return [EventOut(event_id=e.event_id, action=e.action, actor=name(e.actor_user_id), target=name(e.target_user_id),
                     detail=e.detail, at=e.at) for e in rows]


async def delete_account(session: AsyncSession, user: User) -> list[str]:
    """What deleting a person's account does, spelled out:

    - Refused while they are the only owner of a company that is not deleted: hand it over or delete it first.
    - Their memberships end ("left"). Company projects stay with the company (their creator is just cleared).
    - Their personal projects and everything recorded under them are deleted, as with deleting a project.
    - The account row is deleted. Returns the names of companies that block it (empty when done)."""
    blocking: list[str] = []
    rows = (await session.execute(
        select(Organisation, Membership).join(Membership, Membership.org_id == Organisation.org_id).where(
            Membership.user_id == user.user_id, Membership.status == "active", Membership.role == "owner",
            Organisation.deleted_at.is_(None)))).all()
    for org, _ in rows:
        if await _active_owners(session, org.org_id) == [user.user_id]:
            blocking.append(org.name)
    if blocking:
        return blocking
    for org, m in rows:
        await _end(session, m, "left")
        await _event(session, org.org_id, user.user_id, "member_left", user.user_id, role="owner", reason="account_deleted")
    now = _now()
    await session.execute(update(Membership).where(Membership.user_id == user.user_id, Membership.status == "active")
                          .values(status="ended", ended_reason="left", ended_at=now, job_role=None))
    personal = (await session.execute(select(Project.project_id).where(
        Project.owner_user_id == user.user_id, Project.organisation_id.is_(None)))).scalars().all()
    for pid in personal:
        await delete_project(session, pid)
    await session.execute(update(Project).where(Project.owner_user_id == user.user_id).values(owner_user_id=None))
    await session.flush()
    await session.delete(user)
    return []
