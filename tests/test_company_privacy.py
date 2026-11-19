"""The company privacy notice and its acknowledgment, the self-declared job role, small-group suppression, and the limits
on attribution. Real Postgres, made-up data, no external connection.

Nothing here is a legal-compliance claim, and member-level spend for admins is deliberately not built."""

import json
import re
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from sqlalchemy import text

from agent_memory.auth import privacy
from agent_memory.auth.privacy import MIN_GROUP, NOTICE_VERSION, notice_sections
from agent_memory.models import Job, Run


@pytest.fixture
def dev_login(monkeypatch):
    monkeypatch.setenv("DEV_LOGIN", "true")

    async def sign_in(client, email):
        await client.post("/auth/logout")
        assert (await client.post("/auth/dev/login", json={"email": email})).status_code == 200

    return sign_in


async def _company(client, dev_login, members=()):
    """An owner, a company, and members given as (email, role)."""
    await dev_login(client, "owner@example.com")
    org = (await client.post("/v1/organisations", json={"name": "Acme"})).json()["org_id"]
    ids = {}
    for email, role in members:
        await dev_login(client, "owner@example.com")
        token = (await client.post(f"/v1/organisations/{org}/invites", json={"email": email, "role": role})).json()["token"]
        await dev_login(client, email)
        assert (await client.post("/v1/invites/accept", json={"token": token})).status_code == 200
        ids[email] = (await client.get("/v1/me")).json()["user_id"]
    return org, ids


def _six(n_roles):
    return [(f"m{i}@example.com", "member") for i in range(n_roles)]


async def _declare(client, dev_login, org, email, role):
    await dev_login(client, email)
    r = await client.put(f"/v1/organisations/{org}/me/job-role", json={"job_role": role})
    assert r.status_code == 200, r.text


# ---- the notice ---------------------------------------------------------------------------------------------------

async def test_every_member_can_read_the_notice_and_outsiders_cannot(client, dev_login):
    org, _ = await _company(client, dev_login, [("viewer@example.com", "viewer"), ("member@example.com", "member")])
    for who in ("owner", "viewer", "member"):
        await dev_login(client, f"{who}@example.com")
        r = await client.get(f"/v1/organisations/{org}/notice")
        assert r.status_code == 200 and r.json()["version"] == NOTICE_VERSION and len(r.json()["sections"]) >= 6
        assert r.json()["required_for_access"] is False and r.json()["min_group_size"] == MIN_GROUP
    await dev_login(client, "stranger@example.com")
    assert (await client.get(f"/v1/organisations/{org}/notice")).status_code == 404
    assert (await client.post(f"/v1/organisations/{org}/notice/ack", json={"version": NOTICE_VERSION})).status_code == 404
    await client.post("/auth/logout")
    assert (await client.get(f"/v1/organisations/{org}/notice")).status_code == 401


def test_the_notice_says_what_it_must_and_makes_no_legal_claim():
    body = " ".join(" ".join([s.heading, *s.body]) for s in notice_sections())
    low = body.lower()
    for must in ("what the account records", "what it does not record", "who can see what", "optional job role",
                 "how access is checked", "your acknowledgment", "if you leave"):
        assert must in low, must
    assert "default 90 days" in low and "design choice" in low and "not your consent" in low
    assert "no individual employee identity" in low and "not suitable for charging" in low
    assert "viewers do not see text" in low
    assert not re.search(r"complian|gdpr|ccpa|hipaa|certified|legally|guarantee|we comply", low)  # no compliance claim


async def test_the_notice_matches_what_the_server_enforces(client, dev_login):
    """The sentence about who reads prompt text comes from the permission table, so it cannot drift."""
    from agent_memory.auth.permissions import matrix
    content_roles = next(r["roles"] for r in matrix()["project"] if r["permission"] == "content.view")
    sentence = next(b for s in notice_sections() for b in s.body if b.startswith("Prompt and answer text of those projects"))
    assert ", ".join(content_roles) in sentence and "viewer" not in ", ".join(content_roles)
    # and the retention default it quotes is the real default
    org, _ = await _company(client, dev_login)
    made = (await client.post("/v1/projects", json={"name": "P", "organisation_id": org})).json()["project"]
    assert made["content_retention_days"] == privacy.DEFAULT_RETENTION_DAYS


async def test_acknowledging_records_the_version_once_and_never_gates_access(client, dev_login, session):
    org, ids = await _company(client, dev_login, [("member@example.com", "member")])
    await dev_login(client, "member@example.com")
    before = (await client.get(f"/v1/organisations/{org}/notice")).json()
    assert before["acknowledged"] is False and before["acknowledged_at"] is None and before["status_counts"] is None
    assert (await client.get("/v1/workspaces")).status_code == 200  # no acknowledgment needed to use the product
    assert (await client.get(f"/v1/organisations/{org}/members")).status_code == 200
    r = await client.post(f"/v1/organisations/{org}/notice/ack", json={"version": NOTICE_VERSION})
    assert r.status_code == 200 and r.json()["acknowledged"] is True and r.json()["acknowledged_at"]
    again = await client.post(f"/v1/organisations/{org}/notice/ack", json={"version": NOTICE_VERSION})
    assert again.status_code == 200
    rows = (await session.execute(text("SELECT user_id, version FROM org_notice_acks"))).all()
    assert len(rows) == 1 and str(rows[0].user_id) == ids["member@example.com"] and rows[0].version == NOTICE_VERSION
    assert (await client.post(f"/v1/organisations/{org}/notice/ack", json={"version": "company-notice-0"})).status_code == 409


async def test_a_new_notice_version_asks_again_and_old_acks_do_not_carry_over(client, dev_login, monkeypatch):
    org, _ = await _company(client, dev_login, [("member@example.com", "member")])
    await client.post(f"/v1/organisations/{org}/notice/ack", json={"version": NOTICE_VERSION})
    assert (await client.get(f"/v1/organisations/{org}/notice")).json()["acknowledged"] is True
    monkeypatch.setattr(privacy, "NOTICE_VERSION", "company-notice-2")
    now = (await client.get(f"/v1/organisations/{org}/notice")).json()
    assert now["version"] == "company-notice-2" and now["acknowledged"] is False
    assert (await client.post(f"/v1/organisations/{org}/notice/ack", json={"version": NOTICE_VERSION})).status_code == 409


async def test_admins_see_acknowledgment_counts_not_names_and_each_company_keeps_its_own(client, dev_login):
    org, _ = await _company(client, dev_login, [("a@example.com", "member"), ("b@example.com", "member")])
    await dev_login(client, "a@example.com")
    await client.post(f"/v1/organisations/{org}/notice/ack", json={"version": NOTICE_VERSION})
    await dev_login(client, "owner@example.com")
    got = (await client.get(f"/v1/organisations/{org}/notice")).json()
    assert got["status_counts"] == {"acknowledged": 1, "members": 3}
    assert "a@example.com" not in json.dumps(got) and "b@example.com" not in json.dumps(got)
    # a second company starts with nothing acknowledged, even for the same person
    await dev_login(client, "a@example.com")
    other = (await client.post("/v1/organisations", json={"name": "Other"})).json()["org_id"]
    assert (await client.get(f"/v1/organisations/{other}/notice")).json()["acknowledged"] is False


async def test_acknowledgments_go_with_a_deleted_account_and_the_audit_line_holds_only_the_version(client, dev_login, session):
    org, _ = await _company(client, dev_login, [("gone@example.com", "member")])
    await client.post(f"/v1/organisations/{org}/notice/ack", json={"version": NOTICE_VERSION})
    await dev_login(client, "owner@example.com")
    events = (await client.get(f"/v1/organisations/{org}/events")).json()
    line = next(e for e in events if e["action"] == "notice_acknowledged")
    assert line["detail"] == {"version": NOTICE_VERSION}
    await dev_login(client, "gone@example.com")
    assert (await client.delete("/v1/me?confirm=gone@example.com")).status_code == 204
    assert (await session.execute(text("SELECT count(*) FROM org_notice_acks"))).scalar_one() == 0


# ---- the optional self-declared job role --------------------------------------------------------------------------

async def test_a_job_role_is_the_persons_own_choice_from_a_fixed_list(client, dev_login):
    org, _ = await _company(client, dev_login, [("m@example.com", "member")])
    await dev_login(client, "m@example.com")
    mine = (await client.get(f"/v1/organisations/{org}/me")).json()
    assert mine["job_role"] is None and "engineering" in mine["job_roles"]  # never guessed from the address
    assert (await client.put(f"/v1/organisations/{org}/me/job-role", json={"job_role": "finance"})).json()["job_role"] == "finance"
    assert (await client.put(f"/v1/organisations/{org}/me/job-role", json={"job_role": "CEO and founder"})).status_code == 422
    assert (await client.put(f"/v1/organisations/{org}/me/job-role", json={"job_role": None})).json()["job_role"] is None
    await dev_login(client, "stranger@example.com")
    assert (await client.put(f"/v1/organisations/{org}/me/job-role", json={"job_role": "other"})).status_code == 404


async def test_nobody_can_set_or_read_someone_elses_job_role_and_spoofed_ids_change_nothing(client, dev_login):
    org, ids = await _company(client, dev_login, [("victim@example.com", "member"), ("admin@example.com", "admin")])
    await _declare(client, dev_login, org, "victim@example.com", "legal")
    await dev_login(client, "admin@example.com")
    victim = ids["victim@example.com"]
    spoof = {"X-User-Id": victim, "X-Member-Id": victim, "X-Forwarded-User": "victim@example.com"}
    r = await client.put(f"/v1/organisations/{org}/me/job-role?user_id={victim}&member={victim}",
                         json={"job_role": "engineering", "user_id": victim, "member_id": victim}, headers=spoof)
    assert r.status_code in (200, 422)
    admin_view = (await client.get(f"/v1/organisations/{org}/me", headers=spoof)).json()
    assert admin_view["role"] == "admin" and admin_view["job_role"] in (None, "engineering")  # always the caller's own row
    await dev_login(client, "victim@example.com")
    assert (await client.get(f"/v1/organisations/{org}/me")).json()["job_role"] == "legal"  # untouched
    # No route puts a job role next to a name, for anyone.
    await dev_login(client, "admin@example.com")
    blob = json.dumps((await client.get(f"/v1/organisations/{org}/members")).json())
    assert "job_role" not in blob and "legal" not in blob
    for path in (f"/v1/organisations/{org}/overview", f"/v1/organisations/{org}/rollups"):
        assert "victim@example.com" not in (await client.get(path)).text
    assert "legal" not in (await client.get(f"/v1/organisations/{org}/events")).text  # the audit trail never holds job roles


async def test_a_job_role_gives_and_takes_away_no_access(client, dev_login):
    org, _ = await _company(client, dev_login, [("v@example.com", "viewer"), ("a@example.com", "admin")])
    await dev_login(client, "owner@example.com")
    pid = (await client.post("/v1/projects", json={"name": "P", "organisation_id": org})).json()["project"]["project_id"]
    for who, role in (("v@example.com", "finance"), ("a@example.com", "legal")):
        await _declare(client, dev_login, org, who, role)
    await dev_login(client, "v@example.com")
    assert (await client.post("/v1/jobs", json={"name": "x", "check_kind": "LATE_LABEL"}, headers={"X-Project-Id": pid})).status_code == 403
    assert (await client.get(f"/v1/projects/{pid}")).status_code == 403
    await dev_login(client, "a@example.com")
    assert (await client.get(f"/v1/projects/{pid}")).status_code == 200
    assert (await client.get(f"/v1/organisations/{org}/rollups")).status_code == 200


async def test_leaving_clears_the_job_role_and_rejoining_starts_blank(client, dev_login, session):
    org, ids = await _company(client, dev_login, [("m@example.com", "member")])
    await _declare(client, dev_login, org, "m@example.com", "support")
    await client.post(f"/v1/organisations/{org}/leave")
    assert (await session.execute(text("SELECT job_role FROM memberships WHERE user_id = :u"), {"u": ids["m@example.com"]})).scalar_one() is None
    await dev_login(client, "owner@example.com")
    token = (await client.post(f"/v1/organisations/{org}/invites", json={"email": "m@example.com"})).json()["token"]
    await dev_login(client, "m@example.com")
    await client.post("/v1/invites/accept", json={"token": token})
    assert (await client.get(f"/v1/organisations/{org}/me")).json()["job_role"] is None


def test_the_job_role_is_never_used_outside_its_own_code():
    """A leftover reference could turn it into an access, budget or ranking input."""
    root = Path(__file__).resolve().parents[1] / "src" / "agent_memory"
    allowed = {"models.py", "privacy.py", "orgs.py", "schemas.py"}
    bad = [str(p.relative_to(root)) for p in root.rglob("*.py") if "job_role" in p.read_text(encoding="utf8") and p.name not in allowed]
    assert not bad, bad
    access_code = (root / "auth" / "access.py").read_text(encoding="utf8") + (root / "auth" / "permissions.py").read_text(encoding="utf8")
    assert "job_role" not in access_code


# ---- the rollup and its threshold --------------------------------------------------------------------------------

async def test_a_company_under_five_members_gets_no_breakdown_and_an_honest_reason(client, dev_login):
    org, _ = await _company(client, dev_login, _six(3))  # four people in all
    for i in range(3):
        await _declare(client, dev_login, org, f"m{i}@example.com", "engineering")
    await dev_login(client, "owner@example.com")
    r = (await client.get(f"/v1/organisations/{org}/rollups")).json()
    assert r["members"] == 4 and r["shown"] is False and r["groups"] == [] and r["not_shown"] == 4
    assert str(MIN_GROUP) in r["reason"] and "design choice" in r["reason"] and "engineering" not in json.dumps(r).lower()


async def test_only_groups_of_five_or_more_are_shown_and_small_ones_hide_inside_not_shown(client, dev_login):
    org, _ = await _company(client, dev_login, _six(7))  # owner + 7 members = 8
    for i in range(5):
        await _declare(client, dev_login, org, f"m{i}@example.com", "engineering")
    await _declare(client, dev_login, org, "m5@example.com", "finance")
    await _declare(client, dev_login, org, "m6@example.com", "legal")
    await dev_login(client, "owner@example.com")
    r = (await client.get(f"/v1/organisations/{org}/rollups")).json()
    assert r["shown"] is True and [(g["job_role"], g["members"]) for g in r["groups"]] == [("engineering", 5)]
    assert r["not_shown"] == 3 and r["members"] == 8
    blob = json.dumps(r).lower()
    assert '"finance"' not in blob and '"legal"' not in blob and "Finance" not in json.dumps(r)  # small groups are not named
    assert r["usage_by_role"] is None and "not available" in r["usage_by_role_note"]
    assert "@" not in blob and "m5" not in blob


async def test_four_of_one_role_is_hidden_even_when_the_company_is_large(client, dev_login):
    org, _ = await _company(client, dev_login, _six(9))
    for i in range(4):
        await _declare(client, dev_login, org, f"m{i}@example.com", "product")
    await dev_login(client, "owner@example.com")
    r = (await client.get(f"/v1/organisations/{org}/rollups")).json()
    assert r["groups"] == [] and r["shown"] is False and r["not_shown"] == 10 and "No role has that many" in r["reason"]


async def test_a_group_disappears_again_when_members_leave_and_it_drops_below_five(client, dev_login):
    org, _ = await _company(client, dev_login, _six(6))
    for i in range(5):
        await _declare(client, dev_login, org, f"m{i}@example.com", "support")
    await dev_login(client, "owner@example.com")
    assert [g["members"] for g in (await client.get(f"/v1/organisations/{org}/rollups")).json()["groups"]] == [5]
    await dev_login(client, "m0@example.com")
    await client.post(f"/v1/organisations/{org}/leave")
    await dev_login(client, "owner@example.com")
    r = (await client.get(f"/v1/organisations/{org}/rollups")).json()
    assert r["groups"] == [] and r["members"] == 6


async def test_the_rollup_is_for_admins_and_stays_inside_its_company(client, dev_login):
    org, _ = await _company(client, dev_login, _six(5) + [("viewer@example.com", "viewer"), ("admin@example.com", "admin")])
    for i in range(5):
        await _declare(client, dev_login, org, f"m{i}@example.com", "operations")
    for who in ("m0@example.com", "viewer@example.com"):
        await dev_login(client, who)
        assert (await client.get(f"/v1/organisations/{org}/rollups")).status_code == 403
    await dev_login(client, "admin@example.com")
    assert (await client.get(f"/v1/organisations/{org}/rollups")).json()["groups"][0]["members"] == 5
    await dev_login(client, "rival@example.com")  # another company sees none of it
    other = (await client.post("/v1/organisations", json={"name": "Rival"})).json()["org_id"]
    assert (await client.get(f"/v1/organisations/{org}/rollups")).status_code == 404
    assert (await client.get(f"/v1/organisations/{other}/rollups")).json()["members"] == 1


# ---- caller-supplied IDs are labels, not identities --------------------------------------------------------------

async def test_a_caller_supplied_member_label_is_never_presented_as_an_identity(client, dev_login, session):
    org, _ = await _company(client, dev_login, [("alice@example.com", "member")])
    await dev_login(client, "owner@example.com")
    created = (await client.post("/v1/projects", json={"name": "P", "organisation_id": org})).json()
    pid = created["project"]["project_id"]
    job = Job(project_id=pid, name="t", check_kind="ANSWER_KEY", check_config={"fields": ["t"]})
    session.add(job)
    await session.flush()
    for i, label in enumerate(["alice@example.com", "alice@example.com", "bob", "SPOOFED-ADMIN", None] * 3):
        session.add(Run(run_id=uuid.uuid4(), job_id=job.job_id, project_id=pid, prompt="p", prompt_hash="h", model="mini",
                        model_version="mini-1", tokens_in=100, cost_usd=0.01, outcome="PASS", state="INDEXED", agent=label,
                        created_at=datetime.now(UTC) - timedelta(minutes=i)))
    await session.commit()
    plain = (await client.get(f"/v1/organisations/{org}/overview")).json()
    spoofed = (await client.get(f"/v1/organisations/{org}/overview?member=alice@example.com&user_id=1&agent=SPOOFED-ADMIN",
                                headers={"X-Member-Id": "alice@example.com", "X-User-Id": "1"})).json()
    assert plain == {**spoofed, "since": plain["since"], "until": plain["until"]} or plain["totals"] == spoofed["totals"]
    blob = json.dumps(plain)
    assert "alice@example.com" not in blob and "SPOOFED-ADMIN" not in blob and "bob" not in blob  # labels are not shown or grouped by
    agent = next(a for a in plain["attribution"] if a["dimension"] == "agent")
    assert agent["source"] == "caller_supplied" and "not a verified identity" in agent["detail"].lower()
    assert next(a for a in plain["attribution"] if a["dimension"] == "person")["source"] == "not_recorded"
    assert plain["chargeback_grade"] is False and plain["totals"]["calls"] == 15


async def test_no_route_offers_spend_or_usage_for_one_member(client, dev_login):
    """Member-level spend for admins is blocked pending legal review and the owner's approval: nothing of the kind exists."""
    from agent_memory.api import app
    paths = []
    for r in app.routes:
        inner = getattr(r, "original_router", None)
        paths += [x.path for x in (inner.routes if inner else [r]) if hasattr(x, "path")]
    bad = [p for p in paths if re.search(r"member.*(spend|cost|usage)|(spend|cost|usage).*(member|person|user|employee)|leaderboard|ranking", p, re.I)]
    assert not bad, bad
    org, _ = await _company(client, dev_login, [("m@example.com", "member")])
    blob = json.dumps((await client.get(f"/v1/organisations/{org}/overview")).json()).lower()
    for word in ("per_member", "member_spend", "employee", "leaderboard", "rank", "score", "productivity"):
        assert word not in blob, word


async def test_company_privacy_does_not_cross_into_personal_or_other_company_projects(client, dev_login, session):
    org, _ = await _company(client, dev_login, [("m@example.com", "member")])
    await dev_login(client, "m@example.com")
    personal = (await client.post("/v1/projects", json={"name": "Mine"})).json()["project"]["project_id"]
    await dev_login(client, "owner@example.com")
    assert (await client.get("/v1/jobs", headers={"X-Project-Id": personal})).status_code == 404  # a personal project stays private
    other = (await client.post("/v1/organisations", json={"name": "Other"})).json()["org_id"]
    await dev_login(client, "m@example.com")
    assert (await client.get(f"/v1/organisations/{other}/notice")).status_code == 404
    over = (await client.get(f"/v1/organisations/{org}/overview")).json()
    assert personal not in json.dumps(over) and "Mine" not in json.dumps(over)
