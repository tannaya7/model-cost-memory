"""Google sign-in with Google replaced by a fake (no network): what we do with whatever Google returns."""

import pytest
from sqlalchemy import text

from agent_memory.auth import routes
from agent_memory.auth.routes import _safe_next
from agent_memory.config import get_settings


class FakeGoogle:
    def __init__(self, info=None, error=None):
        self.info, self.error, self.redirect_kwargs = info, error, None

    async def authorize_redirect(self, request, redirect_uri, **kw):
        from starlette.responses import RedirectResponse
        self.redirect_kwargs = (redirect_uri, kw)
        return RedirectResponse("https://accounts.google.com/o/oauth2/v2/auth?fake=1", status_code=302)

    async def authorize_access_token(self, request):
        if self.error:
            raise self.error
        return {"userinfo": self.info}


@pytest.fixture
def google(monkeypatch):
    holder = {}

    def install(info=None, error=None):
        holder["g"] = FakeGoogle(info, error)
        monkeypatch.setattr(routes, "_google", lambda: holder["g"])
        return holder["g"]

    return install


GOOD = {"sub": "g-123", "email": "Ana@Example.com", "email_verified": True, "name": "Ana", "picture": "https://x/y.png"}


async def test_login_sends_the_person_to_google_and_remembers_a_safe_next_page(client, google):
    g = google(GOOD)
    r = await client.get("/auth/google/login?next=/projects", follow_redirects=False)
    assert r.status_code == 302 and r.headers["location"].startswith("https://accounts.google.com/")
    assert g.redirect_kwargs[0].endswith("/auth/google/callback")


async def test_a_verified_google_account_signs_in_and_is_keyed_by_sub(client, google, session):
    google(GOOD)
    await client.get("/auth/google/login?next=/projects", follow_redirects=False)
    r = await client.get("/auth/google/callback", follow_redirects=False)
    assert r.status_code == 303 and r.headers["location"].endswith("/projects")
    assert (await client.get("/v1/me")).json()["email"] == "Ana@Example.com"
    # The same Google account with a new address is the same person, not a second account.
    google({**GOOD, "email": "ana@new.example", "name": "Ana B"})
    await client.get("/auth/google/callback", follow_redirects=False)
    assert (await session.execute(text("SELECT count(*) FROM users"))).scalar_one() == 1
    assert (await client.get("/v1/me")).json()["email"] == "ana@new.example"


async def test_an_unverified_email_is_refused_and_creates_nothing(client, google, session):
    for flag in (False, None, "false"):
        info = {**GOOD, "email_verified": flag}
        if flag is None:
            info.pop("email_verified")
        google(info)
        r = await client.get("/auth/google/callback", follow_redirects=False)
        assert r.status_code == 303 and r.headers["location"].endswith("/signin?error=unverified")
    assert (await client.get("/v1/me")).status_code == 401
    assert (await session.execute(text("SELECT count(*) FROM users"))).scalar_one() == 0


async def test_a_failed_or_tampered_sign_in_goes_back_to_sign_in_without_an_account(client, google, session):
    google(error=RuntimeError("state mismatch"))
    r = await client.get("/auth/google/callback", follow_redirects=False)
    assert r.headers["location"].endswith("/signin?error=google")
    google({"sub": "", "email": ""})
    r = await client.get("/auth/google/callback", follow_redirects=False)
    assert r.headers["location"].endswith("/signin?error=google")
    assert (await session.execute(text("SELECT count(*) FROM users"))).scalar_one() == 0


async def test_an_unverified_google_email_cannot_take_an_invite(client, google, monkeypatch):
    """The reason the check exists: invites are tied to the email address."""
    monkeypatch.setenv("DEV_LOGIN", "true")
    await client.post("/auth/dev/login", json={"email": "owner@example.com"})
    org = (await client.post("/v1/organisations", json={"name": "Acme"})).json()["org_id"]
    await client.post(f"/v1/organisations/{org}/invites", json={"email": "victim@example.com"})
    await client.post("/auth/logout")
    google({"sub": "g-evil", "email": "victim@example.com", "email_verified": False})
    await client.get("/auth/google/callback", follow_redirects=False)
    assert (await client.get("/v1/workspaces")).status_code == 401


@pytest.mark.parametrize("value, expected", [
    ("/projects", "/projects"), ("/p/x?a=1#b", "/p/x?a=1#b"), (None, "/"), ("", "/"),
    ("//evil.example", "/"), ("https://evil.example", "/"), ("/\\evil.example", "/"), ("/a\nb", "/"), ("evil", "/"),
])
def test_next_page_can_only_be_on_this_site(value, expected):
    assert _safe_next(value) == expected


def test_the_login_asks_for_pkce_and_a_signed_id_token():
    import inspect
    src = inspect.getsource(routes._google)
    assert "S256" in src and "openid" in src and "server_metadata_url" in src
    assert get_settings() is not None
