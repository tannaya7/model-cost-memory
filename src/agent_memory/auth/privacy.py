"""The company privacy notice, its recorded acknowledgment, the optional self-declared job role, and the role rollup.

What this is and is not
- The notice tells people in a company what the account records, who can see it, how long it is kept and how access is
  checked. The text is built from the same permission table the server enforces and from the product's real defaults, so
  it cannot drift from what the code does (a test checks this).
- Acknowledging it records which version a person was shown and when. That is proof the notice was shown. It is not a
  consent, and neither it nor anything here is a statement that any law is met. The company decides why it uses this data.
- A job role is chosen by the person themselves from a short fixed list, or left empty. It is never inferred from an
  email address or a title, never shown next to a name, and never used for access, budgets, model ranking, evaluation
  or any decision about a person. It is cleared when the membership ends.
- The rollup shows only how many members declared each role, only for groups of MIN_GROUP or more, and nothing at all
  while the company has fewer than MIN_GROUP members. Five is our design choice, not a legal or industry standard.
  Usage or cost by role is deliberately not offered: it would need each call attributed to a member, which is not
  collected, and member-level spend for admins is blocked pending legal review and the owner's approval.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..models import Membership, OrgEvent, OrgNoticeAck, User
from ..schemas import (
    JobRolePut, NoticeAck, CompanyNoticeOut, NoticeSection, RollupGroup, RollupOut, YouInCompany,
)
from .access import current_user
from .orgs import _require_role
from .permissions import matrix, role_can

router = APIRouter(tags=["privacy"])

NOTICE_VERSION = "company-notice-1"
MIN_GROUP = 5  # our design choice, not a standard
DEFAULT_RETENTION_DAYS = 90
JOB_ROLES = {
    "engineering": "Engineering", "product": "Product", "data_science": "Data science", "operations": "Operations",
    "support": "Support", "finance": "Finance", "legal": "Legal", "other": "Other",
}


def _roles_with(permission: str) -> str:
    rows = {r["permission"]: r["roles"] for r in matrix()["project"] + matrix()["company"]}
    return ", ".join(rows[permission])


def notice_sections() -> list[NoticeSection]:
    """The notice, generated from the real permission table and defaults."""
    return [
        NoticeSection(heading="What the account records", body=[
            "For each AI call your company's apps send: the time, the model name, token counts, a list-price cost, the AI task "
            "and project it belongs to, whether its answer passed a check, and optional labels the app adds (an agent name, a task id).",
            f"Prompt and answer text and tool calls are stored only if the app sends them. They are kept for each project's retention "
            f"period (default {DEFAULT_RETENTION_DAYS} days, an admin can change it) and then deleted. The numbers stay.",
        ]),
        NoticeSection(heading="What it does not record", body=[
            "No individual employee identity is attached to a call, so there is no spend, usage or ranking for any one person, "
            "and no administrator can see one. If that ever changes, you will be told first and this notice will be updated.",
        ]),
        NoticeSection(heading="Who can see what", body=[
            f"Numbers (counts, tokens, list-price cost) for the projects you can open: {_roles_with('metrics.view')}.",
            f"Prompt and answer text of those projects: {_roles_with('content.view')}. Viewers do not see text.",
            f"Settings, project keys, people and the audit trail: {_roles_with('settings.view')}. "
            "The company overview shows counts and cost only, never text and never people.",
            "Labels such as task and agent names are set by the app, not verified, and are not suitable for charging anyone.",
        ]),
        NoticeSection(heading="Optional job role", body=[
            "You may say what kind of work you do from a short list, or leave it empty. Only you can set or clear it. "
            "It is never guessed from your email or title and is not shown next to your name.",
            f"Administrators see only how many members chose each role, and only for groups of {MIN_GROUP} or more. "
            f"{MIN_GROUP} is our own design choice, not a legal or industry standard. It is never used for access, budgets, "
            "model ranking or evaluating anyone.",
        ]),
        NoticeSection(heading="How access is checked and recorded", body=[
            "Every request is checked on the server against your current role. Changes by administrators (invites, role changes, "
            "removals, project settings, key replacements) are written to the company's audit trail with who and when, never with content.",
            "Reading prompt or answer text is not logged one view at a time.",
        ]),
        NoticeSection(heading="Your acknowledgment", body=[
            "If you acknowledge this notice we record which version you were shown and when. That is a record that it was shown to you. "
            "It is not your consent, and it is not a statement that any law or contract is met. Your company decides why it uses this data, "
            "so ask them if you have questions.",
        ]),
        NoticeSection(heading="If you leave", body=[
            "Your access ends at once and your job role is cleared. The company keeps its projects and the calls recorded in them. "
            "The record that you acknowledged a notice is kept with the company's records, and removed if you delete your account.",
        ]),
    ]


async def _acknowledged(session: AsyncSession, org_id: uuid.UUID, user_id: uuid.UUID):
    return (await session.execute(select(OrgNoticeAck).where(
        OrgNoticeAck.org_id == org_id, OrgNoticeAck.user_id == user_id, OrgNoticeAck.version == NOTICE_VERSION))).scalar_one_or_none()


@router.get("/v1/organisations/{org_id}/notice", response_model=CompanyNoticeOut)
async def get_notice(org_id: uuid.UUID, user: User = Depends(current_user), session: AsyncSession = Depends(get_session)) -> CompanyNoticeOut:
    """The company's privacy notice as it applies to you, whether you have acknowledged this version, and (for admins) how many have."""
    role = await _require_role(session, user, org_id, "notice.view")
    ack = await _acknowledged(session, org_id, user.user_id)
    counts = None
    if role_can(role, "notice.view_status"):
        members = (await session.execute(select(func.count()).select_from(Membership).where(
            Membership.org_id == org_id, Membership.status == "active"))).scalar_one()
        done = (await session.execute(select(func.count()).select_from(OrgNoticeAck).join(
            Membership, (Membership.org_id == OrgNoticeAck.org_id) & (Membership.user_id == OrgNoticeAck.user_id)).where(
            OrgNoticeAck.org_id == org_id, OrgNoticeAck.version == NOTICE_VERSION, Membership.status == "active"))).scalar_one()
        counts = {"acknowledged": done, "members": members}
    return CompanyNoticeOut(version=NOTICE_VERSION, sections=notice_sections(), min_group_size=MIN_GROUP,
                     acknowledged=ack is not None, acknowledged_at=ack.acknowledged_at if ack else None,
                     required_for_access=False, status_counts=counts)


@router.post("/v1/organisations/{org_id}/notice/ack", response_model=CompanyNoticeOut)
async def acknowledge_notice(org_id: uuid.UUID, body: NoticeAck, user: User = Depends(current_user),
                             session: AsyncSession = Depends(get_session)) -> CompanyNoticeOut:
    """Record that you were shown this version. Only for yourself, only for the current version. Access does not depend on it."""
    await _require_role(session, user, org_id, "notice.acknowledge")
    if body.version != NOTICE_VERSION:
        raise HTTPException(409, "The notice has a newer version. Read it and acknowledge that one.")
    if await _acknowledged(session, org_id, user.user_id) is None:
        session.add(OrgNoticeAck(org_id=org_id, user_id=user.user_id, version=NOTICE_VERSION))
        session.add(OrgEvent(org_id=org_id, actor_user_id=user.user_id, action="notice_acknowledged",
                             detail={"version": NOTICE_VERSION}))
        await session.commit()
    return await get_notice(org_id, user, session)


@router.get("/v1/organisations/{org_id}/me", response_model=YouInCompany)
async def me_in_company(org_id: uuid.UUID, user: User = Depends(current_user), session: AsyncSession = Depends(get_session)) -> YouInCompany:
    """Your own role, job role and notice state in this company. Nobody else's."""
    role = await _require_role(session, user, org_id, "notice.view")
    m = await session.get(Membership, (org_id, user.user_id))
    return YouInCompany(role=role, job_role=m.job_role, job_roles=JOB_ROLES,
                        notice_version=NOTICE_VERSION, notice_acknowledged=await _acknowledged(session, org_id, user.user_id) is not None)


@router.put("/v1/organisations/{org_id}/me/job-role", response_model=YouInCompany)
async def set_job_role(org_id: uuid.UUID, body: JobRolePut, user: User = Depends(current_user),
                       session: AsyncSession = Depends(get_session)) -> YouInCompany:
    """Say what kind of work you do, or clear it (null). Always your own: nothing in the request can name someone else."""
    await _require_role(session, user, org_id, "profile.edit_own")
    m = await session.get(Membership, (org_id, user.user_id))
    m.job_role = body.job_role
    await session.commit()
    return await me_in_company(org_id, user, session)


@router.get("/v1/organisations/{org_id}/rollups", response_model=RollupOut)
async def rollups(org_id: uuid.UUID, user: User = Depends(current_user), session: AsyncSession = Depends(get_session)) -> RollupOut:
    """How many members declared each job role, for groups of MIN_GROUP or more only. No names, no spend, no usage."""
    await _require_role(session, user, org_id, "rollups.view")
    rows = (await session.execute(select(Membership.job_role, func.count()).where(
        Membership.org_id == org_id, Membership.status == "active").group_by(Membership.job_role))).all()
    members = sum(int(n) for _, n in rows)
    declared = sum(int(n) for r, n in rows if r is not None)
    if members < MIN_GROUP:
        return RollupOut(min_group_size=MIN_GROUP, members=members, shown=False, groups=[], not_shown=members,
                         reason=f"A breakdown appears once the company has at least {MIN_GROUP} members, so that no one can be picked out. "
                                f"{MIN_GROUP} is our own design choice, not a standard.",
                         usage_by_role=None, usage_by_role_note=_USAGE_NOTE)
    groups = sorted(((r, int(n)) for r, n in rows if r is not None and int(n) >= MIN_GROUP), key=lambda g: (-g[1], g[0]))
    shown_total = sum(n for _, n in groups)
    return RollupOut(
        min_group_size=MIN_GROUP, members=members, shown=bool(groups),
        groups=[RollupGroup(job_role=r, label=JOB_ROLES[r], members=n) for r, n in groups],
        not_shown=members - shown_total,
        reason=(f"Groups smaller than {MIN_GROUP} are not shown, and neither are members who chose no role. "
                f"{MIN_GROUP} is our own design choice, not a standard.") + (
                    "" if groups else " No role has that many members yet."),
        declared_share=round(declared / members, 3) if members else None,
        usage_by_role=None, usage_by_role_note=_USAGE_NOTE)


_USAGE_NOTE = ("Usage or cost by role is not available. It would need each AI call attributed to a person, which this product does not "
               "collect, and showing a person's spend to administrators is blocked until the owner approves it after legal review.")

