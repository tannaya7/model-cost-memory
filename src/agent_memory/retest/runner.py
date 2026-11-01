"""RetestRunner: replays importance-sampled past runs on a candidate model, under a budget.

The only component that spends money, so the controls come first:

- **Consent.** The job's re-test consent and the project's re-test switch must both be on: replaying a
  prompt sends it to a provider. Only jobs checked automatically (answer key or schema) are re-tested,
  and an answer-key run is replayable only if its answers were kept (they are, with consent).
- **The customer's key.** Re-tests run on the customer's own provider key, asked for when a re-test
  is first needed (`keys.py`). It is never logged.
- **Budget and cap, before every call.** A re-test refuses to start without a positive budget. Before
  each provider call the expected cost of that call (catalog price x the source run's tokens) is
  reserved; the call is made only if the re-test stays within its budget and the project within its
  monthly cap, which counts at catalog list price, so it limits testing on free keys too. A model
  with no known price is never re-tested: its calls would count as free and no limit would hold.
- **Dedupe.** A prompt already replayed on this candidate is never replayed on it again.

Sampling is weighted by each run's importance (failures and expensive runs first), without
replacement. Calls run a few at a time (`retest_concurrency`), and every result is recorded as an
ordinary RETEST run the moment it arrives, so progress is visible while it runs. Every
EARLY_CHECK_EVERY results the engine is asked how the candidate stands; once it is clearly worse, or
already good enough, the re-test stops and keeps the rest of its budget. The stop and the budget
are checked when a call gets its slot, not when it is queued, so at most `retest_concurrency` calls
are in flight past a stop.

Started four ways (technical plan 3.5): a person (`MANUAL`), a new model in the catalog
(`NEW_MODEL`), the engine being unsure about a cheaper model (`UNSURE`), or the provider key being
added for the first time (`FIRST_KEY`), so a job that has only ever used one model is compared with
a cheaper one without anyone asking.
"""

from __future__ import annotations

import asyncio
import logging
import random
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import distinct_on
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from ..config import Settings, get_settings
from ..costing import compute_cost
from ..ingest import find_price, record_run
from ..models import Job, Project, ProviderKey, ProviderPrice, Retest, Run
from ..recommend.engine import recommend
from ..recorder import read_response
from ..schemas import RunCreate
from ..versions import family, normalize
from .keys import client_for
from .provider import ProviderClient, ProviderError, RateLimited

log = logging.getLogger("agent_memory.retest")

ACTIVE = ("QUEUED", "RUNNING")
CHECKABLE = ("ANSWER_KEY", "SCHEMA")
EARLY_CHECK_EVERY = 10
INTERRUPTED_AFTER = timedelta(hours=1)


class RetestRefused(ValueError):
    """A re-test cannot start. `code` lets the web app react (e.g. ask for the provider key)."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def month_start(now: datetime) -> datetime:
    return now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)


async def spent_this_month(session: AsyncSession, project_id: str, now: datetime | None = None) -> Decimal:
    """Re-test spend this calendar month (UTC), at catalog list price."""
    now = now or datetime.now(UTC)
    total = (
        await session.execute(
            select(func.coalesce(func.sum(Run.cost_usd), 0))
            .where(Run.project_id == project_id, Run.run_kind == "RETEST", Run.created_at >= month_start(now))
        )
    ).scalar_one()
    return Decimal(total)


async def enqueue(
    session: AsyncSession, project: Project, job: Job, candidate_model: str, budget_usd: float | Decimal, trigger: str,
    *, now: datetime | None = None,
) -> Retest:
    """Check every precondition and queue a re-test. Raises RetestRefused with a reason."""
    now = now or datetime.now(UTC)
    if not job.retest_consent:
        raise RetestRefused("consent_off", f"Re-tests are off for '{job.name}': turn on its re-test consent first")
    if not project.retest_allowed:
        raise RetestRefused("project_off", "Re-tests are switched off for this project")
    if job.check_kind not in CHECKABLE:
        raise RetestRefused(
            "not_checkable", "Only jobs checked automatically (answer key or schema) can be re-tested")
    if Decimal(str(budget_usd)) <= 0:
        raise RetestRefused("budget_required", "A re-test needs a budget above zero")
    key = await session.get(ProviderKey, project.project_id)
    if key is None:
        raise RetestRefused("provider_key_required", "Add the provider key re-tests should use")
    if await find_price(session, candidate_model, candidate_model, key.provider) is None:
        raise RetestRefused(
            "no_price", f"No price is known for {candidate_model}, so the budget and the monthly cap could not "
            "hold: every call would count as free. Add its price to the catalog first")
    if Decimal(project.retest_monthly_cap_usd) - await spent_this_month(session, project.project_id, now) <= 0:
        raise RetestRefused("cap_reached", "This month's re-test cap is used up")
    running = (
        await session.execute(
            select(Retest.retest_id).where(Retest.job_id == job.job_id, Retest.status.in_(ACTIVE),
                                           Retest.candidate_model == candidate_model)
        )
    ).first()
    if running:
        raise RetestRefused("already_running", f"A re-test of {candidate_model} is already running for this job")
    retest = Retest(job_id=job.job_id, project_id=project.project_id, candidate_model=candidate_model,
                    trigger=trigger, budget_usd=Decimal(str(budget_usd)), status="QUEUED", created_at=now)
    session.add(retest)
    await session.flush()
    log.info("re-test queued", extra={"retest_id": str(retest.retest_id), "job_id": str(job.job_id),
                                      "project_id": project.project_id, "candidate": candidate_model,
                                      "trigger": trigger, "budget_usd": float(budget_usd)})
    return retest


async def sample_sources(
    session: AsyncSession, job: Job, candidate_model: str, n: int, *, seed: int = 0
) -> list:
    """Up to n past production runs to replay, one per prompt, weighted by importance, skipping prompts
    already replayed on this candidate."""
    already = select(Run.prompt_hash).where(
        Run.job_id == job.job_id, Run.run_kind == "RETEST", func.lower(Run.model) == normalize(candidate_model)
    )
    query = (
        select(Run.run_id, Run.prompt, Run.prompt_hash, Run.expected, Run.tokens_in, Run.tokens_out,
               Run.importance_score)
        .where(Run.job_id == job.job_id, Run.run_kind == "PRODUCTION", Run.outcome.in_(("PASS", "FAIL")),
               Run.invalid_at.is_(None), Run.prompt_hash.not_in(already))
        .ext(distinct_on(Run.prompt_hash)).order_by(Run.prompt_hash, Run.created_at.desc())
    )
    if job.check_kind == "ANSWER_KEY":
        query = query.where(Run.expected.is_not(None))
    rows = (await session.execute(query)).all()
    rng = random.Random(seed)
    # Efraimidis-Spirakis: key = u^(1/w); the n largest keys are a weighted sample without replacement.
    keyed = sorted(rows, key=lambda r: rng.random() ** (1 / max(r.importance_score or 1.0, 1e-6)), reverse=True)
    return keyed[:n]


@dataclass
class _Progress:
    reserved: Decimal = Decimal(0)
    done: int = 0
    stop_status: str | None = None
    stop_message: str | None = None


async def run_retest(
    sessions: async_sessionmaker[AsyncSession], retest_id: uuid.UUID, *, settings: Settings | None = None,
    client_factory: Callable[[ProviderKey, Settings], ProviderClient] = client_for,
    sample_size: int | None = None,
) -> Retest:
    """Run one queued re-test to the end. Returns its final row."""
    settings = settings or get_settings()
    async with sessions() as session:
        retest = await session.get(Retest, retest_id)
        job = await session.get(Job, retest.job_id)
        project = await session.get(Project, retest.project_id)
        key = await session.get(ProviderKey, retest.project_id)
        wanted = sample_size or retest.runs_planned or settings.retest_default_sample
        sources = await sample_sources(session, job, retest.candidate_model, wanted, seed=retest_id.int % 2**32)
        price = await find_price(session, retest.candidate_model, retest.candidate_model,
                                 key.provider if key else None)
        retest.status, retest.started_at, retest.runs_planned = "RUNNING", datetime.now(UTC), len(sources)
        await session.commit()
        budget, cap = Decimal(retest.budget_usd), Decimal(project.retest_monthly_cap_usd)
    if not sources:
        return await _finish(sessions, retest_id, "DONE", "No past runs can be replayed: each needs a check the "
                             "runner can repeat, and none may have been replayed on this model already")
    if key is None:
        return await _finish(sessions, retest_id, "FAILED", "The provider key was removed")
    if price is None:
        return await _finish(sessions, retest_id, "FAILED", f"No price is known for {retest.candidate_model}, so "
                             "the budget and the monthly cap could not hold; nothing was replayed")

    client = client_factory(key, settings)
    progress = _Progress()
    lock = asyncio.Lock()
    gate = asyncio.Semaphore(max(settings.retest_concurrency, 1))
    candidate_family = family(retest.candidate_model)

    async def one(src) -> None:
        # The slot comes first: every source is queued at once, so a stop or budget check made before
        # waiting for a slot would pass them all before the first result could stop anything.
        async with gate:
            await replay(src)

    async def replay(src) -> None:
        cost = compute_cost(price, src.tokens_in, src.tokens_out)
        async with lock:
            if progress.stop_status:
                return
            async with sessions() as s:
                row = await s.get(Retest, retest_id)
                month = await spent_this_month(s, row.project_id)
                if Decimal(row.spent_usd) + progress.reserved + cost > budget:
                    progress.stop_status, progress.stop_message = "STOPPED_BUDGET", (
                        f"Stopped at the budget of ${budget:.2f}: the next run would have gone over it")
                    return
                if month + progress.reserved + cost > cap:
                    progress.stop_status, progress.stop_message = "STOPPED_CAP", (
                        f"Stopped at this month's re-test cap of ${cap:.2f}")
                    return
            progress.reserved += cost
        try:
            started = datetime.now(UTC)
            response = await client.complete(retest.candidate_model, src.prompt)
            latency = int((datetime.now(UTC) - started).total_seconds() * 1000)
        except (RateLimited, ProviderError) as exc:
            async with lock:
                progress.reserved -= cost
                if not progress.stop_status:
                    progress.stop_status = "FAILED"
                    progress.stop_message = ("The provider kept refusing with 'too many requests'; partial results kept"
                                             if isinstance(exc, RateLimited)
                                             else "The provider returned an error; partial results kept")
            log.warning("re-test call failed", extra={"retest_id": str(retest_id), "error": type(exc).__name__})
            return

        parsed = read_response(response)
        body = RunCreate(
            run_id=uuid.uuid4(), job=job.name, prompt=src.prompt, model=retest.candidate_model, provider=key.provider,
            model_version=parsed.get("model_version") or retest.candidate_model,
            tokens_in=parsed.get("tokens_in", 0), tokens_out=parsed.get("tokens_out", 0),
            cache_read_tokens=parsed.get("cache_read_tokens", 0), cache_write_tokens=parsed.get("cache_write_tokens", 0),
            latency_ms=latency, output=parsed.get("output"), expected=src.expected,
        )
        # Recording the run and releasing its reservation happen together, so the cap check never
        # counts a finished call twice (once as spent, once as reserved).
        async with lock:
            async with sessions() as s:
                owner = await s.get(Project, project.project_id)
                await record_run(s, owner, body, run_kind="RETEST", retest_id=retest_id)
                await s.commit()
                run = await s.get(Run, body.run_id)
            progress.reserved -= cost
            progress.done += 1
            async with sessions() as s:
                row = await s.get(Retest, retest_id, with_for_update=True)
                row.runs_done += 1
                row.passed += run.outcome == "PASS"
                row.failed += run.outcome == "FAIL"
                # A version priced differently from its alias still counts; never as free.
                row.spent_usd = Decimal(row.spent_usd) + (Decimal(run.cost_usd) if run.cost_usd is not None else cost)
                await s.commit()
            if progress.done % EARLY_CHECK_EVERY == 0 and not progress.stop_status:
                await early_check()

    async def early_check() -> None:
        async with sessions() as s:
            result = await recommend(s, await s.get(Job, job.job_id), settings=settings)
        status = next((m.status for m in result.decision.models if m.model == candidate_family), None)
        reference = result.decision.reference.model if result.decision.reference else "the best model"
        if status == "CLEARLY_WORSE":
            progress.stop_status, progress.stop_message = "DONE", (
                f"Stopped early: clearly worse than {reference}, so the rest of the budget was kept")
        elif status == "GOOD_ENOUGH":
            progress.stop_status, progress.stop_message = "DONE", (
                f"Stopped early: already good enough compared with {reference}")

    await asyncio.gather(*(one(src) for src in sources))
    return await _finish(sessions, retest_id, progress.stop_status or "DONE", progress.stop_message)


async def _finish(sessions, retest_id, status: str, message: str | None) -> Retest:
    async with sessions() as session:
        row = await session.get(Retest, retest_id)
        row.status, row.finished_at = status, datetime.now(UTC)
        row.message = message or (f"Replayed {row.runs_done} runs: {row.passed} passed, {row.failed} failed")
        await session.commit()
        log.info("re-test finished", extra={"retest_id": str(retest_id), "status": status, "runs": row.runs_done,
                                            "spent_usd": float(row.spent_usd), "project_id": row.project_id})
        return row


async def run_queued(
    sessions: async_sessionmaker[AsyncSession], *, settings: Settings | None = None,
    client_factory: Callable[[ProviderKey, Settings], ProviderClient] = client_for,
) -> int:
    """Run every queued re-test, oldest first (the scheduler calls this). Returns how many ran.
    A re-test left RUNNING by a crashed process is closed as FAILED with its partial results."""
    settings = settings or get_settings()
    async with sessions() as session:
        stale = (
            await session.execute(
                select(Retest).where(Retest.status == "RUNNING",
                                     Retest.started_at < datetime.now(UTC) - INTERRUPTED_AFTER)
            )
        ).scalars().all()
        for row in stale:
            row.status, row.finished_at = "FAILED", datetime.now(UTC)
            row.message = "Interrupted (the server restarted); partial results kept"
        await session.commit()
    ran = 0
    while True:
        async with sessions() as session:
            claimed = (
                await session.execute(
                    select(Retest.retest_id).where(Retest.status == "QUEUED").order_by(Retest.created_at)
                    .limit(1).with_for_update(skip_locked=True)
                )
            ).scalar_one_or_none()
            if claimed is None:
                return ran
            row = await session.get(Retest, claimed)
            row.status = "RUNNING"
            await session.commit()
        await run_retest(sessions, claimed, settings=settings, client_factory=client_factory)
        ran += 1


async def _cap_left(session: AsyncSession, project: Project) -> Decimal:
    return Decimal(project.retest_monthly_cap_usd) - await spent_this_month(session, project.project_id)


async def _eligible_jobs(session: AsyncSession):
    """(project, job, key) for every job that may be re-tested automatically."""
    return (
        await session.execute(
            select(Project, Job, ProviderKey)
            .join(Job, Job.project_id == Project.project_id)
            .join(ProviderKey, ProviderKey.project_id == Project.project_id)
            .where(Project.retest_allowed.is_(True), Job.retest_consent.is_(True), Job.check_kind.in_(CHECKABLE))
        )
    ).all()


async def start_for_new_models(
    session: AsyncSession, added: list, *, settings: Settings | None = None, per_job: int = 3
) -> list[Retest]:
    """A new model in the catalog gets evidence without anyone asking: for each eligible job, re-test
    the cheapest new models from the provider its key reaches that cost less than the current model."""
    settings = settings or get_settings()
    started: list[Retest] = []
    for project, job, key in await _eligible_jobs(session):
        result = await recommend(session, job, settings=settings)
        current = result.decision.current
        if current is None or current.mean_cost_usd is None:
            continue
        typical_in, typical_out = (
            await session.execute(
                select(func.avg(Run.tokens_in), func.avg(Run.tokens_out)).where(Run.job_id == job.job_id)
            )
        ).one()
        cheaper = []
        for rec in added:
            if rec.provider != key.provider or rec.status != "ACTIVE" or rec.price_in_per_mtok is None:
                continue
            per_run = (Decimal(typical_in or 0) * rec.price_in_per_mtok
                       + Decimal(typical_out or 0) * (rec.price_out_per_mtok or 0)) / 1_000_000
            if per_run < Decimal(str(current.mean_cost_usd)):
                cheaper.append((per_run, rec.model))
        for _, model in sorted(cheaper)[:per_job]:
            left = await _cap_left(session, project)
            if left <= 0:
                break
            try:
                started.append(await enqueue(session, project, job, model,
                                             min(Decimal(str(settings.retest_auto_budget_usd)), left), "NEW_MODEL"))
            except RetestRefused:
                continue
    await session.commit()
    return started


async def _typical_tokens(session: AsyncSession, job: Job) -> tuple[Decimal, Decimal]:
    tokens_in, tokens_out = (
        await session.execute(
            select(func.avg(Run.tokens_in), func.avg(Run.tokens_out)).where(Run.job_id == job.job_id)
        )
    ).one()
    return Decimal(tokens_in or 0), Decimal(tokens_out or 0)


def first_key_candidate(current_cost: Decimal, offers: list[tuple[str, Decimal]]) -> str | None:
    """Which cheaper model a job that has only used one model is first compared with. `offers` are
    (model, cost per run at the job's typical size). The priciest model that costs at most half as much:
    a saving worth switching for, and of those the likeliest to do the job. When none costs half as
    much, the priciest that costs less at all."""
    cheaper = [(cost, model) for model, cost in offers if cost < current_cost]
    halved = [(cost, model) for cost, model in cheaper if cost <= current_cost / 2]
    pool = halved or cheaper
    return max(pool)[1] if pool else None


async def start_on_first_key(session: AsyncSession, project: Project, *, settings: Settings | None = None,
                             today: date | None = None) -> list[Retest]:
    """The provider key was just given. A job that has only ever used one model gets nothing from the
    other triggers: no cheaper model is measured, so the engine is never unsure about one, and a new
    catalog model may never arrive. So each such job gets one re-test of a cheaper model the key's
    provider serves, once per job (removing and re-adding the key does not repeat it)."""
    settings = settings or get_settings()
    today = today or datetime.now(UTC).date()
    key = await session.get(ProviderKey, project.project_id)
    if key is None or not project.retest_allowed:
        return []
    served = (
        await session.execute(
            select(ProviderPrice).where(
                ProviderPrice.provider == key.provider, ProviderPrice.price_in_per_mtok.is_not(None),
                ProviderPrice.price_out_per_mtok.is_not(None),
                ProviderPrice.shutdown_date.is_(None) | (ProviderPrice.shutdown_date > today),
            )
        )
    ).scalars().all()
    started: list[Retest] = []
    for job in (await session.execute(select(Job).where(
            Job.project_id == project.project_id, Job.retest_consent.is_(True), Job.check_kind.in_(CHECKABLE),
    ))).scalars().all():
        done_before = (
            await session.execute(select(Retest.retest_id).where(Retest.job_id == job.job_id,
                                                                 Retest.trigger == "FIRST_KEY"))
        ).first()
        if done_before:
            continue
        decision = (await recommend(session, job, settings=settings)).decision
        current = decision.current
        if current is None or current.mean_cost_usd is None or len(decision.models) > 1:
            continue
        tokens_in, tokens_out = await _typical_tokens(session, job)
        offers = [(p.model, (tokens_in * p.price_in_per_mtok + tokens_out * p.price_out_per_mtok) / 1_000_000)
                  for p in served if family(p.model) != current.model]
        model = first_key_candidate(Decimal(str(current.mean_cost_usd)), offers)
        left = await _cap_left(session, project)
        if model is None or left <= 0:
            continue
        try:
            started.append(await enqueue(session, project, job, model,
                                         min(Decimal(str(settings.retest_auto_budget_usd)), left), "FIRST_KEY"))
        except RetestRefused:
            continue
    await session.commit()
    return started


async def start_when_unsure(session: AsyncSession, *, settings: Settings | None = None,
                            quiet_days: int = 7) -> list[Retest]:
    """The engine is unsure whether to switch: re-test the model that would settle it (a cheaper candidate,
    or the best model when the current one measures worse), at most once a week per model."""
    settings = settings or get_settings()
    started: list[Retest] = []
    since = datetime.now(UTC) - timedelta(days=quiet_days)
    for project, job, _ in await _eligible_jobs(session):
        result = await recommend(session, job, settings=settings)
        for candidate in result.decision.retest_candidates:
            requested = (
                await session.execute(
                    select(Run.model).where(Run.job_id == job.job_id).order_by(Run.created_at.desc())
                    .where(func.lower(Run.model_version).like(f"{candidate.lower()}%")
                           | (func.lower(Run.model) == candidate.lower()))
                    .limit(1)
                )
            ).scalar_one_or_none() or candidate
            recent = (
                await session.execute(
                    select(Retest.retest_id).where(Retest.job_id == job.job_id, Retest.created_at >= since,
                                                   func.lower(Retest.candidate_model) == requested.lower())
                )
            ).first()
            left = await _cap_left(session, project)
            if recent or left <= 0:
                continue
            try:
                started.append(await enqueue(session, project, job, requested,
                                             min(Decimal(str(settings.retest_auto_budget_usd)), left), "UNSURE"))
            except RetestRefused:
                continue
    await session.commit()
    return started
