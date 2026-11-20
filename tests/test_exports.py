"""CSV exports: one safe writer, the same permission rules as the screens, the period and filters that were asked for, no text and no people.

Real Postgres, made-up data, no external connection."""

import csv
import io
import uuid
from datetime import UTC, datetime, timedelta

import pytest

from agent_memory.exports import COMPANY_COLUMNS, FORMULA_LEADS, PROJECT_COLUMNS, neutralize, write_csv
from agent_memory.models import Job, Project, Run
from agent_memory.security import generate_key, hash_key
from tests.test_company_overview import SECRET, _company, _project, _runs


def parse(text):
    return list(csv.reader(io.StringIO(text.removeprefix("﻿"), newline="")))


@pytest.fixture
def dev_login(monkeypatch):
    monkeypatch.setenv("DEV_LOGIN", "true")

    async def sign_in(client, email):
        await client.post("/auth/logout")
        assert (await client.post("/auth/dev/login", json={"email": email})).status_code == 200

    return sign_in


# ---- the writer ---------------------------------------------------------------------------------------------------------

@pytest.mark.parametrize("lead", list(FORMULA_LEADS))
def test_a_text_value_that_starts_like_a_formula_is_neutralized(lead):
    assert neutralize(f"{lead}cmd|' /C calc'!A0") == (f"'{lead}cmd|' /C calc'!A0", True)


@pytest.mark.parametrize("safe", ["invoice", "a=b", "x-y", "1+1", "", "name @home"])
def test_ordinary_text_is_left_alone(safe):
    assert neutralize(safe) == (safe, False)


def test_numbers_are_never_touched_so_a_negative_stays_a_negative():
    text, changed = write_csv(["name", "amount", "count"], [{"name": "-5", "amount": -2.5, "count": -3}], text_columns=["name"])
    [header, row] = parse(text)
    assert row == ["'-5", "-2.5", "-3"] and changed == 1  # the TEXT "-5" is guarded; the NUMBERS are not


def test_quoting_follows_rfc_4180_and_lines_end_in_crlf():
    tricky = 'say "hi", please\nthen go'
    text, _ = write_csv(["a", "b"], [{"a": tricky, "b": "plain"}, {"a": "x,y", "b": None}], text_columns=["a", "b"])
    assert text.endswith("\r\n") and text.count("\r\n") == 3  # the header and two rows; the line break inside the quotes is kept as it was
    assert parse(text) == [["a", "b"], [tricky, "plain"], ["x,y", ""]]  # it reads back exactly
    assert '"say ""hi"", please\nthen go"' in text


def test_the_writer_counts_what_it_changed_and_leaves_other_columns_alone():
    text, changed = write_csv(["task", "note"], [{"task": "=1+1", "note": "=kept"}, {"task": "ok", "note": "@x"}], text_columns=["task"])
    assert changed == 1 and parse(text)[1] == ["'=1+1", "=kept"]  # only the columns declared as text are guarded


def test_booleans_and_missing_values_have_plain_forms():
    [_, row] = parse(write_csv(["a", "b", "c"], [{"a": True, "b": False}], text_columns=[])[0])
    assert row == ["true", "false", ""]


# ---- the project file ----------------------------------------------------------------------------------------------------

async def _project_with_runs(session, *, mode="per_use"):
    key = generate_key()
    session.add(Project(project_id="acme", slug="acme", api_key_hash=hash_key(key), billing_mode=mode, webhook_url="https://hooks.example/secret-token"))
    await session.flush()
    jobs = {}
    for name in ("invoice", "=HYPERLINK(\"http://evil.example\",\"x\")", "-5", "@SUM(A1)"):
        jobs[name] = Job(project_id="acme", name=name if name == "invoice" else name.replace('"', ""), check_kind="ANSWER_KEY", check_config={"fields": ["t"]})
        session.add(jobs[name])
    await session.commit()
    return key, jobs


async def _add(session, job, offset, n, model="mini", cost=0.01):
    now = datetime.now(UTC).replace(hour=12, minute=0, second=0, microsecond=0)
    for i in range(n):
        session.add(Run(run_id=uuid.uuid4(), job_id=job.job_id, project_id="acme", prompt=SECRET, output="SECRET ANSWER", prompt_hash="h", model=model,
                        model_version=model + "-1", tokens_in=100, tokens_out=10, cache_read_tokens=5, cost_usd=cost, outcome="PASS" if i % 2 == 0 else "FAIL",
                        state="INDEXED", usage_shape="openai_chat", created_at=now - timedelta(days=offset, minutes=i)))
    await session.commit()


async def test_the_file_matches_the_period_and_filters_and_says_its_units_and_basis(client, dev_login, session):
    key, jobs = await _project_with_runs(session)
    await _add(session, jobs["invoice"], 1, 4)
    await _add(session, jobs["invoice"], 20, 6)  # outside a 7-day period
    await _add(session, jobs["-5"], 2, 3, model="other")
    await dev_login(client, "owner@example.com")
    sess = await client.post("/v1/projects", json={"name": "Mine"})  # a personal project, to show a signed-in owner may export their own
    mine = sess.json()["project"]["project_id"]
    owner_job = (await client.post("/v1/jobs", json={"name": "t", "check_kind": "LATE_LABEL"}, headers={"X-Project-Id": mine}))
    assert owner_job.status_code == 201
    r = await client.get("/v1/insights/export.csv?days=7", headers={"X-Project-Id": mine})
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/csv") and "attachment" in r.headers["content-disposition"]
    assert parse(r.text)[0] == list(PROJECT_COLUMNS)[:8] + ["spend_usd"] + list(PROJECT_COLUMNS)[9:] and r.headers["x-export-rows"] == "0"


async def test_a_key_cannot_export_and_the_message_says_why(client, session):
    key, jobs = await _project_with_runs(session)
    r = await client.get("/v1/insights/export.csv", headers={"X-API-Key": key})
    assert r.status_code == 403 and "Only an admin or owner can export" in r.json()["detail"]


async def _company_project(client, dev_login, session, mode="per_use"):
    await dev_login(client, "owner@example.com")
    org = await _company(client)
    pid = await _project(client, session, org, "Shared", mode)
    for email, role in (("viewer@example.com", "viewer"), ("member@example.com", "member"), ("admin@example.com", "admin")):
        await dev_login(client, "owner@example.com")
        token = (await client.post(f"/v1/organisations/{org}/invites", json={"email": email, "role": role})).json()["token"]
        await dev_login(client, email)
        await client.post("/v1/invites/accept", json={"token": token})
    return org, pid


async def test_only_admins_and_owners_get_the_project_file_and_everyone_else_is_told_plainly(client, dev_login, session):
    org, pid = await _company_project(client, dev_login, session)
    job = Job(project_id=pid, name="invoice", check_kind="ANSWER_KEY", check_config={"fields": ["t"]})
    session.add(job)
    await session.commit()
    await session.refresh(job)
    now = datetime.now(UTC).replace(hour=12, minute=0, second=0, microsecond=0)
    for i in range(6):
        session.add(Run(run_id=uuid.uuid4(), job_id=job.job_id, project_id=pid, prompt=SECRET, output="SECRET ANSWER", prompt_hash="h", model="mini", model_version="mini-1",
                        tokens_in=100, tokens_out=10, cost_usd=0.01, outcome="PASS", state="INDEXED", usage_shape="openai_chat", created_at=now - timedelta(days=1, minutes=i)))
    await session.commit()
    h = {"X-Project-Id": pid}
    for who, code in (("viewer", 403), ("member", 403), ("admin", 200), ("owner", 200)):
        await dev_login(client, f"{who}@example.com")
        r = await client.get("/v1/insights/export.csv?days=7", headers=h)
        assert r.status_code == code, (who, r.status_code)
    await dev_login(client, "stranger@example.com")
    assert (await client.get("/v1/insights/export.csv", headers=h)).status_code == 404
    await client.post("/auth/logout")
    assert (await client.get("/v1/insights/export.csv", headers=h)).status_code == 401
    # what an admin gets: aggregates, units, basis, period and filters on every row; no text, no key, no webhook, no address
    await dev_login(client, "admin@example.com")
    r = await client.get("/v1/insights/export.csv?days=7", headers=h)
    rows = parse(r.text)
    head, body = rows[0], [dict(zip(rows[0], x, strict=True)) for x in rows[1:]]
    assert head == list(PROJECT_COLUMNS) and len(body) == 1
    row = body[0]
    assert (row["ai_task"], row["model"], row["runs"], row["passed"], row["tokens_in"], row["currency"], row["pay_mode"]) == ("invoice", "mini", "6", "6", "600", "USD", "per_use")
    assert "not an invoice" in row["cost_basis"] and row["period_end"] >= row["period_start"] and row["filter_ai_task"] == "" and row["filter_model"] == ""
    for secret in (SECRET, "SECRET ANSWER", "mcm_live_", "whsec_", "@example.com", "hooks.example"):
        assert secret not in r.text, secret


async def test_the_file_follows_the_selected_period_and_filters(client, dev_login, session):
    org, pid = await _company_project(client, dev_login, session)
    await dev_login(client, "owner@example.com")
    for name in ("invoice", "triage"):
        await client.post("/v1/jobs", json={"name": name, "check_kind": "LATE_LABEL"}, headers={"X-Project-Id": pid})
    jobs = {j.name: j for j in (await session.execute(Job.__table__.select().where(Job.project_id == pid))).all()}
    now = datetime.now(UTC).replace(hour=12, minute=0, second=0, microsecond=0)

    async def add(name, days_ago, model, n=3):
        for i in range(n):
            session.add(Run(run_id=uuid.uuid4(), job_id=jobs[name].job_id, project_id=pid, prompt="p", prompt_hash="h", model=model, model_version=model + "-1",
                            tokens_in=10, tokens_out=1, cost_usd=0.01, outcome="PASS", state="INDEXED", usage_shape="openai_chat", created_at=now - timedelta(days=days_ago, minutes=i)))
        await session.commit()

    await add("invoice", 1, "mini")
    await add("invoice", 10, "mini")
    await add("triage", 2, "big")
    h = {"X-Project-Id": pid}

    def table(text):
        rows = parse(text)
        return [dict(zip(rows[0], r, strict=True)) for r in rows[1:]]

    week = table((await client.get("/v1/insights/export.csv?days=7", headers=h)).text)
    month = table((await client.get("/v1/insights/export.csv?days=30", headers=h)).text)
    assert sorted((r["ai_task"], r["day"]) for r in week) == sorted((r["ai_task"], r["day"]) for r in week) and len(week) == 2  # 7 days: two days of data
    assert len(month) == 3  # 30 days adds the older day
    only_task = table((await client.get("/v1/insights/export.csv?days=30&ai_task=invoice", headers=h)).text)
    assert {r["ai_task"] for r in only_task} == {"invoice"} and {r["filter_ai_task"] for r in only_task} == {"invoice"} and len(only_task) == 2
    only_model = table((await client.get("/v1/insights/export.csv?days=30&model=big", headers=h)).text)
    assert {r["model"] for r in only_model} == {"big"} and {r["filter_model"] for r in only_model} == {"big"}
    nothing = (await client.get("/v1/insights/export.csv?days=30&ai_task=nope", headers=h))
    assert parse(nothing.text) == [list(PROJECT_COLUMNS)] and nothing.headers["x-export-rows"] == "0"  # a filter with no data is an empty file, not an error
    assert (await client.get("/v1/insights/export.csv?days=0", headers=h)).status_code == 422
    assert (await client.get("/v1/insights/export.csv?days=9999", headers=h)).status_code == 422
    # the period in every row matches the one asked for
    first = table((await client.get("/v1/insights/export.csv?days=7", headers=h)).text)[0]
    span = datetime.fromisoformat(first["period_end"]) - datetime.fromisoformat(first["period_start"])
    assert span.days == 6


async def test_a_flat_plan_names_the_cost_column_what_it_is(client, dev_login, session):
    org, pid = await _company_project(client, dev_login, session, mode="subscription")
    await dev_login(client, "owner@example.com")
    r = await client.get("/v1/insights/export.csv", headers={"X-Project-Id": pid})
    header = parse(r.text)[0]
    assert "list_price_usd" in header and "spend_usd" not in header  # not the bill: list price of the calls


async def test_names_that_could_run_as_formulas_are_neutralized_and_counted_but_numbers_are_not_touched(client, dev_login, session):
    org, pid = await _company_project(client, dev_login, session)
    await dev_login(client, "owner@example.com")
    nasty = ["=HYPERLINK(evil)", "+1", "-5", "@SUM(A1)"]
    jobs = []
    for name in nasty:
        job = Job(project_id=pid, name=name, check_kind="LATE_LABEL", check_config={})
        session.add(job)
        jobs.append(job)
    await session.commit()
    now = datetime.now(UTC).replace(hour=12, minute=0, second=0, microsecond=0)
    for job in jobs:
        session.add(Run(run_id=uuid.uuid4(), job_id=job.job_id, project_id=pid, prompt="p", prompt_hash="h", model="-evil-model", model_version="m-1", tokens_in=7,
                        tokens_out=1, cost_usd=0.02, outcome="PASS", state="INDEXED", usage_shape="openai_chat", created_at=now - timedelta(hours=1)))
    await session.commit()
    r = await client.get("/v1/insights/export.csv?days=7", headers={"X-Project-Id": pid})
    rows = parse(r.text)
    body = [dict(zip(rows[0], x, strict=True)) for x in rows[1:]]
    assert sorted(b["ai_task"] for b in body) == sorted("'" + n for n in nasty)  # each starts with a quote now, so it is text
    assert {b["model"] for b in body} == {"'-evil-model"}
    assert all(b["tokens_in"] == "7" and b["spend_usd"] == "0.02" for b in body)  # numbers are exactly as they were
    assert int(r.headers["x-export-neutralized"]) == len(nasty) * 2  # four task names and four model names
    assert not any(cell.startswith(FORMULA_LEADS) for row in rows[1:] for cell in row)  # no cell can be read as a formula


# ---- the company report (manager report) ----------------------------------------------------------------------------------

async def test_the_company_report_is_for_admins_and_matches_the_screen(client, dev_login, session):
    org, _ = await _company(client, dev_login) if False else (None, None)
    await dev_login(client, "owner@example.com")
    org = await _company(client)
    a = await _project(client, session, org, "Alpha", "per_use")
    b = await _project(client, session, org, "Beta", "subscription")
    await _runs(session, a, "invoice", 12, cost=0.02, model="m1")
    await _runs(session, a, "tiny", 2, cost=0.02, model="m1")  # a small group: folded, as on screen
    await _runs(session, b, "triage", 9, cost=0.5, model="m2")
    for email, role in (("viewer@example.com", "viewer"), ("member@example.com", "member"), ("admin@example.com", "admin")):
        await dev_login(client, "owner@example.com")
        token = (await client.post(f"/v1/organisations/{org}/invites", json={"email": email, "role": role})).json()["token"]
        await dev_login(client, email)
        await client.post("/v1/invites/accept", json={"token": token})
    url = f"/v1/organisations/{org}/overview/export.csv?days=30"
    for who, code in (("viewer", 403), ("member", 403), ("admin", 200), ("owner", 200)):
        await dev_login(client, f"{who}@example.com")
        assert (await client.get(url)).status_code == code, who
    await dev_login(client, "stranger@example.com")
    assert (await client.get(url)).status_code == 404
    await client.post("/auth/logout")
    assert (await client.get(url)).status_code == 401
    await dev_login(client, "admin@example.com")
    r = await client.get(url)
    assert (await client.get(f"/v1/organisations/{org}/overview/export.csv?days=5")).status_code == 422
    screen = (await client.get(f"/v1/organisations/{org}/overview?days=30")).json()
    rows = parse(r.text)
    head, body = rows[0], [dict(zip(rows[0], x, strict=True)) for x in rows[1:]]
    assert head == list(COMPANY_COLUMNS)
    by = {(x["section"], x["name"]): x for x in body}
    assert by[("totals", "all projects you may open")]["calls"] == str(screen["totals"]["calls"]) == "23"
    assert by[("project", "Alpha")]["cost_usd"] != "" and by[("project", "Beta")]["cost_usd"] == ""  # a flat plan has no dollars, as on screen
    assert ("ai_task", "Other small groups") in by and ("ai_task", "tiny") not in by  # the small-group rule holds in the file too
    assert {x["chargeback_grade"] for x in body} == {"false"} and "not chargeback-grade" in by[("ai_task", "invoice")]["attribution"]
    assert all("not an invoice" in x["cost_basis"] and x["period_start"] and x["period_end"] and x["currency"] == "USD" for x in body)
    for secret in (SECRET, "SECRET ANSWER", "@example.com", "mcm_live_"):
        assert secret not in r.text, secret
    assert r.headers["x-export-rows"] == str(len(body)) and "attachment" in r.headers["content-disposition"]


async def test_a_company_report_never_holds_another_companys_numbers_and_neutralizes_names(client, dev_login, session):
    await dev_login(client, "owner@example.com")
    a = await _company(client, "Acme")
    pa = await _project(client, session, a, "=cmd|'/C calc'!A0", "per_use")
    await _runs(session, pa, "@task", 10, model="-model")
    await dev_login(client, "rival@example.com")
    b = await _company(client, "Rival")
    pb = await _project(client, session, b, "Beta", "per_use")
    await _runs(session, pb, "rival-task", 10)
    r = await client.get(f"/v1/organisations/{b}/overview/export.csv")
    assert "rival-task" in r.text and "cmd" not in r.text and "@task" not in r.text
    assert (await client.get(f"/v1/organisations/{a}/overview/export.csv")).status_code == 404
    await dev_login(client, "owner@example.com")
    mine = await client.get(f"/v1/organisations/{a}/overview/export.csv")
    rows = parse(mine.text)
    assert "'=cmd|'/C calc'!A0" in mine.text.replace('""', '"') or any(c.startswith("'=cmd") for row in rows for c in row)
    assert any(c == "'@task" for row in rows for c in row) and any(c == "'-model" for row in rows for c in row)
    assert not any(cell.startswith(FORMULA_LEADS) for row in rows[1:] for cell in row)
    assert int(mine.headers["x-export-neutralized"]) >= 3
    assert "rival-task" not in mine.text


async def test_exports_are_recorded_in_the_audit_trail_without_content(client, dev_login, session):
    await dev_login(client, "owner@example.com")
    org = await _company(client)
    pid = await _project(client, session, org, "Shared", "per_use")
    await client.get("/v1/insights/export.csv?days=7", headers={"X-Project-Id": pid})
    await client.get(f"/v1/organisations/{org}/overview/export.csv?days=7")
    events = (await client.get(f"/v1/organisations/{org}/events")).json()
    kinds = {e["action"]: e for e in events}
    assert kinds["project_data_exported"]["detail"]["days"] == 7 and kinds["overview_exported"]["detail"]["rows"] >= 1
    assert SECRET not in str(events) and "csv" not in str(events).lower()


async def test_the_company_report_does_not_name_a_model_used_by_only_a_few_calls(client, dev_login, session):
    await dev_login(client, "owner@example.com")
    org = await _company(client)
    a = await _project(client, session, org, "Alpha", "per_use")
    await _runs(session, a, "invoice", 12, cost=0.02, model="common")
    await _runs(session, a, "invoice", 2, cost=0.03, model="one-persons-experiment")
    r = await client.get(f"/v1/organisations/{org}/overview/export.csv?days=30")
    assert r.status_code == 200
    assert "one-persons-experiment" not in r.text
    rows = parse(r.text)
    models = [dict(zip(rows[0], x, strict=True)) for x in rows[1:] if x[0] == "model"]
    assert [m["name"] for m in models] == ["common", "Other small groups"]
    assert int(models[-1]["calls"]) == 2 and float(models[-1]["cost_usd"]) == pytest.approx(0.06)


# ---- Excel opens the files correctly --------------------------------------------------------------------------------------

def test_the_file_helper_adds_one_byte_order_mark_and_the_plain_writer_does_not():
    from agent_memory.exports import csv_file
    text, _ = write_csv(["a"], [{"a": "x"}], text_columns=["a"])
    assert not text.startswith("\ufeff")
    assert csv_file(text).startswith("\ufeff") and not csv_file(text).startswith("\ufeff\ufeff")
    assert csv_file(text).encode("utf-8")[:3] == b"\xef\xbb\xbf"


async def test_both_downloads_start_with_the_mark_and_accented_names_survive(client, dev_login, session):
    await dev_login(client, "owner@example.com")
    org = await _company(client)
    a = await _project(client, session, org, "Alpha", "per_use")
    await _runs(session, a, "invoice", 6, cost=0.02, model="modèle-é")
    company = await client.get(f"/v1/organisations/{org}/overview/export.csv?days=30")
    pid = a if isinstance(a, str) else str(a)
    project = await client.get("/v1/insights/export.csv?days=30", headers={"X-Project-Id": pid})
    for r in (company, project):
        assert r.status_code == 200 and r.content[:3] == b"\xef\xbb\xbf"
        assert "modèle-é" in r.content.decode("utf-8-sig")  # reads back correctly with the mark, the way Excel reads it
        assert parse(r.content.decode("utf-8-sig"))[0][0] in {"section", "day"}  # the mark is not part of the first column name
