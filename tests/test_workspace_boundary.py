"""The line between a person's personal work and a company's: data never crosses it, in either direction.

One person can have personal projects and company projects (and several companies). Each request is scoped to exactly one project, and a
company's totals, lists and exports hold only that company's projects. Real Postgres, made-up emails, nothing leaves the machine."""

import pytest

from tests.test_company_overview import _company, _runs
from tests.test_exports import parse


@pytest.fixture
def dev_login(monkeypatch):
    monkeypatch.setenv("DEV_LOGIN", "true")

    async def sign_in(client, email):
        await client.post("/auth/logout")
        assert (await client.post("/auth/dev/login", json={"email": email})).status_code == 200

    return sign_in


async def _both(client, dev_login, session, email="both@example.com"):
    """A person with one personal project (6 calls at $0.05) and one company project (7 calls at $0.01), with a key for each."""
    await dev_login(client, email)
    mine = (await client.post("/v1/projects", json={"name": "Mine"})).json()
    org = await _company(client, "Acme")
    team = (await client.post("/v1/projects", json={"name": "Team app", "organisation_id": org})).json()
    await _runs(session, mine["project"]["project_id"], "diary", 6, cost=0.05)
    await _runs(session, team["project"]["project_id"], "triage", 7, cost=0.01)
    return mine, org, team


def head(project):
    return {"X-Project-Id": project["project"]["project_id"]}


async def test_the_company_totals_never_include_a_members_personal_projects(client, dev_login, session):
    mine, org, team = await _both(client, dev_login, session)
    body = (await client.get(f"/v1/organisations/{org}/overview?days=30")).json()
    assert body["totals"]["calls"] == 7  # not 13
    assert body["totals"]["billable_usd"] == pytest.approx(0.07)
    text = str(body)
    assert "diary" not in text and "Mine" not in text and mine["project"]["project_id"] not in text
    other = await _company(client, "Beta")  # a second company of the same person stays empty
    assert (await client.get(f"/v1/organisations/{other}/overview?days=30")).json()["totals"]["calls"] == 0


async def test_each_request_is_scoped_to_exactly_one_project(client, dev_login, session):
    mine, _, team = await _both(client, dev_login, session)

    async def spend(project):
        points = (await client.get("/v1/insights/daily?days=30", headers=head(project))).json()
        return sum(p["spend_usd"] for p in points)

    assert await spend(mine) == pytest.approx(0.30)
    assert await spend(team) == pytest.approx(0.07)
    assert [j["name"] for j in (await client.get("/v1/jobs", headers=head(mine))).json()] == ["diary"]
    assert [j["name"] for j in (await client.get("/v1/jobs", headers=head(team))).json()] == ["triage"]


async def test_a_project_key_sees_only_its_own_project(client, dev_login, session):
    mine, _, team = await _both(client, dev_login, session)
    await client.post("/auth/logout")  # keys work without any sign-in
    assert [j["name"] for j in (await client.get("/v1/jobs", headers={"X-API-Key": mine["api_key"]})).json()] == ["diary"]
    assert [j["name"] for j in (await client.get("/v1/jobs", headers={"X-API-Key": team["api_key"]})).json()] == ["triage"]
    crossed = await client.get("/v1/jobs", headers={"X-API-Key": mine["api_key"], "X-Project-Id": team["project"]["project_id"]})
    assert [j["name"] for j in crossed.json()] == ["diary"]  # a key decides the project; a header cannot redirect it


async def test_a_company_you_are_not_in_does_not_exist_for_you(client, dev_login, session):
    mine, org, team = await _both(client, dev_login, session)
    await dev_login(client, "stranger@example.com")
    for url in (f"/v1/projects?workspace={org}", f"/v1/organisations/{org}/overview", f"/v1/organisations/{org}/members"):
        assert (await client.get(url)).status_code == 404, url
    assert (await client.get("/v1/jobs", headers=head(team))).status_code == 404
    assert (await client.get("/v1/jobs", headers=head(mine))).status_code == 404
    assert (await client.get("/v1/projects")).json() == []  # not even a hint that the other person's projects exist


async def test_nothing_can_be_moved_between_personal_and_company_by_editing(client, dev_login, session):
    mine, org, team = await _both(client, dev_login, session)
    sneaky = {"name": "Renamed", "organisation_id": org, "owner_user_id": None, "slug": "x"}
    await client.patch(f"/v1/projects/{mine['project']['project_id']}", json=sneaky)
    assert [p["project_id"] for p in (await client.get("/v1/projects")).json()] == [mine["project"]["project_id"]]
    assert [p["project_id"] for p in (await client.get(f"/v1/projects?workspace={org}")).json()] == [team["project"]["project_id"]]
    await client.patch(f"/v1/projects/{team['project']['project_id']}", json={"organisation_id": None})
    assert [p["project_id"] for p in (await client.get("/v1/projects")).json()] == [mine["project"]["project_id"]]
    assert [p["project_id"] for p in (await client.get(f"/v1/projects?workspace={org}")).json()] == [team["project"]["project_id"]]


async def test_creating_a_project_without_naming_a_company_is_always_personal(client, dev_login, session):
    _, org, team = await _both(client, dev_login, session)
    made = (await client.post("/v1/projects", json={"name": "Another"}, headers=head(team))).json()["project"]  # even with a company project open
    assert made["organisation_id"] is None
    assert made["project_id"] not in [p["project_id"] for p in (await client.get(f"/v1/projects?workspace={org}")).json()]


async def test_signing_in_as_someone_else_in_the_same_browser_shows_nothing_of_the_first_person(client, dev_login, session):
    mine, _, team = await _both(client, dev_login, session, "first@example.com")
    assert (await client.post("/auth/dev/login", json={"email": "second@example.com"})).status_code == 200  # no sign-out in between
    assert (await client.get("/v1/me")).json()["email"] == "second@example.com"
    assert (await client.get("/v1/projects")).json() == []
    assert [w["kind"] for w in (await client.get("/v1/workspaces")).json()] == ["personal"]
    for project in (mine, team):
        assert (await client.get("/v1/jobs", headers=head(project))).status_code == 404


async def test_exports_hold_only_their_own_workspace(client, dev_login, session):
    mine, _, team = await _both(client, dev_login, session)
    personal = (await client.get("/v1/insights/export.csv?days=30", headers=head(mine))).content.decode("utf-8-sig")
    company = (await client.get("/v1/insights/export.csv?days=30", headers=head(team))).content.decode("utf-8-sig")
    assert "diary" in personal and "triage" not in personal
    assert "triage" in company and "diary" not in company
    assert {row[1] for row in parse(personal)[1:]} == {"diary"} and {row[1] for row in parse(company)[1:]} == {"triage"}


async def test_the_account_chooser_is_asked_for_only_when_switching(client, monkeypatch):
    from starlette.responses import RedirectResponse

    from agent_memory.auth import routes

    seen = []

    class FakeGoogle:
        async def authorize_redirect(self, request, uri, **extra):
            seen.append(extra)
            return RedirectResponse("https://accounts.example/auth")

    monkeypatch.setattr(routes, "_google", lambda: FakeGoogle())
    await client.get("/auth/google/login?next=/projects")
    await client.get("/auth/google/login?next=/projects&switch=true")
    assert seen == [{}, {"prompt": "select_account"}]  # normal sign-in unchanged; switching always shows Google's chooser
