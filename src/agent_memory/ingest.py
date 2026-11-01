"""Write path: define jobs and record runs.

A run and its outbox row are written in one transaction, so there is never a recorded run without
the receipt the sync worker needs, and never a receipt without its run. The caller commits.
The outcome (PASS, FAIL or UNKNOWN, with a reason) is resolved here by the job's checker; it is never
accepted from the client. A run the checker cannot decide stays UNKNOWN until it is labelled later.
"""

from __future__ import annotations

import hashlib
import logging
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from .checks import Outcome, check_run
from .costing import Price, compute_cost
from .pipeline import flow
from .options import normalize_effort
from .models import CatalogEntry, Job, OutboxRow, Project, ProviderPrice, Run
from .privacy import sanitize_tool_calls
from .schemas import JobCreate, RunCreate
from .versions import normalize


log = logging.getLogger("agent_memory.ingest")


class UnknownJob(LookupError):
    """The run names a job that does not exist in this project."""


class DuplicateJob(ValueError):
    """A job with this name already exists in this project."""


class UnknownRun(LookupError):
    """No run with this id in this project."""


class AlreadyResolved(ValueError):
    """The run already has a PASS or FAIL outcome."""


def prompt_hash(prompt: str) -> str:
    """Stable key for de-duplicating and caching by prompt text."""
    return hashlib.sha256(prompt.encode("utf8")).hexdigest()


async def create_job(session: AsyncSession, project: Project, body: JobCreate) -> Job:
    job = Job(
        project_id=project.project_id, name=body.name, description=body.description,
        check_kind=body.check_kind, check_config=body.check_config, retest_consent=body.retest_consent,
    )
    session.add(job)
    try:
        await session.flush()
    except IntegrityError as exc:
        await session.rollback()
        raise DuplicateJob(body.name) from exc
    return job


async def find_price(
    session: AsyncSession, model: str, model_version: str, provider: str | None = None
) -> Price | None:
    """The catalog price for this call, or None when unpriced.

    Tries the provider-resolved version first (usually the full dated name), then the model that was
    asked for (the alias), after normalising both. A hand-entered (MANUAL) catalog price always wins;
    otherwise, when the run names its provider, that provider's own price is used, because the same
    model can cost several times more on one provider than on another.
    """
    candidates = [normalize(model_version), normalize(model)]
    rows = (
        await session.execute(
            select(CatalogEntry).where(
                CatalogEntry.model.in_(candidates), CatalogEntry.price_in_per_mtok.is_not(None),
                CatalogEntry.price_out_per_mtok.is_not(None),
            )
        )
    ).scalars().all()
    best = min(rows, key=lambda r: (candidates.index(r.model), -r.first_seen_at.timestamp())) if rows else None
    if provider and not (best and best.source == "MANUAL"):
        sold = (
            await session.execute(
                select(ProviderPrice).where(
                    ProviderPrice.model.in_(candidates), ProviderPrice.provider == provider.strip().lower(),
                    ProviderPrice.price_in_per_mtok.is_not(None), ProviderPrice.price_out_per_mtok.is_not(None),
                )
            )
        ).scalars().all()
        if sold:
            own = min(sold, key=lambda r: candidates.index(r.model))
            return Price.from_input_output(own.price_in_per_mtok, own.price_out_per_mtok)
    if best is None:
        return None
    return Price.from_input_output(best.price_in_per_mtok, best.price_out_per_mtok)


async def record_run(
    session: AsyncSession, project: Project, body: RunCreate, *, run_kind: str = "PRODUCTION", retest_id=None
) -> bool:
    """Store a run and its outbox row. Returns False when this run_id was already recorded.

    The answer key (`expected`) is kept only when the job has re-test consent, because a re-test can
    only check a replayed run against the same answers; otherwise it is used for the check and dropped.
    """
    job = (
        await session.execute(select(Job).where(Job.project_id == project.project_id, Job.name == body.job))
    ).scalar_one_or_none()
    if job is None:
        raise UnknownJob(body.job)
    keep_expected = body.expected if job.retest_consent and job.check_kind == "ANSWER_KEY" else None

    provider = body.provider.strip().lower() if body.provider else None
    price = await find_price(session, body.model, body.model_version, provider)
    if price is not None:
        cost = compute_cost(price, body.tokens_in, body.tokens_out, body.cache_read_tokens, body.cache_write_tokens)
    else:
        # No catalog price and no cost sent: unknown, not free. Storing 0 would make the model win
        # every cost comparison.
        cost = Decimal(str(body.cost_usd)) if body.cost_usd is not None else None

    result = check_run(job.check_kind, job.check_config, body.output, body.expected)
    state = "CAPTURED" if result.outcome is Outcome.UNKNOWN else "CHECKED"

    digest = prompt_hash(body.prompt)
    inserted = (
        await session.execute(
            insert(Run)
            .values(
                run_id=body.run_id, job_id=job.job_id, project_id=project.project_id, prompt=body.prompt,
                prompt_hash=digest, model=body.model, model_version=body.model_version,
                prompt_version=body.prompt_version, effort=normalize_effort(body.effort), tokens_in=body.tokens_in, tokens_out=body.tokens_out,
                cache_read_tokens=body.cache_read_tokens, cache_write_tokens=body.cache_write_tokens,
                cost_usd=cost, latency_ms=body.latency_ms, output=body.output,
                tool_calls=sanitize_tool_calls(body.tool_calls, keep_arguments=project.store_tool_arguments),
                outcome=result.outcome.value, outcome_reason=result.reason, state=state, run_kind=run_kind,
                retest_id=retest_id, expected=keep_expected, provider=provider,
            )
            .on_conflict_do_nothing(index_elements=["run_id"])
            .returning(Run.run_id)
        )
    ).scalar_one_or_none()
    if inserted is None:
        log.info("duplicate run ignored", extra={"run_id": str(body.run_id), "job_id": str(job.job_id),
                                                 "project_id": project.project_id})
        return False
    log.info(
        "run recorded",
        extra={"run_id": str(body.run_id), "job_id": str(job.job_id), "project_id": project.project_id,
               "model": body.model, "model_version": body.model_version, "outcome": result.outcome.value,
               "from_state": None, "to_state": state, "cost_usd": float(cost) if cost is not None else None},
    )
    session.add(OutboxRow(run_id=body.run_id, op="UPSERT", payload={"run_id": str(body.run_id), "prompt_hash": digest}))
    source = "Re-test runner" if run_kind == "RETEST" else "RunRecorder"
    flow.emit(session, project.project_id, "sdk", f"{source} captured a call to '{body.model}' for '{job.name}'",
              run_id=body.run_id, data={"job": job.name, "model": body.model, "run_kind": run_kind})
    flow.emit(session, project.project_id, "api", "POST /v1/runs accepted: stored and queued for indexing",
              run_id=body.run_id, data={"cost_usd": float(cost) if cost is not None else None,
                                        "tokens_in": body.tokens_in})
    verdict = {"PASS": "Check passed", "FAIL": "Check failed", "UNKNOWN": "Waiting for a label"}[result.outcome.value]
    flow.emit(session, project.project_id, "check", f"{verdict}: {result.reason}" if result.reason else verdict,
              run_id=body.run_id, data={"outcome": result.outcome.value})
    return True


async def label_run(
    session: AsyncSession, project: Project, run_id, outcome: str, reason: str | None
) -> Run:
    """Resolve an UNKNOWN run with a PASS or FAIL supplied later."""
    run = (
        await session.execute(select(Run).where(Run.run_id == run_id, Run.project_id == project.project_id))
    ).scalar_one_or_none()
    if run is None:
        raise UnknownRun(str(run_id))
    if run.outcome != Outcome.UNKNOWN.value:
        raise AlreadyResolved(str(run_id))
    before = run.state
    run.outcome = outcome
    run.outcome_reason = f"labelled {outcome}" + (f": {reason}" if reason else "")
    if run.state == "CAPTURED":
        run.state = "CHECKED"
    log.info("run labelled", extra={"run_id": str(run.run_id), "job_id": str(run.job_id),
                                    "project_id": project.project_id, "outcome": outcome,
                                    "from_state": before, "to_state": run.state})
    return run
