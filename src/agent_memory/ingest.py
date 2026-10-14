"""Write path: define jobs and record runs.

A run and its outbox row are written in one transaction, so there is never a recorded run without
the receipt the sync worker needs, and never a receipt without its run. The caller commits.
The outcome (PASS, FAIL or UNKNOWN, with a reason) is resolved here by the job's checker; it is never
accepted from the client. A run the checker cannot decide stays UNKNOWN until it is labelled later.
"""

from __future__ import annotations

import hashlib
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from .checks import Outcome, check_run
from .costing import Price, compute_cost
from .models import CatalogEntry, Job, OutboxRow, Project, Run
from .schemas import JobCreate, RunCreate
from .versions import normalize


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


async def find_price(session: AsyncSession, model: str, model_version: str) -> Price | None:
    """The catalog price for this call, or None when unpriced.

    Tries the provider-resolved version first (usually the full dated name), then the model that was
    asked for (the alias), after normalising both.
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
    if not rows:
        return None
    best = min(rows, key=lambda r: (candidates.index(r.model), -r.first_seen_at.timestamp()))
    return Price.from_input_output(best.price_in_per_mtok, best.price_out_per_mtok)


async def record_run(session: AsyncSession, project: Project, body: RunCreate) -> bool:
    """Store a run and its outbox row. Returns False when this run_id was already recorded."""
    job = (
        await session.execute(select(Job).where(Job.project_id == project.project_id, Job.name == body.job))
    ).scalar_one_or_none()
    if job is None:
        raise UnknownJob(body.job)

    price = await find_price(session, body.model, body.model_version)
    if price is not None:
        cost = compute_cost(price, body.tokens_in, body.tokens_out, body.cache_read_tokens, body.cache_write_tokens)
    else:
        cost = Decimal(str(body.cost_usd)) if body.cost_usd is not None else Decimal(0)

    result = check_run(job.check_kind, job.check_config, body.output, body.expected)
    state = "CAPTURED" if result.outcome is Outcome.UNKNOWN else "CHECKED"

    digest = prompt_hash(body.prompt)
    inserted = (
        await session.execute(
            insert(Run)
            .values(
                run_id=body.run_id, job_id=job.job_id, project_id=project.project_id, prompt=body.prompt,
                prompt_hash=digest, model=body.model, model_version=body.model_version,
                prompt_version=body.prompt_version, tokens_in=body.tokens_in, tokens_out=body.tokens_out,
                cache_read_tokens=body.cache_read_tokens, cache_write_tokens=body.cache_write_tokens,
                cost_usd=cost, latency_ms=body.latency_ms, output=body.output, tool_calls=body.tool_calls,
                outcome=result.outcome.value, outcome_reason=result.reason, state=state,
            )
            .on_conflict_do_nothing(index_elements=["run_id"])
            .returning(Run.run_id)
        )
    ).scalar_one_or_none()
    if inserted is None:
        return False
    session.add(OutboxRow(run_id=body.run_id, op="UPSERT", payload={"run_id": str(body.run_id), "prompt_hash": digest}))
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
    run.outcome = outcome
    run.outcome_reason = f"labelled {outcome}" + (f": {reason}" if reason else "")
    if run.state == "CAPTURED":
        run.state = "CHECKED"
    return run
