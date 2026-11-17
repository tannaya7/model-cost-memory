"""The task profile (measured facts) and the opt-in AI task summary."""

import uuid
from datetime import UTC, datetime, timedelta

from agent_memory.models import Job, Project, Run
from agent_memory.recommend import task_summary
from agent_memory.recommend.task_summary import sanitize
from agent_memory.security import generate_key, hash_key


def test_sanitize_hides_emails_links_numbers_and_secrets():
    raw = ("Mail ana@example.com or call +44 7700 900123, card 4111 1111 1111 1111, "
           "see https://x.io/a?b=1 key sk-abcdef123456789 " + "z" * 700)
    out = sanitize(raw)
    for leak in ("ana@example.com", "7700", "4111", "x.io", "sk-abcdef"):
        assert leak not in out
    assert "[email]" in out and "[number]" in out and "[link]" in out and "[secret]" in out
    assert len(out) <= 600


async def _world(session, n=30, text_kept=True):
    key = generate_key()
    session.add(Project(project_id="acme", api_key_hash=hash_key(key)))
    await session.flush()
    job = Job(project_id="acme", name="invoice-extract", check_kind="LATE_LABEL", check_config={})
    session.add(job)
    await session.flush()
    now = datetime.now(UTC)
    session.add_all([Run(run_id=uuid.uuid4(), job_id=job.job_id, project_id="acme",
                         prompt=f"Extract the total from invoice {i} for ana{i}@example.com" if text_kept else None,
                         output="42.00" if text_kept else None, prompt_hash=f"h{i}", model="m", model_version="m-1",
                         tokens_in=100, tokens_out=10, run_kind="PRODUCTION", created_at=now - timedelta(hours=i),
                         content_removed_at=None if text_kept else now) for i in range(n)])
    await session.commit()
    return {"X-API-Key": key}


async def test_profile_needs_25_calls(client, session):
    headers = await _world(session, n=10)
    body = (await client.get("/v1/jobs/invoice-extract/profile", headers=headers)).json()
    assert body["calls"] == 10 and body["enough_data"] is False and body["models"] == []
    assert body["summary"]["consent"] is False


async def test_profile_facts(client, session):
    headers = await _world(session)
    body = (await client.get("/v1/jobs/invoice-extract/profile", headers=headers)).json()
    assert body["calls"] == 30 and body["enough_data"] and body["models"] == ["m"]
    assert body["typical_tokens_in"] == 100 and body["typical_tokens_out"] == 10
    assert body["uses_tools"] is False and body["multi_agent"] is False
    assert (await client.get("/v1/jobs/nope/profile", headers=headers)).status_code == 404


async def test_summary_is_off_until_the_project_opts_in_and_sends_only_clean_text(client, session, monkeypatch):
    monkeypatch.setenv("SUMMARY_API_KEY", "k")
    sent = []

    async def fake(settings, instructions, payload):
        sent.append(payload)
        return "It pulls the total out of invoices. It is an extraction task."

    monkeypatch.setattr(task_summary, "_call", fake)
    headers = await _world(session)
    url = "/v1/jobs/invoice-extract/profile"
    assert (await client.get(url, headers=headers)).json()["summary"]["state"] == "off" and sent == []
    on = await client.put("/v1/task-summary-consent", json={"enabled": True}, headers=headers)
    assert on.json()["consent"] is True
    summary = (await client.get(url, headers=headers)).json()["summary"]
    assert summary["state"] == "ready" and "invoices" in summary["text"]
    assert len(sent) == 1 and "example.com" not in sent[0] and "[email]" in sent[0]
    await client.get(url, headers=headers)
    assert len(sent) == 1  # same samples: not written again
    assert (await client.delete("/v1/jobs/invoice-extract/summary", headers=headers)).status_code == 204
    assert (await client.get(url, headers=headers)).json()["summary"]["state"] == "deleted" and len(sent) == 1
    await client.put("/v1/task-summary-consent", json={"enabled": False}, headers=headers)
    assert (await client.get(url, headers=headers)).json()["summary"]["state"] == "off"


async def test_no_stored_text_means_no_summary(client, session, monkeypatch):
    monkeypatch.setenv("SUMMARY_API_KEY", "k")
    headers = await _world(session, text_kept=False)
    await client.put("/v1/task-summary-consent", json={"enabled": True}, headers=headers)
    assert (await client.get("/v1/jobs/invoice-extract/profile", headers=headers)).json()["summary"]["state"] == "no_samples"


async def test_no_key_means_unavailable(client, session, monkeypatch):
    monkeypatch.delenv("SUMMARY_API_KEY", raising=False)
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    headers = await _world(session)
    assert (await client.get("/v1/jobs/invoice-extract/profile", headers=headers)).json()["summary"]["state"] == "unavailable"
