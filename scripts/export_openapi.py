"""Write the API contract the frontend is built against.

  python scripts/export_openapi.py

Produces, in contract/:
  openapi.json          the OpenAPI schema FastAPI publishes (the frontend generates its types from it)
  samples/jobs.json     an example GET /v1/jobs response
  samples/runs.json     an example GET /v1/runs response
  samples/models.json   an example GET /v1/models response
  samples/recommendation.json   an example GET /v1/jobs/{job}/recommendation response
  samples/spend.json    an example GET /v1/insights/spend response

The samples are built from the response models themselves, so they cannot drift from the schema; the
recommendation sample is produced by the engine's own `decide`.
A test fails when the committed files are out of date; run this script and commit the result.
"""

from __future__ import annotations

import json
import uuid
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

CONTRACT = Path(__file__).resolve().parents[1] / "contract"


def build() -> dict[str, str]:
    from agent_memory.api import _recommendation_out, app
    from agent_memory.config import Settings
    from agent_memory.recommend.engine import FailingRun, JobRecommendation, ModelInput, decide
    from agent_memory.recommend.stats import Sample
    from agent_memory.schemas import JobOut, ModelOut, ModelPage, RunOut, RunPage, SpendOut

    invoice, ticket = uuid.UUID(int=0x1001), uuid.UUID(int=0x1002)
    jobs = [
        JobOut(job_id=invoice, name="invoice-extract",
               description="Extract vendor, invoice number, date and total from an invoice",
               check_kind="ANSWER_KEY", check_config={"fields": ["vendor", "invoice_number", "date", "total"]},
               retest_consent=True, run_count=961, runs_by_state={"INDEXED": 940, "CHECKED": 21}),
        JobOut(job_id=ticket, name="ticket-classify", description="Classify a support ticket",
               check_kind="SCHEMA", check_config={"schema": {"type": "object", "required": ["category"]}},
               retest_consent=False, run_count=0, runs_by_state={}),
    ]
    t0 = datetime(2026, 10, 14, 9, 30, tzinfo=UTC)

    def run(i: int, model: str, outcome: str, reason: str | None) -> RunOut:
        return RunOut(
            run_id=uuid.UUID(int=0x2000 + i), job_id=invoice, job="invoice-extract", model=model,
            model_version="2026-09", prompt_version="v2", tokens_in=820, tokens_out=140,
            cache_read_tokens=0, cache_write_tokens=0, cost_usd=0.0031 if model == "mini" else 0.0347,
            latency_ms=640, outcome=outcome, outcome_reason=reason, run_kind="PRODUCTION",
            state="INDEXED", created_at=t0 - timedelta(minutes=i),
            prompt_preview="Extract the vendor, invoice number, date and total from this invoice: ...",
            output_preview='{"vendor": "ShopCo", "invoice_number": "INV-1042", "date": "2026-10-13", ...',
        )

    runs = RunPage(
        items=[run(1, "mini", "PASS", None), run(2, "max", "PASS", None),
               run(3, "mini", "FAIL", "total: expected 1250.00, got 1205.00")],
        next_cursor="MjAyNi0xMC0xNFQwOToyNzowMCswMDowMHwwMDAwMDAwMC0wMDAwLTAwMDAtMDAwMC0wMDAwMDAwMDIwMDM=",
    )

    seen_at = datetime(2026, 9, 1, tzinfo=UTC)
    from agent_memory.catalog.official import BASIS, CATALOG_SOURCE
    from agent_memory.schemas import CatalogInfoOut, ModelReferenceOut, PriceSourceOut

    def reference(check: str, note: str, *, maker=None, checked=None, official=None) -> ModelReferenceOut:
        return ModelReferenceOut(
            kind="api_model", maker=maker, docs_url="https://platform.claude.com/docs/en/models/overview" if maker else None,
            pricing_url="https://platform.claude.com/docs/en/about-claude/pricing" if maker else None,
            deprecations_url="https://platform.claude.com/docs/en/about-claude/model-deprecations" if maker else None,
            price_check=check, price_check_note=note, price_checked_at=checked, price_check_stale=False,
            official_input_per_mtok=official[0] if official else None, official_output_per_mtok=official[1] if official else None,
            price_basis=BASIS, catalog_source="Entered by hand" if check == "not_checked" and maker is None else CATALOG_SOURCE,
            catalog_synced_at=seen_at)

    read_at = datetime(2026, 11, 18, 5, 15, tzinfo=UTC)
    models = ModelPage(
        catalog=CatalogInfoOut(source=CATALOG_SOURCE, last_synced_at=read_at,
                               note="Prices come from a community-maintained list and refresh daily. Where a maker's own pricing "
                                    "page can be read, it is compared with this and shown beside it."),
        official_sources=[PriceSourceOut(source_id="anthropic", name="Anthropic: Pricing", provider="anthropic",
                                         url="https://platform.claude.com/docs/en/about-claude/pricing", status="OK",
                                         last_checked_at=read_at, last_ok_at=read_at, detail=None, model_count=18, stale=False)],
        kind_note="This is a list of API models you can call. Coding tools and subscription apps, such as Cursor or Copilot, are "
                  "not API endpoints, so they are not listed or ranked here.",
        items=[
            ModelOut(model="acme-large-2026-06-01", model_version="acme-large-2026-06-01", provider="acme",
                     status="ACTIVE", shutdown_date=None, price_in_per_mtok=3.0, price_out_per_mtok=15.0,
                     source="SYNC", first_seen_at=seen_at, used_by_project=True,
                     reference=reference("not_checked", "We do not read this provider's own pages yet, so this price is not confirmed against them.")),
            ModelOut(model="acme-old-2025-01-01", model_version="acme-old-2025-01-01", provider="acme",
                     status="DEPRECATED", shutdown_date=date(2026, 12, 1), price_in_per_mtok=10.0,
                     price_out_per_mtok=30.0, source="SYNC", first_seen_at=seen_at, used_by_project=True,
                     reference=reference("confirmed", "The maker's pricing page states the same price.", maker="Anthropic",
                                         checked=read_at, official=(10.0, 30.0))),
            ModelOut(model="local-llm:3b", model_version="local-llm:3b", provider="ollama", status="ACTIVE",
                     shutdown_date=None, price_in_per_mtok=0.0, price_out_per_mtok=0.0, source="MANUAL",
                     first_seen_at=seen_at, used_by_project=False,
                     reference=reference("not_checked", "We do not read this provider's own pages yet, so this price is not confirmed against them.")),
        ],
        next_cursor=None,
    )

    settings = Settings()
    evidence = [  # (model, version, runs, failures, effective n, evidence weight, mean cost, catalog status)
        ("acme-large", "acme-large-2026-06-01", 640, 6, 560.0, 610.0, 0.0347, "ACTIVE"),
        ("acme-mini", "acme-mini-2026-08-15", 420, 4, 380.0, 400.0, 0.0031, "ACTIVE"),
        ("acme-nano", "acme-nano-2026-09-01", 24, 1, 21.0, 22.5, 0.0009, "ACTIVE"),
    ]
    decision = decide(
        [ModelInput(model=m, model_version=v, n_runs=n, failures=f,
                    sample=Sample(pass_rate=1 - f / n, effective_n=eff, evidence_weight=w), mean_cost_usd=cost,
                    catalog_status=status)
         for m, v, n, f, eff, w, cost, status in evidence],
        "acme-large", floor=settings.evidence_floor, margin=settings.tolerance_points,
        confidence=settings.confidence_level,
    )
    recommendation = _recommendation_out(JobRecommendation(
        job="invoice-extract", decision=decision, n_runs=1084, evidence_weight=1032.5,
        failing_runs=[
            FailingRun(uuid.UUID(int=0x2003), "acme-mini", "acme-mini-2026-08-15",
                       "total: expected 1250.00, got 1205.00", t0 - timedelta(hours=3)),
            FailingRun(uuid.UUID(int=0x2011), "acme-large", "acme-large-2026-06-01",
                       "date: expected 2026-10-02, got 2026-02-10", t0 - timedelta(days=2)),
        ],
        computed_at=t0, settings=settings,
    ))
    spend = [SpendOut(job="invoice-extract", runs=961, spend_usd=28.41, share=0.87),
             SpendOut(job="ticket-classify", runs=1530, spend_usd=4.26, share=0.13)]

    def dump(obj) -> str:
        return json.dumps(obj, indent=2, sort_keys=True, ensure_ascii=False) + "\n"

    return {
        "openapi.json": dump(app.openapi()),
        "samples/jobs.json": dump([j.model_dump(mode="json") for j in jobs]),
        "samples/runs.json": dump(runs.model_dump(mode="json")),
        "samples/models.json": dump(models.model_dump(mode="json")),
        "samples/recommendation.json": dump(recommendation.model_dump(mode="json")),
        "samples/spend.json": dump([s.model_dump(mode="json") for s in spend]),
    }


def main() -> None:
    for name, text in build().items():
        path = CONTRACT / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf8", newline="\n")
        print("wrote", path.relative_to(CONTRACT.parent))


if __name__ == "__main__":
    main()
