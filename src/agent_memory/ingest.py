"""Write path: define jobs and record runs.

A run and its outbox row are written in one transaction, so there is never a recorded run without
the receipt the sync worker needs, and never a receipt without its run. The caller commits.
The outcome (PASS, FAIL or UNKNOWN, with a reason) is resolved here by the job's checker; it is never
accepted from the client. A run the checker cannot decide stays UNKNOWN until it is labelled later.
"""

from __future__ import annotations

import hashlib
import logging
from datetime import UTC, datetime
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from .checks import CheckResult, Outcome, check_run
from .config import get_settings
from .data_quality import flags_for
from .costing import Price, compute_cost
from .pricing import PARTLY_PRICED, PRICED, modifier_factor, resolve_price
from .usage_ledger import sanitize_raw
from .pipeline import flow
from .options import normalize_effort
from .models import IngestDuplicate, Job, OutboxRow, Project, Run
from .privacy import sanitize_tool_calls
from .schemas import JobCreate, RunCreate
from .security import keyed_prompt_hash


log = logging.getLogger("agent_memory.ingest")


class UnknownJob(LookupError):
    """The run names a job that does not exist in this project."""


class DuplicateJob(ValueError):
    """A job with this name already exists in this project."""


class UnknownRun(LookupError):
    """No run with this id in this project."""


class AlreadyResolved(ValueError):
    """The run already has a PASS or FAIL outcome."""


def plain_prompt_hash(prompt: str) -> str:
    """The unkeyed SHA-256 of the prompt text. Never stored: it is only the first step of prompt_hash, and what rows made before
    keying kept. A plain hash can be guessed back from short or common prompts, which is why it is not stored any more."""
    return hashlib.sha256(prompt.encode("utf8")).hexdigest()


def prompt_hash(prompt: str, project_id: str, secret_key: str | None = None) -> str:
    """Stable key for de-duplicating and caching by prompt text, inside one project. Keyed by the server's secret and the project,
    so a prompt that was deleted after retention cannot be guessed from what is left, and the same prompt in two projects
    gives two different values."""
    return keyed_prompt_hash(project_id, plain_prompt_hash(prompt), get_settings().secret_key if secret_key is None else secret_key)


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


async def update_job_description(session: AsyncSession, job: Job, description: str | None) -> Job:
    """Set or clear a job's description. The caller commits."""
    job.description = description
    await session.flush()
    return job


async def find_price(
    session: AsyncSession, model: str, model_version: str, provider: str | None = None
) -> Price | None:
    """The price in force now for this call, or None when unpriced (see pricing.resolve_price)."""
    return (await resolve_price(session, model, model_version, provider)).price


async def record_run(
    session: AsyncSession, project: Project, body: RunCreate, *, run_kind: str = "PRODUCTION", retest_id=None,
    unknown_reason: str | None = None,
) -> bool:
    """Store a run and its outbox row. Returns False when this run_id was already recorded.

    `unknown_reason` (server-side callers only, never the API) records the run as UNKNOWN without
    checking it, e.g. a re-test answer cut off at its output limit: failing it would blame the model
    for the limit, and passing a partial answer would be worse.

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
    resolution = await resolve_price(session, body.model, body.model_version, provider)
    usage_raw = sanitize_raw(body.usage_raw)
    # A response with no usage block reports nothing: its zero counts are unknown, so pricing them would store
    # $0 ("free"). Such a run keeps an unknown cost unless the caller sent one.
    usage_unreported = body.usage_shape == "none" and not (
        body.tokens_in or body.tokens_out or body.cache_read_tokens or body.cache_write_tokens)
    caller_cost = Decimal(str(body.cost_usd)) if body.cost_usd is not None else None
    factor, unmodelled = modifier_factor(
        body.usage_shape, body.model_version or body.model, usage_raw,
        prompt_tokens=body.tokens_in + body.cache_read_tokens + body.cache_write_tokens)
    version_id = None
    if resolution.price is not None and not usage_unreported:
        cost = compute_cost(resolution.price, body.tokens_in, body.tokens_out, body.cache_read_tokens,
                            body.cache_write_tokens, body.cache_write_1h_tokens, factor or Decimal(1))
        version_id = resolution.version_id
        price_status = PARTLY_PRICED if unmodelled else PRICED
    else:
        # No usable catalog price, or nothing reported: unknown, not free. Storing 0 would make the model win
        # every cost comparison. A cost the caller sent is used and labelled as theirs.
        cost = caller_cost
        price_status = "CALLER_COST" if caller_cost is not None else (
            "NO_USAGE" if usage_unreported else resolution.status)
        factor = None

    if unknown_reason is not None:
        result = CheckResult(Outcome.UNKNOWN, unknown_reason)
    else:
        result = check_run(job.check_kind, job.check_config, body.output, body.expected)
    state = "CAPTURED" if result.outcome is Outcome.UNKNOWN else "CHECKED"

    digest = prompt_hash(body.prompt, project.project_id)
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
                agent=body.agent, feature=body.feature, trace_id=body.trace_id, span_id=body.span_id, parent_span_id=body.parent_span_id,
                tools_tokens=body.tools_tokens,
                tool_call_count=len(body.tool_calls) if body.tool_calls is not None else None,
                usage_shape=body.usage_shape, usage_raw=usage_raw, reasoning_tokens=body.reasoning_tokens,
                price_version_id=version_id, price_status=price_status, price_factor=factor,
                cache_write_1h_tokens=body.cache_write_1h_tokens or None,
                tool_use_input_tokens=body.tool_use_input_tokens,
                data_flags=flags_for(usage_raw=usage_raw, tokens_out=body.tokens_out, reasoning_tokens=body.reasoning_tokens,
                                     cache_write_tokens=body.cache_write_tokens, cache_write_1h_tokens=body.cache_write_1h_tokens) or None,
            )
            .on_conflict_do_nothing(index_elements=["run_id"])
            .returning(Run.run_id)
        )
    ).scalar_one_or_none()
    if inserted is None:
        # The same call arrived again (an SDK retry, a replayed delivery). It is ignored, as before, and now counted per project and UTC day.
        await session.execute(
            insert(IngestDuplicate).values(project_id=project.project_id, day=datetime.now(UTC).date(), duplicates=1)
            .on_conflict_do_update(index_elements=["project_id", "day"], set_={"duplicates": IngestDuplicate.duplicates + 1}))
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
    source = "Trial runner" if run_kind == "RETEST" else "RunRecorder"
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
