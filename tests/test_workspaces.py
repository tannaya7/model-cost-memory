"""Optional company workspaces: several companies, none, removal, invites, leaving and account deletion.

Real Postgres, made-up emails, no external connection. Nothing moves between workspaces."""

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import text

from agent_memory.models import OrgInvite
from agent_memory.auth.orgs import hash_token


@pytest.fixture
def dev_login(monkeypatch):
    monkeypatch.setenv("DEV_LOGIN", "true")

    async def sign_in(client, email):
        await client.post("/auth/logout")
        response = await client.post("/auth/dev/login", json={"email": email})
        assert response.status_code == 200, response.text
        return response.json()

    return sign_in


async def _company(client, name="Acme"):
    return (await client.post("/v1/organisations", json={"name": name})).json()["org_id"]


async def _invite_and_join(client, dev_login, org_id, owner, email, role="member"):
    await dev_login(client, owner)
    made = await client.post(f"/v1/organisations/{org_id}/invites", json={"email": email, "role": role})
    assert made.status_code == 201, made.text
    await dev_login(client, email)
    joined = await client.post("/v1/invites/accept", json={"token": made.json()["token"]})
    assert joined.status_code == 200, joined.text
    return made.json()["token"]


async def test_a_person_with_no_company_sees_only_their_personal_workspace(client, dev_login):
    await dev_login(client, "solo@example.com")
    spaces = (await client.get("/v1/workspaces")).json()
    assert [(w["kind"], w["org_id"]) for w in spaces] == [("personal", None)]
    made = await client.post("/v1/projects", json={"name": "Mine"})
    assert made.status_code == 201 and made.json()["project"]["organisation_id"] is None
    assert len((await client.get("/v1/projects")).json()) == 1


async def test_one_person_in_several_companies_switches_without_merging(client, dev_login):
    await dev_login(client, "multi@example.com")
    personal = (await client.post("/v1/projects", json={"name": "Production"})).json()["project"]
    a, b = await _company(client, "Acme"), await _company(client, "Beta")
    pa = (await client.post("/v1/projects", json={"name": "Production", "organisation_id": a})).json()["project"]
    pb = (await client.post("/v1/projects", json={"name": "Production", "organisation_id": b})).json()["project"]
    # The same short name can exist in each workspace; each is listed only in its own.
    assert personal["slug"] == pa["slug"] == pb["slug"] == "production"
    assert [p["project_id"] for p in (await client.get("/v1/projects")).json()] == [personal["project_id"]]
    assert [p["project_id"] for p in (await client.get(f"/v1/projects?workspace={a}")).json()] == [pa["project_id"]]
    assert [p["project_id"] for p in (await client.get(f"/v1/projects?workspace={b}")).json()] == [pb["project_id"]]
    spaces = (await client.get("/v1/workspaces")).json()
    assert [w["kind"] for w in spaces] == ["personal", "company", "company"]
    assert [w["project_count"] for w in spaces] == [1, 1, 1]
    # A project in any workspace is reachable by its id, and project data stays separate.
    for p in (personal, pa, pb):
        assert (await client.get("/v1/jobs", headers={"X-Project-Id": p["project_id"]})).status_code == 200
    # With no header the personal workspace is used, exactly as before companies existed.
    assert (await client.post("/v1/jobs", json={"name": "t", "check_kind": "LATE_LABEL"})).status_code == 201
    assert (await client.get("/v1/jobs", headers={"X-Project-Id": pa["project_id"]})).json() == []


async def test_a_stranger_cannot_reach_a_company_or_its_projects(client, dev_login):
    await dev_login(client, "owner@example.com")
    org = await _company(client)
    proj = (await client.post("/v1/projects", json={"name": "Shared", "organisation_id": org})).json()["project"]
    await dev_login(client, "stranger@example.com")
    assert (await client.get(f"/v1/organisations/{org}/members")).status_code == 404
    assert (await client.get(f"/v1/projects?workspace={org}")).status_code == 404
    assert (await client.get("/v1/jobs", headers={"X-Project-Id": proj["project_id"]})).status_code == 404
    assert (await client.delete(f"/v1/projects/{proj['project_id']}?confirm={proj['project_id']}")).status_code == 404
    assert (await client.post("/v1/projects", json={"name": "x", "organisation_id": org})).status_code == 404


async def test_roles_decide_what_a_member_may_do(client, dev_login):
    await dev_login(client, "owner@example.com")
    org = await _company(client)
    proj = (await client.post("/v1/projects", json={"name": "Shared", "organisation_id": org})).json()["project"]
    hdr = {"X-Project-Id": proj["project_id"]}
    for email, role in [("viewer@example.com", "viewer"), ("member@example.com", "member"), ("admin@example.com", "admin")]:
        await _invite_and_join(client, dev_login, org, "owner@example.com", email, role)
    await dev_login(client, "viewer@example.com")
    assert (await client.get("/v1/jobs", headers=hdr)).status_code == 200
    assert (await client.post("/v1/jobs", json={"name": "t", "check_kind": "LATE_LABEL"}, headers=hdr)).status_code == 403
    assert (await client.post("/v1/projects", json={"name": "n", "organisation_id": org})).status_code == 403
    await dev_login(client, "member@example.com")
    assert (await client.post("/v1/jobs", json={"name": "t", "check_kind": "LATE_LABEL"}, headers=hdr)).status_code == 201
    assert (await client.get(f"/v1/projects/{proj['project_id']}")).status_code == 403  # settings need admin
    assert (await client.post(f"/v1/organisations/{org}/invites", json={"email": "x@example.com"})).status_code == 403
    await dev_login(client, "admin@example.com")
    assert (await client.get(f"/v1/projects/{proj['project_id']}")).status_code == 200
    assert (await client.post(f"/v1/organisations/{org}/invites",
                              json={"email": "x@example.com", "role": "admin"})).status_code == 403  # only owners make admins
    assert (await client.post(f"/v1/organisations/{org}/invites",
                              json={"email": "x@example.com", "role": "member"})).status_code == 201


async def test_invite_rules_expiry_single_use_wrong_email_and_withdrawal(client, dev_login, session):
    await dev_login(client, "owner@example.com")
    org = await _company(client)
    made = (await client.post(f"/v1/organisations/{org}/invites", json={"email": "New@Example.com", "role": "member"})).json()
    token = made["token"]
    stored = (await session.execute(text("SELECT token_hash, email FROM org_invites"))).one()
    assert stored.token_hash == hash_token(token) and token not in stored.token_hash and stored.email == "new@example.com"
    # A different signed-in address cannot use it, and the message does not name the company.
    await dev_login(client, "other@example.com")
    wrong = await client.post("/v1/invites/accept", json={"token": token})
    assert wrong.status_code == 403 and "Acme" not in wrong.text
    # The right address joins once; a second use is refused with the generic message.
    await dev_login(client, "new@example.com")
    assert (await client.post("/v1/invites/accept", json={"token": token})).status_code == 200
    again = await client.post("/v1/invites/accept", json={"token": token})
    assert again.status_code == 404 and "not valid" in again.json()["detail"]
    # Expired and withdrawn invites give the same generic answer as an unknown token.
    await dev_login(client, "owner@example.com")
    for email in ("late@example.com", "gone@example.com"):
        t = (await client.post(f"/v1/organisations/{org}/invites", json={"email": email})).json()
        if email.startswith("late"):
            await session.execute(text("UPDATE org_invites SET expires_at = :t WHERE invite_id = :i"),
                                  {"t": datetime.now(UTC) - timedelta(seconds=1), "i": t["invite"]["invite_id"]})
            await session.commit()
        else:
            assert (await client.delete(f"/v1/organisations/{org}/invites/{t['invite']['invite_id']}")).status_code == 204
        await dev_login(client, email)
        r = await client.post("/v1/invites/accept", json={"token": t["token"]})
        assert r.status_code == 404 and r.json()["detail"] == (await client.post("/v1/invites/accept", json={"token": "x" * 40})).json()["detail"]
        await dev_login(client, "owner@example.com")
    states = {i["email"]: i["state"] for i in (await client.get(f"/v1/organisations/{org}/invites")).json()}
    assert states["late@example.com"] == "expired" and states["gone@example.com"] == "withdrawn" and states["new@example.com"] == "used"
    expiry = (await session.execute(text("SELECT max(expires_at - created_at) FROM org_invites"))).scalar_one()
    assert expiry <= timedelta(days=7, seconds=1)


async def test_revoked_membership_loses_access_at_once_and_keeps_personal_projects(client, dev_login):
    await dev_login(client, "owner@example.com")
    org = await _company(client)
    proj = (await client.post("/v1/projects", json={"name": "Shared", "organisation_id": org})).json()["project"]
    await _invite_and_join(client, dev_login, org, "owner@example.com", "pat@example.com")
    mine = (await client.post("/v1/projects", json={"name": "Pat private"})).json()["project"]
    pat_id = (await client.get("/v1/me")).json()["user_id"]
    hdr = {"X-Project-Id": proj["project_id"]}
    assert (await client.get("/v1/jobs", headers=hdr)).status_code == 200
    await dev_login(client, "owner@example.com")
    assert (await client.delete(f"/v1/organisations/{org}/members/{pat_id}")).status_code == 204
    await dev_login(client, "pat@example.com")
    assert (await client.get("/v1/jobs", headers=hdr)).status_code == 404
    assert (await client.get(f"/v1/organisations/{org}/members")).status_code == 404
    assert [w["kind"] for w in (await client.get("/v1/workspaces")).json()] == ["personal"]
    assert [p["project_id"] for p in (await client.get("/v1/projects")).json()] == [mine["project_id"]]
    await dev_login(client, "owner@example.com")  # the company's project did not move or change owner
    assert [p["project_id"] for p in (await client.get(f"/v1/projects?workspace={org}")).json()] == [proj["project_id"]]


async def test_leaving_keeps_both_sides_intact_and_rejoining_needs_a_new_invite(client, dev_login):
    await dev_login(client, "owner@example.com")
    org = await _company(client)
    proj = (await client.post("/v1/projects", json={"name": "Shared", "organisation_id": org})).json()["project"]
    await _invite_and_join(client, dev_login, org, "owner@example.com", "lee@example.com", "admin")
    mine = (await client.post("/v1/projects", json={"name": "Lee private"})).json()["project"]
    assert (await client.post(f"/v1/organisations/{org}/leave")).status_code == 204
    assert (await client.get("/v1/jobs", headers={"X-Project-Id": proj["project_id"]})).status_code == 404
    assert [p["project_id"] for p in (await client.get("/v1/projects")).json()] == [mine["project_id"]]
    assert (await client.post(f"/v1/organisations/{org}/leave")).status_code == 404  # already out
    await dev_login(client, "owner@example.com")
    assert (await client.get(f"/v1/projects?workspace={org}")).json()[0]["project_id"] == proj["project_id"]
    token = (await client.post(f"/v1/organisations/{org}/invites", json={"email": "lee@example.com", "role": "viewer"})).json()["token"]
    await dev_login(client, "lee@example.com")
    assert (await client.post("/v1/invites/accept", json={"token": token})).json()["role"] == "viewer"  # new role, not the old one


async def test_the_last_owner_cannot_leave_be_removed_or_demoted(client, dev_login):
    await dev_login(client, "owner@example.com")
    org = await _company(client)
    me = (await client.get("/v1/me")).json()["user_id"]
    assert (await client.post(f"/v1/organisations/{org}/leave")).status_code == 409
    assert (await client.patch(f"/v1/organisations/{org}/members/{me}", json={"role": "admin"})).status_code == 409
    assert (await client.delete(f"/v1/organisations/{org}/members/{me}")).status_code == 409
    await _invite_and_join(client, dev_login, org, "owner@example.com", "co@example.com", "member")
    co = (await client.get("/v1/me")).json()["user_id"]
    await dev_login(client, "owner@example.com")
    assert (await client.patch(f"/v1/organisations/{org}/members/{co}", json={"role": "owner"})).status_code == 200
    assert (await client.post(f"/v1/organisations/{org}/leave")).status_code == 204  # now another owner exists


async def test_a_company_with_projects_cannot_be_deleted_and_nothing_moves(client, dev_login):
    await dev_login(client, "owner@example.com")
    org = await _company(client, "Acme")
    proj = (await client.post("/v1/projects", json={"name": "Shared", "organisation_id": org})).json()["project"]
    assert (await client.delete(f"/v1/organisations/{org}?confirm=Acme")).status_code == 409
    assert (await client.delete(f"/v1/organisations/{org}?confirm=Nope")).status_code == 422
    assert (await client.delete(f"/v1/projects/{proj['project_id']}?confirm={proj['project_id']}")).status_code == 204
    assert (await client.delete(f"/v1/organisations/{org}?confirm=Acme")).status_code == 204
    assert [w["kind"] for w in (await client.get("/v1/workspaces")).json()] == ["personal"]


async def test_account_deletion_is_explicit(client, dev_login, session):
    await dev_login(client, "owner@example.com")
    org = await _company(client)
    shared = (await client.post("/v1/projects", json={"name": "Shared", "organisation_id": org})).json()["project"]
    await _invite_and_join(client, dev_login, org, "owner@example.com", "gone@example.com", "member")
    mine = (await client.post("/v1/projects", json={"name": "Gone private"})).json()["project"]
    # The only owner of a company cannot delete their account.
    await dev_login(client, "owner@example.com")
    blocked = await client.delete("/v1/me?confirm=owner@example.com")
    assert blocked.status_code == 409 and "Acme" in blocked.text
    assert (await client.delete("/v1/me?confirm=wrong@example.com")).status_code == 422
    # A member can: personal projects go, the company's project stays, the membership ends.
    await dev_login(client, "gone@example.com")
    assert (await client.delete("/v1/me?confirm=Gone@Example.com")).status_code == 204
    assert (await client.get("/v1/me")).status_code == 401
    ids = set((await session.execute(text("SELECT project_id FROM projects"))).scalars())
    assert mine["project_id"] not in ids and shared["project_id"] in ids
    assert (await session.execute(text("SELECT count(*) FROM users WHERE email = 'gone@example.com'"))).scalar_one() == 0
    await dev_login(client, "owner@example.com")
    assert [m["email"] for m in (await client.get(f"/v1/organisations/{org}/members")).json()] == ["owner@example.com"]


async def test_project_keys_are_unaffected_by_membership(client, dev_login):
    await dev_login(client, "owner@example.com")
    org = await _company(client)
    created = (await client.post("/v1/projects", json={"name": "Shared", "organisation_id": org})).json()
    await client.post("/auth/logout")
    ok = await client.get("/v1/jobs", headers={"X-API-Key": created["api_key"]})
    assert ok.status_code == 200
    assert (await client.get("/v1/workspaces", headers={"X-API-Key": created["api_key"]})).status_code == 401
    assert (await client.get("/v1/workspaces")).status_code == 401


async def test_invite_rows_hold_no_plain_token(client, dev_login, session):
    await dev_login(client, "owner@example.com")
    org = await _company(client)
    made = (await client.post(f"/v1/organisations/{org}/invites", json={"email": "a@example.com"})).json()
    rows = (await session.execute(text("SELECT * FROM org_invites"))).mappings().all()
    assert all(made["token"] not in str(v) for r in rows for v in r.values())
    assert OrgInvite.__tablename__ == "org_invites"
