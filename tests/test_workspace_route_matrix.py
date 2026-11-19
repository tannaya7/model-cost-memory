"""Every route that acts on a project, tried as each kind of caller. A new route that skips the access check fails here.

Callers: a stranger (no membership), a viewer, and a member of a company. Real Postgres, no external connection."""

import re

import pytest
from fastapi.routing import APIRoute

from agent_memory.api import app
from agent_memory.auth import access

WRITE = {"POST", "PUT", "PATCH", "DELETE"}


def _calls(dependant):
    for d in dependant.dependencies:
        yield d.call
        yield from _calls(d)


def _all_routes(routes):
    for r in routes:
        inner = getattr(r, "original_router", None)  # an included router holds its routes inside
        if inner is not None:
            yield from _all_routes(inner.routes)
        else:
            yield r


def _routes(*guards):
    out = []
    for r in _all_routes(app.routes):
        if isinstance(r, APIRoute) and any(c in guards for c in _calls(r.dependant)):
            for m in sorted(r.methods - {"HEAD", "OPTIONS"}):
                out.append((m, r.path))
    return out


PROJECT_ROUTES = _routes(access.current_project)
MANAGE_ROUTES = _routes(access.owned_project, access.signed_in_project)


def _fill(path):
    return re.sub(r"\{[^}]+\}", "x1", path)


@pytest.fixture
def dev_login(monkeypatch):
    monkeypatch.setenv("DEV_LOGIN", "true")

    async def sign_in(client, email):
        await client.post("/auth/logout")
        assert (await client.post("/auth/dev/login", json={"email": email})).status_code == 200

    return sign_in


async def _setup(client, dev_login):
    await dev_login(client, "owner@example.com")
    org = (await client.post("/v1/organisations", json={"name": "Acme"})).json()["org_id"]
    proj = (await client.post("/v1/projects", json={"name": "Shared", "organisation_id": org})).json()["project"]
    for email, role in (("viewer@example.com", "viewer"), ("member@example.com", "member")):
        await dev_login(client, "owner@example.com")
        token = (await client.post(f"/v1/organisations/{org}/invites", json={"email": email, "role": role})).json()["token"]
        await dev_login(client, email)
        assert (await client.post("/v1/invites/accept", json={"token": token})).status_code == 200
    return org, proj["project_id"]


def test_the_route_lists_are_not_empty():
    assert len(PROJECT_ROUTES) > 30 and len(MANAGE_ROUTES) >= 5


async def test_a_stranger_gets_404_on_every_project_route(client, dev_login):
    _, pid = await _setup(client, dev_login)
    await dev_login(client, "stranger@example.com")
    bad = []
    for method, path in PROJECT_ROUTES:
        r = await client.request(method, _fill(path), headers={"X-Project-Id": pid}, json={})
        if r.status_code != 404 or "Sign in" in r.text:
            bad.append((method, path, r.status_code))
    assert not bad, bad


async def test_a_viewer_can_never_write_through_any_project_route(client, dev_login):
    _, pid = await _setup(client, dev_login)
    await dev_login(client, "viewer@example.com")
    bad = []
    for method, path in PROJECT_ROUTES:
        if method in WRITE:
            r = await client.request(method, _fill(path), headers={"X-Project-Id": pid}, json={})
            if r.status_code != 403:
                bad.append((method, path, r.status_code))
    assert not bad, bad


async def test_only_admins_and_owners_reach_the_settings_routes(client, dev_login):
    _, pid = await _setup(client, dev_login)
    for email in ("stranger@example.com", "viewer@example.com", "member@example.com"):
        await dev_login(client, email)
        bad = []
        for method, path in MANAGE_ROUTES:
            url = _fill(path).replace("/x1", f"/{pid}", 1) if "{project_id}" in path else _fill(path)
            r = await client.request(method, url, headers={"X-Project-Id": pid}, json={})
            if r.status_code not in (403, 404):
                bad.append((method, path, r.status_code))
        assert not bad, (email, bad)


async def test_company_routes_hide_a_company_from_outsiders(client, dev_login):
    org, _ = await _setup(client, dev_login)
    await dev_login(client, "stranger@example.com")
    calls = [("GET", f"/v1/organisations/{org}/members"), ("GET", f"/v1/organisations/{org}/invites"),
             ("POST", f"/v1/organisations/{org}/invites"), ("POST", f"/v1/organisations/{org}/leave"),
             ("DELETE", f"/v1/organisations/{org}?confirm=Acme"),
             ("PATCH", f"/v1/organisations/{org}/members/{org}"), ("DELETE", f"/v1/organisations/{org}/members/{org}"),
             ("DELETE", f"/v1/organisations/{org}/invites/{org}")]
    for method, url in calls:
        r = await client.request(method, url, json={"role": "member", "email": "a@example.com"})
        assert r.status_code == 404, (method, url, r.status_code)
    await dev_login(client, "viewer@example.com")
    for method, url in calls[1:3] + calls[4:]:
        r = await client.request(method, url, json={"role": "member", "email": "a@example.com"})
        assert r.status_code == 403, (method, url, r.status_code)
