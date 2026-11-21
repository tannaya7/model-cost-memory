"""Logging out cancels every copy of the sign-in cookie, so a stolen one stops working. Emails are made up; nothing leaves the machine."""

import httpx
import pytest
from sqlalchemy import text

from agent_memory.api import app


@pytest.fixture
def dev(monkeypatch):
    monkeypatch.setenv("DEV_LOGIN", "true")


def browser() -> httpx.AsyncClient:
    """A second, separate cookie jar: another device, or whoever copied the cookie."""
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")


async def sign_in(c: httpx.AsyncClient, email: str) -> None:
    assert (await c.post("/auth/dev/login", json={"email": email})).status_code == 200


async def test_a_copied_cookie_stops_working_when_the_owner_logs_out(client, dev):
    await sign_in(client, "owner@example.com")
    stolen = dict(client.cookies)  # what someone who copied the cookie holds
    assert (await client.get("/v1/me")).status_code == 200

    assert (await client.post("/auth/logout")).status_code == 204
    assert (await client.get("/v1/me")).status_code == 401  # the owner's own jar is cleared

    async with browser() as thief:
        thief.cookies.update(stolen)
        assert (await thief.get("/v1/me")).status_code == 401
        assert (await thief.get("/v1/projects")).status_code == 401


async def test_the_copied_cookie_works_until_the_logout(client, dev):
    await sign_in(client, "owner@example.com")
    async with browser() as other:
        other.cookies.update(dict(client.cookies))
        assert (await other.get("/v1/me")).status_code == 200


async def test_logging_out_signs_out_the_other_devices_too_and_signing_in_again_works(client, dev):
    await sign_in(client, "owner@example.com")
    async with browser() as phone:
        await sign_in(phone, "owner@example.com")
        assert (await phone.get("/v1/me")).status_code == 200
        await client.post("/auth/logout")
        assert (await phone.get("/v1/me")).status_code == 401
        await sign_in(phone, "owner@example.com")  # sign in again: a fresh cookie carries the new counter
        assert (await phone.get("/v1/me")).status_code == 200
    await sign_in(client, "owner@example.com")
    assert (await client.get("/v1/me")).status_code == 200


async def test_one_persons_logout_does_not_touch_anyone_else(client, dev):
    await sign_in(client, "one@example.com")
    async with browser() as other:
        await sign_in(other, "two@example.com")
        await client.post("/auth/logout")
        assert (await other.get("/v1/me")).status_code == 200


async def test_a_cookie_from_before_this_change_still_works_until_logout(client, dev, session):
    """Old cookies carry no counter; that counts as 0, which is every user's starting value."""
    await sign_in(client, "owner@example.com")
    assert (await session.execute(text("SELECT session_epoch FROM users WHERE email = 'owner@example.com'"))).scalar_one() == 0


async def test_logging_out_twice_or_with_no_cookie_is_harmless(client, dev, session):
    assert (await client.post("/auth/logout")).status_code == 204  # nobody signed in
    await sign_in(client, "owner@example.com")
    await client.post("/auth/logout")
    assert (await client.post("/auth/logout")).status_code == 204
    counter = (await session.execute(text("SELECT session_epoch FROM users WHERE email = 'owner@example.com'"))).scalar_one()
    assert counter == 1  # the second logout had no valid cookie, so it did not raise it again


async def test_a_wrong_counter_in_a_cookie_is_treated_as_signed_out(client, dev, session):
    await sign_in(client, "owner@example.com")
    await session.execute(text("UPDATE users SET session_epoch = 5 WHERE email = 'owner@example.com'"))
    await session.commit()
    assert (await client.get("/v1/me")).status_code == 401
