"""Least-privilege authorization: the permission table, every role on every kind of action, cross-company walls,
role changes taking effect at once, revoked keys and sessions, and no secrets for roles that must not see them.

Real Postgres, made-up emails, no external connection."""

import re
import uuid
from pathlib import Path

import httpx
import pytest
from sqlalchemy import select, text

from agent_memory.api import app
from agent_memory.auth.permissions import (
    DEMO_PERMISSIONS, KEY_PERMISSIONS, ORG_PERMISSIONS, PROJECT_PERMISSIONS, ROLES, ROUTE_PERMISSIONS, matrix, required_permission,
    role_can,
)
from agent_memory.models import Job, Run

ALL = {**PROJECT_PERMISSIONS, **ORG_PERMISSIONS}


# ---- the table itself -------------------------------------------------------------------------------------------

def test_a_higher_role_has_everything_a_lower_one_has_and_nothing_is_implied_upward():
    for perm in ALL:
        has = [role_can(r, perm) for r in ROLES]
        assert has == sorted(has), perm  # False...False True...True: never a gap
        assert has[-1] is True, perm  # an owner can do everything
    assert not role_can("member", "settings.view") and not role_can("member", "keys.rotate")
    assert not role_can("admin", "company.delete") and not role_can("admin", "roles.grant_admin")
    assert not role_can("viewer", "content.view") and not role_can("viewer", "data.write")


def test_unknown_roles_and_permissions_are_denied():
    assert not role_can(None, "metrics.view") and not role_can("root", "metrics.view") and not role_can("owner", "nothing.here")
    assert not role_can("owner", "") and not role_can("", "metrics.view")


def test_a_project_key_and_the_demo_never_get_people_powers():
    people_only = {"settings.view", "settings.change", "billing.change", "keys.rotate", "project.create", "project.delete", "export.run"}
    assert not (KEY_PERMISSIONS & people_only) and not (DEMO_PERMISSIONS & people_only)
    assert not (set(ORG_PERMISSIONS) & (KEY_PERMISSIONS | DEMO_PERMISSIONS))
    assert DEMO_PERMISSIONS <= KEY_PERMISSIONS | {"content.view"} and "data.write" not in DEMO_PERMISSIONS


def test_unlisted_writes_need_data_write_never_less():
    assert required_permission("POST", "/v1/brand/new") == "data.write"
    assert required_permission("DELETE", None) == "data.write"
    assert required_permission("GET", "/v1/whatever") == "metrics.view"
    assert all(p in PROJECT_PERMISSIONS for p in ROUTE_PERMISSIONS.values())


def test_no_export_route_exists_without_an_entry_in_the_table():
    paths = []
    for r in app.routes:
        inner = getattr(r, "original_router", None)
        paths += [x.path for x in (inner.routes if inner else [r]) if hasattr(x, "path")]
    exports = {p for p in paths if re.search(r"export|download|csv", p, re.I)}
    # every export route is known by name; a project export needs export.run, the company one overview.export. A new one fails here.
    assert exports == {"/v1/insights/export.csv", "/v1/insights/features/export.csv", "/v1/insights/planner/export.csv",
                       "/v1/organisations/{org_id}/overview/export.csv"}, exports
    assert ROUTE_PERMISSIONS[("GET", "/v1/insights/export.csv")] == "export.run" and "overview.export" in ORG_PERMISSIONS
    assert ROUTE_PERMISSIONS[("GET", "/v1/insights/features/export.csv")] == "export.run"
    assert ROUTE_PERMISSIONS[("GET", "/v1/insights/planner/export.csv")] == "export.run"


def test_the_matrix_lists_every_permission_for_both_scopes():
    m = matrix()
    assert m["roles"] == list(ROLES)
    assert {r["permission"] for r in m["project"]} == set(PROJECT_PERMISSIONS)
    assert {r["permission"] for r in m["company"]} == set(ORG_PERMISSIONS)
    for row in m["project"] + m["company"]:
        assert row["roles"][-1] == "owner" and row["means"]


def test_only_the_access_modules_decide_who_owns_what():
    """A leftover owner shortcut would skip the role check. Allowed: the access layer, company code, project setup,
    the account-deletion helper and the ORM/migrations."""
    allowed = {"models.py", "projects.py", "access.py", "routes.py", "orgs.py"}
    root = Path(__file__).resolve().parents[1] / "src" / "agent_memory"
    bad = [str(p.relative_to(root)) for p in root.rglob("*.py") if "owner_user_id" in p.read_text(encoding="utf8") and p.name not in allowed]
    assert not bad, bad


# ---- a company with every role, and an outsider ------------------------------------------------------------------

@pytest.fixture
def dev_login(monkeypatch):
    monkeypatch.setenv("DEV_LOGIN", "true")

    async def sign_in(client, email):
        await client.post("/auth/logout")
        assert (await client.post("/auth/dev/login", json={"email": email})).status_code == 200

    return sign_in


async def _join(client, dev_login, org, email, role):
    await dev_login(client, "owner@example.com")
    token = (await client.post(f"/v1/organisations/{org}/invites", json={"email": email, "role": role})).json()["token"]
    await dev_login(client, email)
    assert (await client.post("/v1/invites/accept", json={"token": token})).status_code == 200
    return (await client.get("/v1/me")).json()["user_id"]


@pytest.fixture
async def world(client, dev_login, session):
    await dev_login(client, "owner@example.com")
    org = (await client.post("/v1/organisations", json={"name": "Acme"})).json()["org_id"]
    created = (await client.post("/v1/projects", json={"name": "Shared", "organisation_id": org})).json()
    pid, key = created["project"]["project_id"], created["api_key"]
    job = Job(project_id=pid, name="invoice", check_kind="ANSWER_KEY", check_config={"fields": ["t"]})
    session.add(job)
    await session.flush()
    run = Run(run_id=uuid.uuid4(), job_id=job.job_id, project_id=pid, prompt="SECRET PROMPT TEXT", output="SECRET ANSWER TEXT",
              prompt_hash="h", model="mini", model_version="mini-2026-09", tokens_in=10, outcome="PASS", cost_usd=0.001,
              state="INDEXED", tool_calls=[{"name": "t", "id": "c1"}])
    session.add(run)
    await session.commit()
    ids = {"owner": (await client.get("/v1/me")).json()["user_id"]}
    for role in ("admin", "member", "viewer"):
        ids[role] = await _join(client, dev_login, org, f"{role}@example.com", role)
    # a second, unrelated company with its own owner and project
    await dev_login(client, "rival@example.com")
    org_b = (await client.post("/v1/organisations", json={"name": "Rival"})).json()["org_id"]
    pb = (await client.post("/v1/projects", json={"name": "Theirs", "organisation_id": org_b})).json()["project"]["project_id"]
    return {"org": org, "pid": pid, "key": key, "run": str(run.run_id), "ids": ids, "org_b": org_b, "pb": pb}


def H(w):
    return {"X-Project-Id": w["pid"]}


# ---- metrics and content ------------------------------------------------------------------------------------------

async def test_every_role_sees_metrics_and_a_stranger_sees_nothing(client, dev_login, world):
    for who in ("owner", "admin", "member", "viewer"):
        await dev_login(client, f"{who}@example.com")
        r = await client.get("/v1/jobs", headers=H(world))
        assert r.status_code == 200 and [j["name"] for j in r.json()] == ["invoice"], who
        assert (await client.get("/v1/insights/spend", headers=H(world))).status_code == 200
    await dev_login(client, "stranger@example.com")
    assert (await client.get("/v1/jobs", headers=H(world))).status_code == 404


async def test_prompt_and_answer_text_is_for_members_and_above_never_for_viewers(client, dev_login, world):
    for who, sees in (("owner", True), ("admin", True), ("member", True), ("viewer", False)):
        await dev_login(client, f"{who}@example.com")
        listing = (await client.get("/v1/runs", headers=H(world))).json()["items"][0]
        detail = (await client.get(f"/v1/runs/{world['run']}", headers=H(world))).json()
        blob = str(listing) + str(detail)
        assert ("SECRET PROMPT TEXT" in blob) is sees and ("SECRET ANSWER TEXT" in blob) is sees, who
        if not sees:
            assert detail["prompt"] is None and detail["output"] is None and detail["tool_calls"] is None
            assert listing["prompt_preview"] is None and listing["output_preview"] is None
            assert detail["cost_usd"] == 0.001  # the numbers stay
        text_off = (await client.get("/v1/insights/prompts?show_text=true", headers=H(world)))
        assert text_off.status_code == 200 and (sees or "SECRET" not in text_off.text)
    r = await client.get(f"/v1/runs/{world['run']}", headers={"X-API-Key": world["key"]})  # a project key reads content
    assert r.json()["prompt"] == "SECRET PROMPT TEXT"


# ---- what each role may do ---------------------------------------------------------------------------------------

async def _codes(client, dev_login, world, method, url, body=None, headers=None):
    out = {}
    for who in ("viewer", "member", "admin", "owner"):
        await dev_login(client, f"{who}@example.com")
        r = await client.request(method, url, json=body if body is not None else {}, headers=headers if headers is not None else H(world))
        out[who] = r.status_code
    return out


async def test_data_writes_need_member(client, dev_login, world):
    codes = await _codes(client, dev_login, world, "POST", "/v1/jobs", {"name": "x1", "check_kind": "LATE_LABEL"})
    assert codes["viewer"] == 403 and codes["member"] == 201 or codes["member"] == 409  # 409 once created by another role
    assert codes["viewer"] == 403


async def test_retests_limits_and_the_provider_key_need_admin(client, dev_login, world):
    for method, url in (("POST", "/v1/jobs/invoice/retest"), ("POST", "/v1/limits"), ("PUT", "/v1/provider-key"),
                        ("DELETE", "/v1/provider-key")):
        codes = await _codes(client, dev_login, world, method, url)
        assert codes["viewer"] == codes["member"] == 403, (method, url, codes)
        assert codes["admin"] != 403 and codes["owner"] != 403, (method, url, codes)


async def test_settings_billing_keys_and_deletion_need_admin_and_do_not_leak(client, dev_login, world):
    pid = world["pid"]
    for who in ("viewer", "member"):
        await dev_login(client, f"{who}@example.com")
        assert (await client.get(f"/v1/projects/{pid}")).status_code == 403
        assert (await client.patch(f"/v1/projects/{pid}", json={"billing_mode": "subscription"})).status_code == 403
        assert (await client.post(f"/v1/projects/{pid}/key")).status_code == 403
        assert (await client.delete(f"/v1/projects/{pid}?confirm={pid}")).status_code == 403
        assert (await client.post("/v1/projects", json={"name": "nope", "organisation_id": world["org"]})).status_code == 403
    await dev_login(client, "admin@example.com")
    hook = await client.patch(f"/v1/projects/{pid}", json={"webhook_url": "https://hooks.example/abc"})
    assert hook.status_code == 200 and hook.json()["webhook_secret"].startswith("whsec_")
    assert (await client.patch(f"/v1/projects/{pid}", json={"billing_mode": "subscription"})).json()["billing_mode"] == "subscription"
    # roles below admin see the project in the list, with the figures dashboards need, but no secrets
    for who in ("viewer", "member"):
        await dev_login(client, f"{who}@example.com")
        [p] = (await client.get(f"/v1/projects?workspace={world['org']}")).json()
        assert p["billing_mode"] == "subscription" and p["role"] == who
        assert p["webhook_url"] is None and p["webhook_secret"] is None and p["key_prefix"] is None
        assert "whsec_" not in str(p) and "mcm_live_" not in str(p) and "hooks.example" not in str(p)
    await dev_login(client, "admin@example.com")
    [p] = (await client.get(f"/v1/projects?workspace={world['org']}")).json()
    assert p["webhook_secret"].startswith("whsec_") and p["key_prefix"] and p["role"] == "admin"


async def test_replacing_a_key_kills_the_old_one_at_once(client, dev_login, world):
    key = world["key"]
    assert (await client.get("/v1/jobs", headers={"X-API-Key": key})).status_code == 200
    await dev_login(client, "admin@example.com")
    new = (await client.post(f"/v1/projects/{world['pid']}/key")).json()["api_key"]
    await client.post("/auth/logout")
    assert (await client.get("/v1/jobs", headers={"X-API-Key": key})).status_code == 401
    assert (await client.get("/v1/jobs", headers={"X-API-Key": new})).status_code == 200


async def test_a_project_key_cannot_do_what_only_people_can(client, world):
    await client.post("/auth/logout")  # the key alone, with no signed-in person
    key = {"X-API-Key": world["key"]}
    pid = world["pid"]
    for method, url in (("GET", f"/v1/projects/{pid}"), ("PATCH", f"/v1/projects/{pid}"), ("POST", f"/v1/projects/{pid}/key"),
                        ("DELETE", f"/v1/projects/{pid}?confirm={pid}"), ("GET", "/v1/workspaces"),
                        ("GET", f"/v1/organisations/{world['org']}/members"), ("POST", f"/v1/organisations/{world['org']}/invites"),
                        ("GET", f"/v1/organisations/{world['org']}/events"), ("GET", "/v1/permissions"), ("DELETE", "/v1/me?confirm=x")):
        r = await client.request(method, url, headers=key, json={})
        assert r.status_code in (401, 403, 404), (method, url, r.status_code)


# ---- people: members, invites, roles, audit ----------------------------------------------------------------------

async def test_member_lists_hide_addresses_from_everyone_below_admin(client, dev_login, world):
    for who, sees in (("viewer", False), ("member", False), ("admin", True), ("owner", True)):
        await dev_login(client, f"{who}@example.com")
        rows = (await client.get(f"/v1/organisations/{world['org']}/members")).json()
        assert len(rows) == 4
        assert all((r["email"] is not None) is sees for r in rows), who
        assert "mcm_live_" not in str(rows) and "whsec_" not in str(rows)


async def test_inviting_and_role_changes_follow_the_table(client, dev_login, world):
    org, ids = world["org"], world["ids"]
    for who in ("viewer", "member"):
        await dev_login(client, f"{who}@example.com")
        assert (await client.post(f"/v1/organisations/{org}/invites", json={"email": "z@example.com"})).status_code == 403
        assert (await client.get(f"/v1/organisations/{org}/invites")).status_code == 403
        assert (await client.patch(f"/v1/organisations/{org}/members/{ids['viewer']}", json={"role": "member"})).status_code == 403
        assert (await client.delete(f"/v1/organisations/{org}/members/{ids['viewer']}")).status_code == 403
    await dev_login(client, "admin@example.com")
    inv = lambda role: client.post(f"/v1/organisations/{org}/invites", json={"email": "z@example.com", "role": role})  # noqa: E731
    assert (await inv("member")).status_code == 201 and (await inv("viewer")).status_code == 201
    assert (await inv("admin")).status_code == 403  # only an owner makes admins
    patch = lambda uid, role: client.patch(f"/v1/organisations/{org}/members/{uid}", json={"role": role})  # noqa: E731
    assert (await patch(ids["viewer"], "member")).status_code == 200
    assert (await patch(ids["member"], "admin")).status_code == 403  # no promotion to admin by an admin
    assert (await patch(ids["admin"], "viewer")).status_code == 403  # nor touching another admin
    assert (await patch(ids["owner"], "viewer")).status_code == 403
    assert (await client.delete(f"/v1/organisations/{org}/members/{ids['owner']}")).status_code == 403
    assert (await client.delete(f"/v1/organisations/{org}?confirm=Acme")).status_code == 403  # only an owner deletes a company
    await dev_login(client, "owner@example.com")
    assert (await inv("admin")).status_code == 201
    assert (await patch(ids["member"], "admin")).status_code == 200


async def test_the_audit_trail_is_for_admins_and_holds_no_secrets(client, dev_login, world):
    org, pid = world["org"], world["pid"]
    await dev_login(client, "admin@example.com")
    await client.patch(f"/v1/projects/{pid}", json={"webhook_url": "https://hooks.example/token-abc", "name": "Renamed"})
    await client.post(f"/v1/projects/{pid}/key")
    await dev_login(client, "owner@example.com")
    await client.patch(f"/v1/organisations/{org}/members/{world['ids']['viewer']}", json={"role": "member"})
    events = (await client.get(f"/v1/organisations/{org}/events")).json()
    actions = [e["action"] for e in events]
    for a in ("company_created", "project_created", "invite_accepted", "project_settings_changed", "project_key_replaced", "role_changed"):
        assert a in actions, a
    changed = next(e for e in events if e["action"] == "project_settings_changed")
    assert set(changed["detail"]["fields"]) == {"webhook_url", "name"} and changed["actor"] == "admin@example.com"
    blob = str(events)
    assert "token-abc" not in blob and "whsec_" not in blob and "mcm_live_" not in blob and "SECRET" not in blob
    for who in ("viewer", "member"):
        await dev_login(client, f"{who}@example.com")
        assert (await client.get(f"/v1/organisations/{org}/events")).status_code == 403


async def test_the_permissions_endpoint_is_the_enforced_table(client, dev_login, world):
    await dev_login(client, "viewer@example.com")
    assert (await client.get("/v1/permissions")).json() == matrix()
    await client.post("/auth/logout")
    assert (await client.get("/v1/permissions")).status_code == 401


# ---- role changes, removal and sessions take effect at once -----------------------------------------------------

async def test_a_demotion_applies_on_the_very_next_request(client, dev_login, world):
    org, pid, admin = world["org"], world["pid"], world["ids"]["admin"]
    await dev_login(client, "admin@example.com")
    assert (await client.get(f"/v1/projects/{pid}")).status_code == 200
    await dev_login(client, "owner@example.com")
    assert (await client.patch(f"/v1/organisations/{org}/members/{admin}", json={"role": "viewer"})).status_code == 200
    await dev_login(client, "admin@example.com")  # a fresh sign-in is not needed; the same session is checked every time
    assert (await client.get(f"/v1/projects/{pid}")).status_code == 403
    assert (await client.post("/v1/jobs", json={"name": "q", "check_kind": "LATE_LABEL"}, headers=H(world))).status_code == 403
    assert (await client.get(f"/v1/runs/{world['run']}", headers=H(world))).json()["prompt"] is None
    await dev_login(client, "owner@example.com")
    assert (await client.patch(f"/v1/organisations/{org}/members/{admin}", json={"role": "admin"})).status_code == 200
    await dev_login(client, "admin@example.com")
    assert (await client.get(f"/v1/projects/{pid}")).status_code == 200


async def test_the_same_cookie_loses_access_the_moment_membership_ends(client, dev_login, world):
    org, member = world["org"], world["ids"]["member"]
    await dev_login(client, "member@example.com")
    cookie = dict(client.cookies)
    assert (await client.get("/v1/jobs", headers=H(world))).status_code == 200
    # The owner signs in from another browser: signing the member out first would cancel the very cookie this test keeps.
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as owner:
        await dev_login(owner, "owner@example.com")
        assert (await owner.delete(f"/v1/organisations/{org}/members/{member}")).status_code == 204
    client.cookies.clear()
    client.cookies.update(cookie)  # the removed member's old session
    assert (await client.get("/v1/jobs", headers=H(world))).status_code == 404
    assert (await client.get(f"/v1/projects?workspace={org}")).status_code == 404
    client.cookies.clear()  # signed out: no session at all
    assert (await client.get("/v1/jobs", headers=H(world))).status_code == 401


async def test_a_deleted_company_closes_every_door(client, dev_login, world, session):
    org, pid = world["org"], world["pid"]
    await dev_login(client, "owner@example.com")
    assert (await client.delete(f"/v1/projects/{pid}?confirm={pid}")).status_code == 204
    assert (await client.delete(f"/v1/organisations/{org}?confirm=Acme")).status_code == 204
    for who in ("owner", "admin", "member", "viewer"):
        await dev_login(client, f"{who}@example.com")
        assert (await client.get(f"/v1/organisations/{org}/members")).status_code == 404
        assert [w["kind"] for w in (await client.get("/v1/workspaces")).json()] == ["personal"]
    assert (await session.execute(text("SELECT count(*) FROM memberships WHERE status = 'active' AND org_id = :o"), {"o": org})).scalar_one() == 0


# ---- across companies -------------------------------------------------------------------------------------------

async def test_another_companys_owner_reaches_nothing_here_and_we_reach_nothing_there(client, dev_login, world):
    org, pid, org_b, pb = world["org"], world["pid"], world["org_b"], world["pb"]
    await dev_login(client, "rival@example.com")  # the owner of company B
    mine = [("GET", f"/v1/organisations/{org}/members"), ("GET", f"/v1/organisations/{org}/events"),
            ("GET", f"/v1/organisations/{org}/invites"), ("POST", f"/v1/organisations/{org}/invites"),
            ("POST", f"/v1/organisations/{org}/leave"), ("DELETE", f"/v1/organisations/{org}?confirm=Acme"),
            ("GET", f"/v1/projects?workspace={org}"), ("GET", f"/v1/projects/{pid}"), ("POST", f"/v1/projects/{pid}/key"),
            ("DELETE", f"/v1/projects/{pid}?confirm={pid}"), ("PATCH", f"/v1/projects/{pid}"),
            ("PATCH", f"/v1/organisations/{org}/members/{world['ids']['viewer']}"),
            ("DELETE", f"/v1/organisations/{org}/members/{world['ids']['viewer']}")]
    for method, url in mine:
        r = await client.request(method, url, json={"role": "member", "email": "a@example.com"})
        assert r.status_code == 404, (method, url, r.status_code)
    for method, url in (("GET", "/v1/jobs"), ("GET", "/v1/runs"), ("GET", f"/v1/runs/{world['run']}"), ("POST", "/v1/jobs"),
                        ("GET", "/v1/insights/prompts"), ("POST", "/v1/jobs/invoice/retest")):
        r = await client.request(method, url, headers=H(world), json={})
        assert r.status_code == 404 and "SECRET" not in r.text, (method, url, r.status_code)
    # Their own project's header with our run id: our run does not exist there.
    assert (await client.get(f"/v1/runs/{world['run']}", headers={"X-Project-Id": pb})).status_code == 404
    # And the reverse: our admin cannot reach theirs.
    await dev_login(client, "admin@example.com")
    for method, url in (("GET", f"/v1/organisations/{org_b}/members"), ("GET", f"/v1/projects/{pb}"),
                        ("POST", f"/v1/projects/{pb}/key"), ("GET", f"/v1/projects?workspace={org_b}")):
        assert (await client.request(method, url)).status_code == 404, (method, url)
    assert (await client.get("/v1/jobs", headers={"X-Project-Id": pb})).status_code == 404
    assert (await client.post("/v1/projects", json={"name": "x", "organisation_id": org_b})).status_code == 404


async def test_membership_in_one_company_gives_nothing_in_another_and_nothing_to_personal_projects(client, dev_login, world):
    await dev_login(client, "member@example.com")
    mine = (await client.post("/v1/projects", json={"name": "Private"})).json()["project"]
    await dev_login(client, "owner@example.com")  # a co-member and owner of the company still cannot open a personal project
    assert (await client.get("/v1/jobs", headers={"X-Project-Id": mine["project_id"]})).status_code == 404
    assert (await client.get(f"/v1/projects/{mine['project_id']}")).status_code == 404
    assert (await client.get("/v1/projects")).json() == []
    # a project's company cannot be changed through any route: nothing moves
    await dev_login(client, "member@example.com")
    await client.patch(f"/v1/projects/{mine['project_id']}", json={"organisation_id": world["org"], "name": "Still mine"})
    assert (await client.get(f"/v1/projects/{mine['project_id']}")).json()["organisation_id"] is None


async def test_an_admin_in_one_company_is_only_a_viewer_in_another(client, dev_login, world):
    """Roles belong to a company, so being an admin of one grants nothing in another."""
    await dev_login(client, "rival@example.com")
    org_b = world["org_b"]
    token = (await client.post(f"/v1/organisations/{org_b}/invites", json={"email": "admin@example.com", "role": "viewer"})).json()["token"]
    await dev_login(client, "admin@example.com")
    assert (await client.post("/v1/invites/accept", json={"token": token})).status_code == 200
    mine, theirs = await client.get(f"/v1/projects/{world['pid']}"), await client.get(f"/v1/projects/{world['pb']}")
    assert mine.status_code == 200 and theirs.status_code == 403
    spaces = {w["name"]: w["role"] for w in (await client.get("/v1/workspaces")).json()}
    assert spaces["Acme"] == "admin" and spaces["Rival"] == "viewer"


async def test_the_database_holds_the_roles_the_api_reports(client, dev_login, world, session):
    from agent_memory.models import Membership
    rows = (await session.execute(select(Membership.role).where(Membership.org_id == uuid.UUID(world["org"])))).scalars().all()
    assert sorted(rows) == ["admin", "member", "owner", "viewer"]


async def test_the_stored_provider_key_hint_is_for_those_who_may_change_it(client, dev_login, world, session):
    from agent_memory.models import ProviderKey
    session.add(ProviderKey(project_id=world["pid"], provider="openai", base_url="https://api.openai.example/v1",
                            key_encrypted="x", key_hint="9z9z"))
    await session.commit()
    for who, sees in (("viewer", False), ("member", False), ("admin", True), ("owner", True)):
        await dev_login(client, f"{who}@example.com")
        body = (await client.get("/v1/retest/limits", headers=H(world))).json()
        assert body["provider_key"] is not None  # everyone can tell a key is stored
        assert (body["provider_key"]["key_hint"] == "9z9z") is sees, who


def test_the_words_a_person_reads_say_trial_not_re_test_and_never_job():
    """The interface's one noun for the unit of work is "AI task" and for the feature "trial". These strings reach the Company page."""
    from agent_memory.auth.access import _DENIED
    from agent_memory.auth.privacy import notice_sections

    words = [meaning for _, meaning in {**PROJECT_PERMISSIONS, **ORG_PERMISSIONS}.values()]
    words += list(_DENIED.values()) + [t for s in notice_sections() for t in [s.heading, *s.body]]
    joined = " ".join(words).lower()
    assert not re.search(r"re-?test", joined) and not re.search(r"\bjobs?\b(?! role)", joined.replace("job role", ""))
