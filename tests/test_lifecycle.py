"""Model status per provider: one provider retiring a model does not retire it for every job."""

from datetime import date

from agent_memory.catalog.lifecycle import UNKNOWN, lifecycles, most_used
from agent_memory.models import CatalogEntry, ProviderPrice

TODAY = date(2026, 10, 30)


async def add_flash(session, *, source="SYNC"):
    # As in the real price list: the plain entry is Vertex AI's, retired on 20 Oct; the Gemini API has no date.
    session.add(CatalogEntry(model="flash", model_version="flash", provider="vertex_ai", status="RETIRED",
                             shutdown_date=date(2026, 10, 20), source=source))
    session.add(ProviderPrice(model="flash", provider="vertex_ai", shutdown_date=date(2026, 10, 20)))
    session.add(ProviderPrice(model="flash", provider="gemini", shutdown_date=None))
    await session.commit()


async def test_status_follows_the_provider_the_job_uses(session):
    await add_flash(session)
    got = await lifecycles(session, {"flash": "Gemini"}, today=TODAY)
    assert got["flash"].status == "ACTIVE"
    got = await lifecycles(session, {"flash": "vertex_ai"}, today=TODAY)
    assert (got["flash"].status, got["flash"].shutdown_date) == ("RETIRED", date(2026, 10, 20))


async def test_without_a_provider_a_model_others_still_serve_is_deprecated_with_a_note(session):
    await add_flash(session)
    life = (await lifecycles(session, {"flash": None}, today=TODAY))["flash"]
    assert life.status == "DEPRECATED"
    assert life.note == ("vertex_ai retired it on 2026-10-20, but gemini still serve flash; record which provider "
                         "this job uses to know for sure")


async def test_a_hand_entered_status_wins_and_an_unknown_model_is_unknown(session):
    await add_flash(session, source="MANUAL")
    got = await lifecycles(session, {"flash": "gemini", "nope": None}, today=TODAY)
    assert got["flash"].status == "RETIRED"
    assert got["nope"] is UNKNOWN


def test_the_provider_most_runs_name_is_used():
    assert most_used(["gemini", None, "Gemini", "vertex_ai"]) == "gemini"
    assert most_used([None, None]) is None


async def test_a_job_on_the_gemini_api_still_gets_a_verdict_for_a_model_vertex_retired(session):
    """What the deploy dry run caught: 30 checked runs on gemini-2.5-flash came back INSUFFICIENT_EVIDENCE."""
    import uuid

    from agent_memory.models import Job, Project, Run
    from agent_memory.recommend.engine import recommend

    await add_flash(session)
    session.add(Project(project_id="p", api_key_hash="x"))
    await session.flush()
    job = Job(project_id="p", name="invoice", check_kind="ANSWER_KEY", check_config={"fields": ["total"]})
    session.add(job)
    await session.flush()
    for i in range(30):
        session.add(Run(run_id=uuid.uuid4(), job_id=job.job_id, project_id="p", prompt=f"p{i}", prompt_hash=f"h{i}",
                        model="flash", model_version="flash", provider="gemini", outcome="PASS" if i < 27 else "FAIL",
                        cost_usd=0.001, state="CHECKED"))
    await session.commit()
    d = (await recommend(session, job)).decision
    assert (d.verdict, d.recommended.model, d.models[0].catalog_status) == ("HOLD", "flash", "ACTIVE")


async def test_the_sync_keeps_each_providers_date_and_reports_one_provider_retiring(session):
    from agent_memory.catalog.sync import sync_catalog
    from sqlalchemy import select

    def price_list(gemini_date=None):
        return {
            "flash": {"litellm_provider": "vertex_ai", "mode": "chat", "deprecation_date": "2026-12-01",
                      "input_cost_per_token": 3e-07, "output_cost_per_token": 2.5e-06},
            "gemini/flash": {"litellm_provider": "gemini", "mode": "chat", "deprecation_date": gemini_date,
                             "input_cost_per_token": 3e-07, "output_cost_per_token": 2.5e-06},
        }

    await sync_catalog(session, price_list(), today=TODAY)
    dates = {p.provider: p.shutdown_date for p in (await session.execute(select(ProviderPrice))).scalars()}
    assert dates == {"vertex_ai": date(2026, 12, 1), "gemini": None}
    result = await sync_catalog(session, price_list("2026-10-01"), today=TODAY)
    assert result.status_changes == [("flash", "ACTIVE", "RETIRED")]
