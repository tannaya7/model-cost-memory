"""FastAPI routes: ingest, recommendation, regressions, history, re-test, catalog, insights.

Stateless: every request opens its own database session. Every `/v1` route acts on one project and
only ever sees that project's data: the one whose key is sent (`X-API-Key: <key>` or
`Authorization: Bearer <key>`), or, for a signed-in user, the one they own named in `X-Project-Id`
(auth/access.py). Sign-in and project setup routes live in auth/routes.py.
The endpoints are listed in docs/ARCHITECTURE.md and added week by week.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import json
import re
import logging
import secrets
import uuid
from collections import defaultdict
from dataclasses import asdict
from typing import Literal
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from decimal import Decimal

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse
from sqlalchemy import func, select, text, tuple_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from starlette.middleware.sessions import SessionMiddleware

from . import __version__, ingest
from .db import dispose_engine, get_session
from .exports import COST_BASIS, PROJECT_COLUMNS, PROJECT_TEXT, csv_file, write_csv
from .insights.agents import agent_insights
from .insights.savings import savings as savings_insight
from .insights.changes import DAYS as CHANGE_DAYS
from .insights.agent_tree import METHOD as AGENT_METHOD
from .insights.agent_tree import MIN_COHORT as AGENT_MIN_COHORT
from .insights.agent_tree import REPEAT_CHOICES as AGENT_REPEAT_CHOICES
from .insights.agent_tree import WINDOW_CHOICES as AGENT_WINDOW_CHOICES
from .insights.agent_tree import agent_task as agent_task_insight
from .insights.agent_tree import agent_tasks as agent_tasks_insight
from .insights.changes import what_changed
from .insights.tool_servers import DAYS as TOOL_DAYS
from .insights.tool_servers import tool_servers as tool_servers_insight
from .insights.prompt_versions import prompt_versions
from .insights.prompts import prompt_insights
from .insights.projection import month_projection
from .notices.service import BY_ID, PROVIDER_NAMES, STALE_AFTER, project_notices
from .insights.receipt import cost_receipt
from .insights.service import daily as insights_daily
from .insights.service import job_insights, spend_by_job
from .logging_config import configure_logging, set_context
from .limits import forecast as limit_forecast
from .models import Alert, CatalogEntry, Job, PriceVersion, Project, ProviderKey, Retest, Run, UsageLimit, User
from .recommend.cache import cached_recommend
from .recommend.engine import JobRecommendation, ModelEvidence
from .catalog.official import CATALOG_SOURCE, reference_for
from .catalog.official import STALE_AFTER as OFFICIAL_STALE_AFTER
from .catalog.official import load as load_official
from .recommend.evidence import basis_for
from .recommend.stats import assess, difference, z_for
from .insights.task_profile import MIN_CALLS, task_profile
from .recommend.summary import summarize
from .recommend.task_summary import delete_project_summaries, delete_summary, provider_name, task_summary_state
from .retest import keys as provider_keys
from .retest.confirm import build_preview, conclusion, read_token, single_use_hash
from .retest.runner import RetestRefused, enqueue, spent_this_month, start_on_first_key
from .schemas import (
    TaskProfileOut,
    TaskSummaryConsentIn,
    TaskSummaryOut,
    AgentInsightsOut,
    AgentUsageOut,
    LoopOut,
    ToolCountOut,
    UsageKindsOut,
    ToolsUsageOut,
    TraceUsageOut,
    DayPointOut,
    AlertOut,
    BreakdownOut,
    FlowEventOut,
    ForecastOut,
    Health,
    NewsItemOut,
    NewsOut,
    NewsRefreshOut,
    NewsSourceOut,
    SchedulerHealth,
    HistoryEntryOut,
    HistoryOut,
    JobCreate,
    JobInsightsOut,
    JobOut,
    JobPatch,
    LabelCreate,
    LimitSuggestionOut,
    ModelEvidenceOut,
    ModelOut,
    ModelPage,
    ModelReferenceOut,
    PriceSourceOut,
    TaskTotalsOut,
    TaskStructureOut,
    TaskNodeOut,
    SpreadOut,
    RepeatedCallOut,
    RepeatedCallItemOut,
    CohortSideOut,
    CohortOut,
    AgentTasksOut,
    AgentTaskSummaryOut,
    AgentTaskOut,
    ToolServersOut,
    ModelRef,
    ModelVersionSeen,
    PromptComparisonOut,
    PromptGroupOut,
    PromptsOut,
    PromptVersionOut,
    PromptVersionsOut,
    ProviderKeyIn,
    ProviderKeyOut,
    CatalogInfoOut,
    ChangesOut,
    DifferenceOut,
    PairedOut,
    RecommendationEvidence,
    PromisingOut,
    RecommendationOut,
    SureEnoughOut,
    RecommendationRules,
    RetestCreate,
    RetestLimits,
    RetestPreviewOut,
    SavingsEntry,
    SavingsOut,
    SavingsTotal,
    RetestPreviewRequest,
    RetestOut,
    RunAccepted,
    RunCreate,
    RunDetail,
    CostReceiptOut,
    NoticeElsewhereOut,
    NoticeOut,
    NoticesOut,
    NoticeSourceOut,
    ProjectionOut,
    RunOut,
    RunPage,
    SpendOut,
    UsageLimitIn,
    UsageLimitOut,
    UsedPercentIn,
)
from .auth import orgs as orgs_routes
from .auth import privacy as privacy_routes
from .auth import routes as auth_routes
from .auth.access import can_see_content, current_project, optional_user, signed_in_project
from .auth.permissions import role_can
from .config import check_startup, get_settings
from .csrf import CsrfMiddleware
from .heartbeat import overdue
from .news import service as news_service
from .news.feeds import FEEDS as NEWS_FEEDS
from .ratelimit import DAILY_RUNS, STREAMS, RateLimitMiddleware
from .security import SecretKeyMissing, session_secret
from .pipeline import flow
from .pipeline.flow_hub import HUB, Overflowed
from .pipeline.decay import current_versions, family_key
from .pipeline.scoring import age_days, freshness, stability_days
from .storage import lineage
from .versions import normalize

PREVIEW_CHARS = 200
MAX_JOBS_PER_PROJECT = 500  # generous: a project has a few dozen tasks; this stops runaway creation
log = logging.getLogger("agent_memory.api")


@asynccontextmanager
async def lifespan(_: FastAPI):
    configure_logging()
    check_startup()  # refuses an unsafe public configuration (config.startup_problems)
    yield
    await dispose_engine()


app = FastAPI(title="Model & Cost Memory API", version=__version__, lifespan=lifespan)


def _session_secret() -> str:
    secret = get_settings().secret_key
    if not secret:
        log.warning("SECRET_KEY is not set: sign-in sessions will not survive a restart")
        return secrets.token_urlsafe(32)
    return session_secret(secret)


# The signed session cookie: httpOnly (Starlette's default), SameSite=Lax, Secure on an https site.
app.add_middleware(
    SessionMiddleware, secret_key=_session_secret(), session_cookie="mcm_session", same_site="lax",
    https_only=get_settings().public_url.startswith("https://"), max_age=14 * 24 * 3600,
)
app.add_middleware(CsrfMiddleware)  # a changing request with the sign-in cookie must come from this site
app.add_middleware(RateLimitMiddleware)  # added last, so it runs first: refused requests do no work
app.include_router(auth_routes.router)
app.include_router(orgs_routes.router)
app.include_router(privacy_routes.router)


@app.get("/healthz", response_model=Health, tags=["system"])
async def healthz(session: AsyncSession = Depends(get_session)) -> Health:
    await session.execute(text("SELECT 1"))
    return Health(status="ok")


@app.get("/healthz/scheduler", response_model=SchedulerHealth, tags=["system"],
         responses={503: {"model": SchedulerHealth, "description": "A scheduled job is overdue"}})
async def scheduler_health(session: AsyncSession = Depends(get_session)) -> JSONResponse:
    """Is the scheduler keeping up? 503 when any job has had no success within its allowance, so an
    uptime monitor can alert on it. Shows job names and ages only, never error text."""
    late = await overdue(session)
    body = SchedulerHealth(status="overdue" if late else "ok", overdue=late)
    return JSONResponse(body.model_dump(), status_code=503 if late else 200)


@app.get("/v1/jobs", response_model=list[JobOut], tags=["jobs"])
async def list_jobs(
    project: Project = Depends(current_project), session: AsyncSession = Depends(get_session)
) -> list[JobOut]:
    """Every job in the project, with how many runs it has, in total and per state."""
    jobs = (
        await session.execute(select(Job).where(Job.project_id == project.project_id).order_by(Job.name))
    ).scalars().all()
    counts = (
        await session.execute(
            select(Run.job_id, Run.state, func.count())
            .where(Run.project_id == project.project_id)
            .group_by(Run.job_id, Run.state)
        )
    ).all()
    by_job: dict = defaultdict(dict)
    for job_id, state, n in counts:
        by_job[job_id][state] = n
    return [
        JobOut(
            job_id=j.job_id, name=j.name, description=j.description, check_kind=j.check_kind,
            check_config=j.check_config, retest_consent=j.retest_consent,
            run_count=sum(by_job[j.job_id].values()), runs_by_state=by_job[j.job_id],
        )
        for j in jobs
    ]


async def _weights(session: AsyncSession, runs: list[Run], now: datetime | None = None) -> dict:
    """Each run's weight in the recommendation now, as the engine counts it: its age, and whether its
    version has been replaced (superseded versions fade faster)."""
    settings, now = get_settings(), now or datetime.now(UTC)
    current: dict = {}
    for job_id in {r.job_id for r in runs}:
        current.update(await current_versions(session, job_id))
    out = {}
    for r in runs:
        version = normalize(r.model_version)
        superseded = version != current.get((r.job_id, family_key(r.model, r.model_version)), version)
        stability = stability_days(1.0, superseded=superseded, base_days=settings.decay_base_days,
                                   superseded_factor=settings.version_factor_superseded)
        out[r.run_id] = freshness(age_days(r.created_at, now), stability)
    return out


def _run_fields(r: Run, job_name: str, weight: float | None = None) -> dict:
    return dict(
        run_id=r.run_id, job_id=r.job_id, job=job_name, model=r.model, model_version=r.model_version,
        prompt_version=r.prompt_version, effort=r.effort, agent=r.agent, trace_id=r.trace_id, span_id=r.span_id,
        parent_span_id=r.parent_span_id,
        tools_tokens=r.tools_tokens, tool_call_count=r.tool_call_count, tokens_in=r.tokens_in, tokens_out=r.tokens_out,
        cache_read_tokens=r.cache_read_tokens, cache_write_tokens=r.cache_write_tokens,
        usage_shape=r.usage_shape, reasoning_tokens=r.reasoning_tokens, tool_use_input_tokens=r.tool_use_input_tokens,
        price_status=r.price_status,
        cost_usd=float(r.cost_usd) if r.cost_usd is not None else None, latency_ms=r.latency_ms, outcome=r.outcome,
        outcome_reason=r.outcome_reason, run_kind=r.run_kind, state=r.state, created_at=r.created_at,
        prompt_preview=r.prompt[:PREVIEW_CHARS] if r.prompt is not None else None,
        output_preview=r.output[:PREVIEW_CHARS] if r.output is not None else None,
        importance_score=float(r.importance_score), weight=weight, content_removed_at=r.content_removed_at,
    )


LIST_PREVIEW_CHARS = 240
_PREVIEW_SCAN = 4000  # raw characters looked at before collapsing whitespace


def _list_preview(text_: str | None) -> str | None:
    """First 240 characters, whitespace collapsed, with an ellipsis when cut; null when not stored."""
    if text_ is None:
        return None
    collapsed = " ".join(text_[:_PREVIEW_SCAN].split())
    if len(collapsed) > LIST_PREVIEW_CHARS or len(text_) > _PREVIEW_SCAN:
        return collapsed[:LIST_PREVIEW_CHARS].rstrip() + "…"
    return collapsed


def _run_out(r: Run, job_name: str, weight: float | None = None) -> RunOut:
    fields = _run_fields(r, job_name, weight)
    removed = r.content_removed_at is not None
    fields["prompt_preview"] = None if removed else _list_preview(r.prompt)
    fields["output_preview"] = None if removed else _list_preview(r.output)
    return RunOut(**fields)


@app.patch("/v1/jobs/{job}", response_model=JobOut, tags=["jobs"])
async def patch_job_endpoint(
    job: str,
    body: JobPatch,
    project: Project = Depends(current_project),
    session: AsyncSession = Depends(get_session),
) -> JobOut:
    """Change a job's description. The name and the check settings never change (the name is what your
    code sends, and the check decides pass or fail)."""
    found = await _job(session, project, job)
    await ingest.update_job_description(session, found, body.description)
    await session.commit()
    counts = (
        await session.execute(
            select(Run.state, func.count()).where(Run.job_id == found.job_id).group_by(Run.state)
        )
    ).all()
    by_state = {state: n for state, n in counts}
    return JobOut(
        job_id=found.job_id, name=found.name, description=found.description, check_kind=found.check_kind,
        check_config=found.check_config, retest_consent=found.retest_consent,
        run_count=sum(by_state.values()), runs_by_state=by_state,
    )


@app.get("/v1/jobs/{job}/profile", response_model=TaskProfileOut, tags=["jobs"])
async def get_task_profile(
    job: str,
    days: int = Query(default=30, ge=1, le=365, description="How many days back"),
    project: Project = Depends(current_project),
    session: AsyncSession = Depends(get_session),
) -> TaskProfileOut:
    """What the recorded calls prove about a task: models, tool use, typical size (measured, no AI). With
    fewer than 25 calls only the count is given. Also the optional AI summary's state; the summary is
    written only when the project switched it on."""
    found = await _job(session, project, job)
    settings = get_settings()
    profile = await task_profile(session, found, days=days)
    state, text = await task_summary_state(session, project, found, settings)
    summary = TaskSummaryOut(state=state, text=text, consent=project.task_summary_consent,
                             service=provider_name(settings))
    if profile.calls < MIN_CALLS:
        return TaskProfileOut(calls=profile.calls, window_days=days, enough_data=False, models=[], uses_tools=False,
                              works_like_agent=None, tool_source=None, multi_agent=False, typical_tokens_in=None,
                              typical_tokens_out=None, summary=summary)
    return TaskProfileOut(**vars(profile), window_days=days, enough_data=True, summary=summary)


@app.put("/v1/task-summary-consent", response_model=TaskSummaryOut, tags=["jobs"])
async def put_task_summary_consent(
    body: TaskSummaryConsentIn,
    project: Project = Depends(signed_in_project),
    session: AsyncSession = Depends(get_session),
) -> TaskSummaryOut:
    """Switch the AI-written task summaries on or off for this project. Off by default; while off, no
    sample prompt is ever sent to an outside AI service. Only the signed-in owner may change it (a project
    key, which an SDK holds, is refused), and switching it off deletes the project's stored summaries."""
    project.task_summary_consent = body.enabled
    if not body.enabled:
        await delete_project_summaries(session, project.project_id)
    await session.commit()
    return TaskSummaryOut(state="off" if not body.enabled else "pending", text=None, consent=body.enabled,
                          service=provider_name(get_settings()))


@app.delete("/v1/jobs/{job}/summary", status_code=204, tags=["jobs"])
async def delete_task_summary(
    job: str,
    project: Project = Depends(current_project),
    session: AsyncSession = Depends(get_session),
) -> Response:
    """Delete the stored AI summary of this task. It is not written again unless the sample calls change."""
    await delete_summary(session, await _job(session, project, job))
    await session.commit()
    return Response(status_code=204)


async def _job_name(session: AsyncSession, job_id, project_id: str) -> str:
    """Scoped to the project like every other read, so a stray job_id can never reveal another project's job."""
    return (
        await session.execute(select(Job.name).where(Job.job_id == job_id, Job.project_id == project_id))
    ).scalar_one()


def _encode_cursor(created_at: datetime, run_id) -> str:
    return base64.urlsafe_b64encode(f"{created_at.isoformat()}|{run_id}".encode()).decode()


def _decode_cursor(cursor: str) -> tuple[datetime, uuid.UUID]:
    try:
        stamp, run_id = base64.urlsafe_b64decode(cursor.encode()).decode().split("|", 1)
        return datetime.fromisoformat(stamp), uuid.UUID(run_id)
    except (ValueError, binascii.Error) as exc:
        raise HTTPException(422, "Invalid cursor") from exc


@app.get("/v1/runs", response_model=RunPage, tags=["runs"])
async def list_runs(
    job: str | None = Query(default=None, description="Job name"),
    model: str | None = None,
    outcome: str | None = Query(default=None, pattern="^(PASS|FAIL|UNKNOWN)$"),
    recommendation: uuid.UUID | None = Query(default=None, description="Only the runs this verdict rests on"),
    limit: int = Query(default=50, ge=1, le=200),
    cursor: str | None = None,
    request: Request = None,  # type: ignore[assignment]
    project: Project = Depends(current_project),
    session: AsyncSession = Depends(get_session),
) -> RunPage:
    """Recorded runs, newest first, one page at a time (pass `next_cursor` as `cursor`)."""
    query = (
        select(Run, Job.name)
        .join(Job, Job.job_id == Run.job_id)
        .where(Run.project_id == project.project_id)
        .order_by(Run.created_at.desc(), Run.run_id.desc())
        .limit(limit + 1)
    )
    if recommendation:
        query = query.where(Run.run_id.in_(await lineage.runs_behind(session, recommendation)))
    if job:
        query = query.where(Job.name == job)
    if model:
        query = query.where(Run.model == model)
    if outcome:
        query = query.where(Run.outcome == outcome)
    if cursor:
        stamp, run_id = _decode_cursor(cursor)
        query = query.where(tuple_(Run.created_at, Run.run_id) < tuple_(stamp, run_id))
    rows = (await session.execute(query)).all()
    page, more = rows[:limit], len(rows) > limit
    weights = await _weights(session, [r for r, _ in page])
    items = [_run_out(r, job_name, weights.get(r.run_id)) for r, job_name in page]
    if not can_see_content(request):  # a viewer sees the numbers, not the text
        items = [i.model_copy(update={"prompt_preview": None, "output_preview": None}) for i in items]
    next_cursor = _encode_cursor(page[-1][0].created_at, page[-1][0].run_id) if more else None
    return RunPage(items=items, next_cursor=next_cursor)


@app.post("/v1/jobs", response_model=JobOut, status_code=201, tags=["jobs"])
async def create_job_endpoint(
    body: JobCreate,
    project: Project = Depends(current_project),
    session: AsyncSession = Depends(get_session),
) -> JobOut:
    """Define a job and how a correct answer is recognised."""
    count = (await session.execute(select(func.count()).select_from(Job).where(Job.project_id == project.project_id))).scalar_one()
    if count >= MAX_JOBS_PER_PROJECT:
        raise HTTPException(409, f"This project already has {MAX_JOBS_PER_PROJECT} jobs, which is the most one "
                                 "project can have. Use fewer, broader job names or delete ones you no longer need.")
    try:
        job = await ingest.create_job(session, project, body)
    except ingest.DuplicateJob as exc:
        raise HTTPException(409, f"A job named '{body.name}' already exists") from exc
    await session.commit()
    return JobOut(
        job_id=job.job_id, name=job.name, description=job.description, check_kind=job.check_kind,
        check_config=job.check_config, retest_consent=job.retest_consent, run_count=0, runs_by_state={},
    )


@app.post("/v1/runs", response_model=RunAccepted, status_code=202, tags=["runs"])
async def record_run_endpoint(
    body: RunCreate,
    project: Project = Depends(current_project),
    session: AsyncSession = Depends(get_session),
) -> RunAccepted:
    """Record one model call. Safe to retry: the same `run_id` is only ever stored once.
    A project may record at most RUNS_PER_DAY_PER_PROJECT runs per UTC day (429 after that)."""
    limit = get_settings().runs_per_day_per_project

    async def count_today(since: datetime) -> int:
        return (await session.execute(select(func.count()).where(
            Run.project_id == project.project_id, Run.run_kind == "PRODUCTION", Run.created_at >= since))).scalar_one()

    if not await DAILY_RUNS.admit(project.project_id, limit, count_today):
        raise HTTPException(429, f"This project has recorded its {limit:,} runs for today (UTC); "
                                 "raise RUNS_PER_DAY_PER_PROJECT on the server if that is expected")
    try:
        stored = await ingest.record_run(session, project, body)
    except ingest.UnknownJob as exc:
        DAILY_RUNS.forget(project.project_id)
        raise HTTPException(404, f"Unknown job '{body.job}'. Create it first with POST /v1/jobs") from exc
    if not stored:
        DAILY_RUNS.forget(project.project_id)
    await session.commit()
    return RunAccepted(run_id=body.run_id, status="accepted" if stored else "duplicate")


@app.get("/v1/runs/{run_id}", response_model=RunDetail, tags=["runs"])
async def get_run(
    run_id: uuid.UUID,
    request: Request = None,  # type: ignore[assignment]
    project: Project = Depends(current_project),
    session: AsyncSession = Depends(get_session),
) -> RunDetail:
    """One run in full: the whole prompt and output, and why it passed or failed."""
    run = (
        await session.execute(select(Run).where(Run.run_id == run_id, Run.project_id == project.project_id))
    ).scalar_one_or_none()
    if run is None:
        raise HTTPException(404, "Run not found")
    fields = _run_fields(run, await _job_name(session, run.job_id, project.project_id),
                         (await _weights(session, [run])).get(run.run_id))
    if not can_see_content(request):  # a viewer sees the numbers, not the text, tool calls or answer key
        return RunDetail(**{**fields, "prompt_preview": None, "output_preview": None}, prompt=None, output=None, tool_calls=None)
    return RunDetail(**fields, prompt=run.prompt, output=run.output, tool_calls=run.tool_calls)


@app.post("/v1/runs/{run_id}/label", response_model=RunOut, tags=["runs"])
async def label_run_endpoint(
    run_id: uuid.UUID,
    body: LabelCreate,
    project: Project = Depends(current_project),
    session: AsyncSession = Depends(get_session),
) -> RunOut:
    """Supply the outcome for a run that was stored UNKNOWN (a late label)."""
    try:
        run = await ingest.label_run(session, project, run_id, body.outcome, body.reason)
    except ingest.UnknownRun as exc:
        raise HTTPException(404, "Run not found") from exc
    except ingest.AlreadyResolved as exc:
        raise HTTPException(409, "This run already has an outcome") from exc
    await session.commit()
    return _run_out(run, await _job_name(session, run.job_id, project.project_id))


@app.get("/v1/models", response_model=ModelPage, tags=["models"])
async def list_models(
    status: str | None = Query(default=None, pattern="^(ACTIVE|DEPRECATED|RETIRED)$"),
    used: bool = Query(default=False, description="Only models this project has recorded runs on"),
    q: str | None = Query(default=None, max_length=100, description="Substring of the model name"),
    limit: int = Query(default=100, ge=1, le=500),
    cursor: str | None = None,
    project: Project = Depends(current_project),
    session: AsyncSession = Depends(get_session),
) -> ModelPage:
    """The model catalog: price, status and shutdown date, so a retirement is seen before it bites."""
    seen = (
        await session.execute(
            select(Run.model, Run.model_version).where(Run.project_id == project.project_id).distinct()
        )
    ).all()
    used_names = {normalize(n) for pair in seen for n in pair}

    query = select(CatalogEntry).order_by(CatalogEntry.model, CatalogEntry.model_version).limit(limit + 1)
    if status:
        query = query.where(CatalogEntry.status == status)
    if q:
        query = query.where(CatalogEntry.model.contains(q.lower(), autoescape=True))
    if used:
        query = query.where(CatalogEntry.model.in_(used_names or {""}))
    if cursor:
        try:
            last_model, last_version = base64.urlsafe_b64decode(cursor.encode()).decode().split("|", 1)
        except (ValueError, binascii.Error) as exc:
            raise HTTPException(422, "Invalid cursor") from exc
        query = query.where(tuple_(CatalogEntry.model, CatalogEntry.model_version) > tuple_(last_model, last_version))
    rows = (await session.execute(query)).scalars().all()
    page, more = rows[:limit], len(rows) > limit
    sources, official_rows = await load_official(session)
    now = datetime.now(UTC)
    synced = dict((await session.execute(
        select(PriceVersion.model, func.max(PriceVersion.checked_at)).where(PriceVersion.model.in_([m.model for m in page] or [""]))
        .group_by(PriceVersion.model))).all())
    last_synced = (await session.execute(select(func.max(PriceVersion.checked_at)))).scalar_one()

    def reference(m: CatalogEntry) -> ModelReferenceOut:
        r = reference_for(m.model, m.provider, m.price_in_per_mtok, m.price_out_per_mtok, manual=m.source == "MANUAL",
                          sources=sources, official=official_rows, now=now)
        return ModelReferenceOut(
            kind="api_model", maker=r.provider_name, docs_url=r.docs_url, pricing_url=r.pricing_url,
            deprecations_url=r.deprecations_url, price_check=r.price_check, price_check_note=r.price_check_note,
            price_checked_at=r.checked_at, price_check_stale=r.stale,
            official_input_per_mtok=float(r.official_input) if r.official_input is not None else None,
            official_output_per_mtok=float(r.official_output) if r.official_output is not None else None,
            price_basis=r.price_basis, catalog_source=r.catalog_source, catalog_synced_at=synced.get(m.model))

    items = [
        ModelOut(
            model=m.model, model_version=m.model_version, provider=m.provider, status=m.status,
            shutdown_date=m.shutdown_date,
            price_in_per_mtok=float(m.price_in_per_mtok) if m.price_in_per_mtok is not None else None,
            price_out_per_mtok=float(m.price_out_per_mtok) if m.price_out_per_mtok is not None else None,
            source=m.source, first_seen_at=m.first_seen_at, used_by_project=m.model in used_names,
            reference=reference(m),
        )
        for m in page
    ]
    next_cursor = None
    if more:
        next_cursor = base64.urlsafe_b64encode(f"{page[-1].model}|{page[-1].model_version}".encode()).decode()
    return ModelPage(
        items=items, next_cursor=next_cursor,
        catalog=CatalogInfoOut(source=CATALOG_SOURCE, last_synced_at=last_synced,
                               note="Prices come from a community-maintained list and refresh daily. Where a maker's own pricing "
                                    "page can be read, it is compared with this and shown beside it."),
        official_sources=[PriceSourceOut(
            source_id=s.source_id, name=s.name, provider=s.provider, url=s.url, status=s.status,
            last_checked_at=s.last_checked_at, last_ok_at=s.last_ok_at, detail=s.detail, model_count=s.model_count,
            stale=s.last_ok_at is not None and now - s.last_ok_at > OFFICIAL_STALE_AFTER)
            for s in sorted(sources.values(), key=lambda x: x.source_id)],
        kind_note="This is a list of API models you can call. Coding tools and subscription apps, such as Cursor or Copilot, are "
                  "not API endpoints, so they are not listed or ranked here.")


def _vs_current(m: ModelEvidence, cur: ModelEvidence | None, settings) -> DifferenceOut | None:
    """The engine's own difference interval against the model in use, at the confidence a move needs."""
    if cur is None or m is cur or m.sample is None or cur.sample is None:
        return None
    conf = max(settings.switch_confidence, settings.confidence_level)
    z = z_for(conf)
    low, high = difference(m.sample, cur.sample, z)
    return DifferenceOut(
        against=cur.model, gap_points=(m.sample.pass_rate - cur.sample.pass_rate) * 100, low_points=low * 100,
        high_points=high * 100, confidence=conf, margin_points=settings.tolerance_points * 100,
        status=assess(m.sample, cur.sample, margin=settings.tolerance_points, z=z))


def _ref(m: ModelEvidence | None) -> ModelRef | None:
    return ModelRef(model=m.model, model_version=m.model_version) if m else None


def _recommendation_out(r: JobRecommendation, summary: str | None = None,
                        summary_version: str | None = None) -> RecommendationOut:
    d = r.decision
    return RecommendationOut(
        job=r.job, verdict=d.verdict, current=_ref(d.current), recommended=_ref(d.recommended),
        reference=d.reference.model if d.reference else None,
        rules=RecommendationRules(
            confidence=r.settings.confidence_level, margin=r.settings.tolerance_points,
            evidence_floor=r.settings.evidence_floor,
            switch_confidence=max(r.settings.switch_confidence, r.settings.confidence_level),
        ),
        models=[
            ModelEvidenceOut(
                model=m.model, model_version=m.model_version, catalog_status=m.catalog_status,
                shutdown_date=m.shutdown_date, n_runs=m.n_runs, failures=m.failures,
                evidence_weight=m.sample.evidence_weight if m.sample else 0.0,
                effective_n=m.sample.effective_n if m.sample else None,
                weighted_pass_rate=m.sample.pass_rate if m.sample else None,
                pass_rate_low=m.pass_rate_low, pass_rate_high=m.pass_rate_high, mean_cost_usd=m.mean_cost_usd,
                cost_per_success_usd=m.cost_per_success_usd, status=m.status, eligible=m.eligible, why=m.why,
                vs_current=_vs_current(m, d.current, r.settings), priced_runs=m.priced_runs,
                unpriced_runs=m.unpriced_runs, retest_runs=m.retest_runs, cost_p50_usd=m.cost_p50_usd,
                cost_p90_usd=m.cost_p90_usd,
            )
            for m in d.models
        ],
        evidence=RecommendationEvidence(
            n_runs=r.n_runs, evidence_weight=r.evidence_weight, floor=r.settings.evidence_floor,
            failing_runs=[vars(f) for f in r.failing_runs],
            state=r.state, state_note=r.state_note, check=vars(basis_for(r.check_kind)),
            window_from=r.window_from, window_to=r.window_to,
            comparison="paired" if r.paired else "unpaired", limitations=r.limitations,
            paired=PairedOut(
                candidate=r.paired.candidate, current=r.paired.current, n_prompts=r.paired.n_prompts,
                both_passed=r.paired.both, only_candidate_passed=r.paired.only_candidate,
                only_current_passed=r.paired.only_current, neither_passed=r.paired.neither,
                gap_points=r.paired.gap * 100, low_points=r.paired.low * 100, high_points=r.paired.high * 100,
            ) if r.paired else None,
        ),
        progress=d.progress, retest_candidates=d.retest_candidates,
        forecast=ForecastOut(**vars(r.forecast)) if r.forecast else None, summary=summary,
        summary_prompt_version=summary_version, warnings=d.warnings,
        next_step=d.next_step, computed_at=r.computed_at,
        promising=PromisingOut(
            model=d.promising.model, current=d.promising.current, gap_points=d.promising.gap * 100,
            low_points=d.promising.low * 100, high_points=d.promising.high * 100,
            more_needed=d.promising.more_needed) if d.promising else None,
        sure_enough=SureEnoughOut(needed=d.sure_enough_needed, have=d.sure_enough_have)
        if d.verdict == "INSUFFICIENT_EVIDENCE" and d.sure_enough_have is not None else None,
    )


async def _job(session: AsyncSession, project: Project, name: str) -> Job:
    """The project's job with this name, or 404."""
    found = (
        await session.execute(select(Job).where(Job.project_id == project.project_id, Job.name == name))
    ).scalar_one_or_none()
    if found is None:
        raise HTTPException(404, f"Unknown job '{name}'")
    set_context(job_id=str(found.job_id))
    return found


@app.get("/v1/jobs/{job}/recommendation", response_model=RecommendationOut, tags=["recommendations"])
async def get_recommendation(
    job: str, project: Project = Depends(current_project), session: AsyncSession = Depends(get_session)
) -> RecommendationOut:
    """The cheapest model that does this job properly, with the evidence and failing runs behind it.

    Refuses with INSUFFICIENT_EVIDENCE, and progress toward the floor, until there is enough to judge.
    """
    found = await _job(session, project, job)
    result = await cached_recommend(session, found)
    log.info("verdict served", extra={"verdict": result.decision.verdict, "n_runs": result.n_runs,
                                      "evidence_weight": round(result.evidence_weight, 2)})
    return _recommendation_out(result, *await summarize(session, found, result, get_settings()))


@app.get("/v1/jobs/{job}/history", response_model=HistoryOut, tags=["recommendations"])
async def get_history(
    job: str, project: Project = Depends(current_project), session: AsyncSession = Depends(get_session)
) -> HistoryOut:
    """Every recommendation the job has had, newest first: what changed, when and why.

    Followed through `superseded_by_id` with a recursive query; each entry's runs are listed by
    `GET /v1/runs?recommendation=<id>`.
    """
    found = await _job(session, project, job)
    entries = [
        HistoryEntryOut(
            recommendation_id=r.recommendation_id, verdict=r.verdict, model=r.model, model_version=r.model_version,
            current_model=r.current_model, weighted_pass_rate=r.weighted_pass_rate,
            mean_cost_usd=float(r.mean_cost_usd) if r.mean_cost_usd is not None else None,
            cost_per_success_usd=(
                float(r.mean_cost_usd) / r.weighted_pass_rate
                if r.mean_cost_usd is not None and r.weighted_pass_rate else None
            ),
            n_runs=r.n_runs, evidence_weight=r.evidence_weight, valid_at=r.valid_at, invalid_at=r.invalid_at,
            superseded_by_id=r.superseded_by_id, supersession_reason=r.supersession_reason,
        )
        for r in reversed(await lineage.history(session, found.job_id))
    ]
    versions = [ModelVersionSeen(**vars(v)) for v in await lineage.model_versions(session, found.job_id)]
    return HistoryOut(job=found.name, entries=entries, versions=versions)


@app.get("/v1/insights/spend", response_model=list[SpendOut], tags=["insights"])
async def get_spend(
    days: int = Query(default=30, ge=1, le=365, description="How many days back to count"),
    project: Project = Depends(current_project),
    session: AsyncSession = Depends(get_session),
) -> list[SpendOut]:
    """Production spend per job over the last `days` days, most expensive first."""
    return [SpendOut(**vars(s)) for s in await spend_by_job(session, project.project_id, days=days)]


@app.get("/v1/insights/cost-receipt", response_model=CostReceiptOut, tags=["insights"])
async def get_cost_receipt(
    days: int = Query(default=30, ge=1, le=365, description="How many days back to count"),
    job: str | None = Query(default=None, max_length=200, description="Only this job"),
    project: Project = Depends(current_project),
    session: AsyncSession = Depends(get_session),
) -> CostReceiptOut:
    """How the spend figure is worked out: currency and period, passed / failed / unchecked / left-out calls,
    how many are unpriced, the dated list prices used, and cost per correct answer with its formula.
    List prices at the time of each call: an estimate, not an invoice."""
    job_id = (await _job(session, project, job)).job_id if job else None
    return CostReceiptOut.model_validate(
        asdict(await cost_receipt(session, project.project_id, days=days, job_id=job_id)))


@app.get("/v1/insights/projection", response_model=ProjectionOut, tags=["insights"])
async def get_projection(
    project: Project = Depends(current_project),
    session: AsyncSession = Depends(get_session),
) -> ProjectionOut:
    """This month's spend so far and a month-end forecast, kept apart. The forecast is a range, says "not enough
    history" instead of guessing from a short or sparse history, and names the timezone, the month's first and last
    day, how many calls have no price, and what can make the figures late. The same figures drive the budget alerts.
    Alert-only: nothing is blocked."""
    p = await month_projection(session, project)
    data = asdict(p)
    data["recent_days"] = [{"day": d, "spend_usd": float(v)} for d, v in p.recent_days]
    return ProjectionOut.model_validate(data)


BASIS_NOTE = ("Measured from this project's own calls, whole UTC days only, the last period against the same number of "
              "days before it. This shows what changed and what else was recorded at the same time. It cannot show why: "
              "a recorded change can coincide with a difference without causing it.")


@app.get("/v1/insights/changes", response_model=ChangesOut, tags=["insights"])
async def get_changes(
    days: int = Query(7, description="Length of each period: 7, 14 or 30"),
    project: Project = Depends(current_project),
    session: AsyncSession = Depends(get_session),
) -> ChangesOut:
    """What changed between the last `days` whole days and the same number of days before: calls, tokens, cached share,
    repeated calls, model mix, task mix and spend, with coverage and missing data, plus what else the product recorded in
    the window (a new prompt version, a new model, a list-price change). Observation and context are kept apart; nothing
    here is a cause. Deterministic: no model writes any of it."""
    if days not in CHANGE_DAYS:
        raise HTTPException(422, f"days must be one of {list(CHANGE_DAYS)}")
    mode = project.billing_mode if project.billing_mode in ("subscription", "both") else "per_use"
    c = await what_changed(session, project.project_id, days=days, mode=mode)
    money = mode != "subscription"

    def period(p):
        d = asdict(p)
        d["cache_read_tokens"] = d.pop("cache_read")
        d["spend_usd"] = d["spend_usd"] if money else None
        d["calls_with_usage"] = d.pop("with_usage")
        d["calls_with_task_id"] = d.pop("with_trace")
        d.pop("repeats")
        return d

    return ChangesOut(
        days=days, mode=mode, comparable=c.comparable, current=period(c.current), previous=period(c.previous),
        observations=[asdict(o) for o in c.observations], model_mix=[asdict(r) for r in c.model_mix],
        task_mix=[asdict(r) for r in c.task_mix], splits=[asdict(s) for s in c.splits],
        events=[asdict(e) for e in c.events], notes=c.notes, not_recorded=c.not_recorded, basis=BASIS_NOTE)


@app.get("/v1/insights/savings", response_model=SavingsOut, tags=["insights"])
async def get_savings(project: Project = Depends(current_project), session: AsyncSession = Depends(get_session)) -> SavingsOut:
    """After you changed the model a task runs on: the observed change in cost per correct answer (it can be negative) and, kept apart,
    an estimated counterfactual. Needs 14 comparable days on each side, enough checked calls and a like-for-like prompt mix, else it says
    "not enough comparable data". Recommendations, "promising" labels and trials are never counted. Analysis only: nothing is changed."""
    found = await savings_insight(session, project)
    entries = [SavingsEntry(**{**asdict(e), "switch_date": e.switch_date}) for e in found.entries]
    counts: dict[str, int] = {}
    for e in entries:
        counts[e.status] = counts.get(e.status, 0) + 1
    est = [e.estimated_avoided for e in entries if e.estimated_avoided is not None]
    total = SavingsTotal(
        label="ESTIMATED counterfactuals added up. Not money you can count, and separate from the realized changes above",
        unit=found.unit, point=sum(x.point or 0.0 for x in est), low=sum(x.low or 0.0 for x in est), high=sum(x.high or 0.0 for x in est),
        entries=len(est)) if est else None
    return SavingsOut(
        mode=found.mode, unit=found.unit, as_of=found.today, jobs_checked=found.jobs_checked, entries=entries, counts=counts,
        estimated_avoided_total=total, notes=found.notes,
        method=["Each task's own cost per correct answer, before and after the day its model changed, over equal periods of whole weeks.",
                "Prompts are compared by size, so a shift in the kind of work is not counted as a saving.",
                "The shown range is 90%. A saving is shown only when even its cautious end is above zero.",
                "If quality fell beyond its range it is called cheaper but less correct, not a saving.",
                "Fewer than 14 days, 100 checked calls or 30 correct answers on either side: not enough comparable data."])


@app.get("/v1/insights/export.csv", tags=["insights"])
async def export_csv(
    days: int = Query(30, ge=1, le=365, description="The last N days, today included: the same period the Overview shows"),
    ai_task: str | None = Query(default=None, max_length=200, description="Only this AI task"),
    model: str | None = Query(default=None, max_length=200, description="Only this model"),
    project: Project = Depends(current_project), user: User | None = Depends(optional_user),
    session: AsyncSession = Depends(get_session),
) -> Response:
    """The project's daily figures as a CSV file, for admins and owners: one row per day, AI task and model, for exactly the period and
    filters asked for. Aggregates and labels only: no prompt or answer text, no keys, no people. Each row carries its period, filters,
    units and cost basis. Text values a spreadsheet could run as a formula are prefixed with an apostrophe; `X-Export-Neutralized` says how many."""
    mode = project.billing_mode if project.billing_mode in ("subscription", "both") else "per_use"
    today = datetime.now(UTC).date()
    start = today - timedelta(days=days - 1)
    points = [p for p in await insights_daily(session, project.project_id, days=days + 1) if start <= p.day <= today]
    if ai_task:
        points = [p for p in points if p.job == ai_task]
    if model:
        points = [p for p in points if p.model == model]
    cost = "spend_usd" if mode == "per_use" else "list_price_usd"
    columns = [cost if c == "spend_usd" else c for c in PROJECT_COLUMNS]
    meta = {"currency": "USD", "cost_basis": COST_BASIS[mode], "pay_mode": mode, "period_start": start.isoformat(), "period_end": today.isoformat(),
            "filter_ai_task": ai_task or "", "filter_model": model or ""}
    rows = [{
        "day": p.day.isoformat(), "ai_task": p.job, "model": p.model, "runs": p.runs, "passed": p.passed, "failed": p.failed,
        "unchecked_runs": max(0, p.runs - p.passed - p.failed), "unpriced_runs": p.unpriced_runs, cost: p.spend_usd,
        "tokens_in": p.tokens_in, "tokens_out": p.tokens_out, "cache_read_tokens": p.cache_read_tokens, "cache_write_tokens": p.cache_write_tokens, **meta,
    } for p in points]
    body, changed = write_csv(columns, rows, text_columns=PROJECT_TEXT)
    if project.organisation_id is not None and user is not None:
        from .auth.orgs import audit_project
        await audit_project(session, project, user, "project_data_exported", days=days, rows=len(rows), filtered=bool(ai_task or model))
        await session.commit()
    safe = re.sub(r"[^A-Za-z0-9._-]", "-", project.slug or project.project_id)
    return Response(content=csv_file(body), media_type="text/csv; charset=utf-8", headers={
        "Content-Disposition": f'attachment; filename="model-cost-memory-{safe}-last-{days}-days.csv"', "Cache-Control": "no-store",
        "X-Export-Rows": str(len(rows)), "X-Export-Neutralized": str(changed), "X-Content-Type-Options": "nosniff"})


@app.get("/v1/insights/tool-servers", response_model=ToolServersOut, tags=["insights"])
async def get_tool_servers(
    days: int = Query(30, description="Period in days: 7, 14, 30 or 90"),
    job: str | None = Query(default=None, max_length=200, description="Only one AI task"),
    project: Project = Depends(current_project),
    session: AsyncSession = Depends(get_session),
) -> ToolServersOut:
    """MCP and tool-server calls recorded in this project, by server and tool, with the tasks they came from, how often, how long the
    requests took and the usage of those whole requests. A server is `provider_reported` only when the provider's own response named
    it; a tool name that merely looks like mcp__server__tool is `likely`. No provider reports tokens per tool, so none is claimed.
    Analysis only: nothing is called, blocked or changed."""
    if days not in TOOL_DAYS:
        raise HTTPException(422, f"days must be one of {list(TOOL_DAYS)}")
    if job is not None and (await session.execute(
            select(Job.job_id).where(Job.project_id == project.project_id, Job.name == job))).first() is None:
        raise HTTPException(404, "No such AI task")
    mode = project.billing_mode if project.billing_mode in ("subscription", "both") else "per_use"
    t = await tool_servers_insight(session, project.project_id, days=days, job=job, mode=mode)
    server_rows = [asdict(s) | {"tools": [{"name": n, "calls": c} for n, c in s.tools], "tasks": [{"name": n, "calls": c} for n, c in s.tasks]}
                   for s in t.servers]
    return ToolServersOut(
        days=days, since=t.since, until=t.until, job=job, mode=mode, servers=server_rows,
        own_tools=asdict(t.own_tools) | {"tools": [{"name": n, "calls": c} for n, c in t.own_tools.tools]},
        totals=asdict(t.totals), support=[asdict(s) for s in t.support], unreadable_calls=t.unreadable_calls,
        truncated=t.truncated, notes=t.notes, method=t.method)


def _totals(t) -> TaskTotalsOut:
    return TaskTotalsOut(calls=t.calls, tokens=t.tokens, cost_usd=t.cost_usd, unpriced_calls=t.unpriced_calls)


def _structure(tree) -> TaskStructureOut:
    linked = sum(1 for n in tree.roots for _ in _walk(n)) - len(tree.roots)
    linked += sum(1 for n in tree.unlinked for _ in _walk(n)) - len(tree.unlinked)
    return TaskStructureOut(roots=len(tree.roots), linked_children=linked, unlinked=len(tree.unlinked), no_structure=len(tree.unstructured))


def _walk(node):
    stack = [node]
    while stack:
        cur = stack.pop()
        yield cur
        stack.extend(reversed(cur.children))


def _flat_nodes(tree) -> list[TaskNodeOut]:
    """Display order: every tree, then the unlinked ones, then the calls with no structure. Depth and parent let the screen fold any branch."""
    out: list[TaskNodeOut] = []

    def emit(top, section):
        stack = [(top, 0, None)]
        while stack:
            n, depth, parent = stack.pop()
            c = n.call
            out.append(TaskNodeOut(
                run_id=c.run_id, parent_run_id=parent, depth=depth, section=section, link=n.link, reason=n.reason,
                missing_parent=n.missing_parent, duplicate_span=n.duplicate_span, child_count=len(n.children), agent=c.agent, model=c.model,
                job=c.job, span_id=c.span_id, parent_span_id=c.parent_span_id, started_at=c.created_at, latency_ms=c.latency_ms,
                tools=sorted(set(c.tool_names))[:8], own=_totals(n.own), subtree=_totals(n.subtree)))
            for child in reversed(n.children):
                stack.append((child, depth + 1, c.run_id))

    for n in tree.roots:
        emit(n, "tree")
    for n in tree.unlinked:
        emit(n, "unlinked")
    for n in tree.unstructured:
        emit(n, "no_structure")
    return out


def _repeated_out(r) -> RepeatedCallOut | None:
    if r is None:
        return None
    return RepeatedCallOut(
        step=r.step, basis=r.basis, repeats=r.repeats, in_window=r.in_window, threshold=r.repeats_threshold, window=r.window,
        calls=[RepeatedCallItemOut(**c) for c in r.calls], median_gap_seconds=r.median_gap_seconds, results_stored=r.results_stored,
        distinct_results=r.distinct_results, failed_calls=r.failed_calls, cost_usd=r.cost_usd, hints=r.hints)


def _spread(d) -> SpreadOut:
    return SpreadOut(**d)


@app.get("/v1/insights/agent-tasks", response_model=AgentTasksOut, tags=["insights"])
async def get_agent_tasks(
    days: int = Query(30, description="Period in days: 7, 14, 30 or 90"),
    job: str | None = Query(default=None, max_length=200),
    repeats: int = Query(5, description="Flag a call repeated at least this many times: 3, 4, 5, 6, 8 or 10"),
    window: int = Query(7, description="within this many consecutive calls: 5, 7, 10 or 15"),
    project: Project = Depends(current_project),
    session: AsyncSession = Depends(get_session),
) -> AgentTasksOut:
    """The project's largest tasks (calls sharing a trace id), with what each measured, how much of its structure is known, any
    possible repeated call at the chosen threshold, and cohorts of equivalent tasks. Analysis only: nothing is stopped, cancelled
    or reconfigured. A repeated call is a possibility, never a verdict: polling and retries repeat on purpose."""
    if job is not None and (await session.execute(
            select(Job.job_id).where(Job.project_id == project.project_id, Job.name == job))).first() is None:
        raise HTTPException(404, "No such AI task")
    mode = project.billing_mode if project.billing_mode in ("subscription", "both") else "per_use"
    try:
        r = await agent_tasks_insight(session, project.project_id, days=days, job=job, repeats=repeats, window=window, mode=mode)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    return AgentTasksOut(
        days=r.days, repeats=r.repeats, window=r.window, mode=mode, repeat_choices=list(AGENT_REPEAT_CHOICES),
        window_choices=list(AGENT_WINDOW_CHOICES), min_cohort=AGENT_MIN_COHORT,
        tasks=[AgentTaskSummaryOut(
            trace_id=t.trace_id, jobs=t.jobs, agents=t.agents, models=t.models, first_at=t.first_at, last_at=t.last_at,
            totals=_totals(t.tree.totals), structure=_structure(t.tree), repeated_step=t.repeated.step if t.repeated else None,
            repeated_times=t.repeated.repeats if t.repeated else None, notes=t.tree.notes) for t in r.tasks],
        cohorts=[CohortOut(job=c.job, models=c.models, single_agent=CohortSideOut(tokens=_spread(c.single_agent["tokens"]),
                 cost_usd=_spread(c.single_agent["cost_usd"]) if c.single_agent["cost_usd"] else None),
                 multi_agent=CohortSideOut(tokens=_spread(c.multi_agent["tokens"]),
                 cost_usd=_spread(c.multi_agent["cost_usd"]) if c.multi_agent["cost_usd"] else None)) for c in r.cohorts],
        notes=r.notes, method=r.method)


@app.get("/v1/insights/agent-task", response_model=AgentTaskOut, tags=["insights"])
async def get_agent_task(
    trace_id: str = Query(max_length=200),
    repeats: int = Query(5),
    window: int = Query(7),
    project: Project = Depends(current_project),
    session: AsyncSession = Depends(get_session),
) -> AgentTaskOut:
    """One task as a tree: each recorded call with its parent and children, unlinked and unstructured calls apart, totals that count
    each call once, and any possible repeated call with the calls themselves as evidence. Scoped to this project: another project's
    trace id is a 404."""
    if repeats not in AGENT_REPEAT_CHOICES or window not in AGENT_WINDOW_CHOICES or window < repeats:
        raise HTTPException(422, "choose repeats from 3, 4, 5, 6, 8 or 10 and a window from 5, 7, 10 or 15, at least as large as repeats")
    mode = project.billing_mode if project.billing_mode in ("subscription", "both") else "per_use"
    t = await agent_task_insight(session, project.project_id, trace_id, repeats=repeats, window=window, mode=mode)
    if t is None:
        raise HTTPException(404, "No such task")
    return AgentTaskOut(
        trace_id=t.trace_id, jobs=t.jobs, agents=t.agents, models=t.models, first_at=t.first_at, last_at=t.last_at,
        totals=_totals(t.tree.totals), structure=_structure(t.tree), nodes=_flat_nodes(t.tree), repeated=_repeated_out(t.repeated),
        notes=t.tree.notes + (["Only the first 1,000 calls of this task were read."] if t.truncated else []), truncated=t.truncated,
        method=AGENT_METHOD)


@app.get("/v1/notices", response_model=NoticesOut, tags=["notices"])
async def get_notices(
    project: Project = Depends(current_project),
    session: AsyncSession = Depends(get_session),
) -> NoticesOut:
    """Deprecation and shutdown notices from the providers' own pages for the models this project ran in the last 30
    days. Each has a checked-at date, the provider's own wording and a link to its exact section. Information only:
    nothing is changed or switched. A notice about a provider's own API is not applied to calls served by another host,
    which sets its own dates."""
    now = datetime.now(UTC)
    shown, elsewhere, sources = await project_notices(session, project, now=now)
    by_source = {s.source_id: s for s in sources}
    return NoticesOut(
        notices=[NoticeOut(
            notice_id=p.notice.notice_id, provider=p.notice.provider, provider_name=PROVIDER_NAMES.get(p.notice.provider, p.notice.provider),
            model=p.notice.model, status=p.notice.status, listed_date=p.notice.notice_date, date_wording=p.notice.wording,
            deprecated_on=p.notice.deprecated_on, replacement=p.notice.replacement, section=p.notice.section,
            notice_url=p.notice.notice_url, source_name=by_source[p.notice.source_id].name, checked_at=p.notice.checked_at,
            text=p.text, served_by_known=p.served_by_known, stale_note=p.stale_note) for p in shown],
        hosted_elsewhere=[NoticeElsewhereOut(model=n.model, provider_name=PROVIDER_NAMES.get(n.provider, n.provider), notice_url=n.notice_url)
                          for n in elsewhere],
        sources=[NoticeSourceOut(
            source_id=s.source_id, name=s.name, provider=s.provider, url=s.url, status=s.status or "NEVER",
            last_checked_at=s.last_checked_at, last_ok_at=s.last_ok_at, detail=s.detail, notice_count=s.notice_count or 0,
            stale=bool(s.last_ok_at and now - s.last_ok_at > STALE_AFTER), covers=BY_ID[s.source_id].covers) for s in sources],
        note="Notices are information only. Nothing is changed, replaced or switched for you. Dates are the provider's own "
             "wording: 'not sooner than', 'tentative' and 'earliest possible' are never promised dates.")


@app.get("/v1/insights/daily", response_model=list[DayPointOut], tags=["insights"])
async def get_daily(
    days: int = Query(default=60, ge=1, le=365, description="How many days back"),
    job: str | None = Query(default=None, max_length=200, description="Only this job"),
    project: Project = Depends(current_project),
    session: AsyncSession = Depends(get_session),
) -> list[DayPointOut]:
    """Production runs, outcomes and spend per UTC day, job and model, oldest first: quality and spend
    over time. Days without runs are absent."""
    job_id = (await _job(session, project, job)).job_id if job else None
    return [DayPointOut(**vars(p)) for p in await insights_daily(session, project.project_id, days=days, job_id=job_id)]


@app.get("/v1/insights/agents", response_model=AgentInsightsOut, tags=["insights"])
async def get_agent_insights(
    days: int = Query(default=30, ge=1, le=365, description="How many days back"),
    project: Project = Depends(current_project),
    session: AsyncSession = Depends(get_session),
) -> AgentInsightsOut:
    """Tokens and spend per agent, the ten heaviest traces (with a retry-loop flag), and what tool
    definitions add to each call. Production runs only."""
    found = await agent_insights(session, project.project_id, days=days)
    return AgentInsightsOut(
        agents=[AgentUsageOut(**{**vars(x), "top_tools": [ToolCountOut(name=n, calls=c) for n, c in x.top_tools]})
                for x in found.agents],
        traces=[TraceUsageOut(**{**vars(x), "possible_loop": LoopOut(**vars(x.possible_loop)) if x.possible_loop else None})
                for x in found.traces],
        tools=[ToolsUsageOut(**vars(x)) for x in found.tools],
        kinds=UsageKindsOut(**vars(found.kinds)),
    )


@app.get("/v1/insights/prompts", response_model=PromptsOut, tags=["insights"])
async def get_prompt_insights(
    days: int = Query(default=30, ge=1, le=365, description="How many days back"),
    job: str | None = Query(default=None, max_length=200, description="Only this job"),
    limit: int = Query(default=3, ge=1, le=10, description="How many rows to return"),
    group_by: Literal["task_version", "task", "agent", "prompt_version", "template"] = Query(
        default="task_version", description="What a row is: a task and its prompt version, a task, an agent, a prompt version, or the agent, task and version together (the template receipt)"),
    request: Request = None,  # type: ignore[assignment]
    show_text: bool = Query(default=False, description="Also return a masked preview of the repeated start of a prompt. Off by default: prompt text is not returned unless asked for"),
    project: Project = Depends(current_project),
    session: AsyncSession = Depends(get_session),
) -> PromptsOut:
    """Where the tokens went: the biggest contributors by share of billed tokens, with call counts and
    per-call averages, what each total is made of (only where the provider reports it) and how much of a
    prompt is identical in every call. Production runs, over the exact period returned. Token sums cover
    every call; the repeated-text figures are an estimate from the newest calls whose text is still stored."""
    found = await prompt_insights(session, project.project_id, days=days, job=job, limit=limit, group_by=group_by,
                                  show_text=show_text and can_see_content(request))
    return PromptsOut(
        days=found.days, total_tokens=found.total_tokens, period_start=found.period_start,
        period_end=found.period_end, timezone=found.timezone, total_calls=found.total_calls,
        group_by=found.group_by, grouping_note=found.grouping_note,
        groups=[PromptGroupOut.model_validate(asdict(g)) for g in found.groups],
    )


@app.get("/v1/insights/prompt-versions", response_model=PromptVersionsOut, tags=["insights"])
async def get_prompt_versions(
    job: str = Query(max_length=200, description="The job to compare prompt versions for"),
    days: int = Query(default=30, ge=1, le=365, description="How many days back"),
    request: Request = None,  # type: ignore[assignment]
    project: Project = Depends(current_project),
    session: AsyncSession = Depends(get_session),
) -> PromptVersionsOut:
    """One job's prompt versions side by side: calls, tokens, cached share, list-price cost and checked answers.
    Versions are the `prompt_version` values you sent, or, when you sent none, detected from where the start of
    the stored prompt text changed and stayed changed. Production runs only. Shows what changed, not why."""
    found = await prompt_versions(session, project.project_id, job, days=days)
    if found is None:
        raise HTTPException(404, f"No job named '{job}'")
    seen = can_see_content(request)
    return PromptVersionsOut(
        job=job, days=days, source=found.source, reason=found.reason,
        versions=[PromptVersionOut(**({**vars(v), "start_preview": None} if not seen else vars(v))) for v in found.versions],
        comparison=PromptComparisonOut(**vars(found.comparison)) if found.comparison else None,
    )


def _alert_out(alert: Alert, job_name: str) -> AlertOut:
    return AlertOut(
        alert_id=alert.alert_id, job=job_name, kind=alert.kind, summary=alert.detail.get("summary", alert.kind),
        detail=alert.detail, created_at=alert.created_at, delivered_at=alert.delivered_at,
        delivery_attempts=alert.delivery_attempts, delivery_failed_at=alert.delivery_failed_at,
        resolved_at=alert.resolved_at,
    )


@app.get("/v1/jobs/{job}/regressions", response_model=list[AlertOut], tags=["alerts"])
async def get_regressions(
    job: str,
    include_resolved: bool = Query(default=False, description="Also return alerts already resolved"),
    project: Project = Depends(current_project),
    session: AsyncSession = Depends(get_session),
) -> list[AlertOut]:
    """The job's alerts, newest first: open ones by default."""
    found = await _job(session, project, job)
    query = select(Alert).where(Alert.job_id == found.job_id).order_by(Alert.created_at.desc())
    if not include_resolved:
        query = query.where(Alert.resolved_at.is_(None))
    return [_alert_out(a, found.name) for a in (await session.execute(query)).scalars()]


@app.get("/v1/alerts", response_model=list[AlertOut], tags=["alerts"])
async def list_alerts(
    include_resolved: bool = Query(default=False),
    project: Project = Depends(current_project),
    session: AsyncSession = Depends(get_session),
) -> list[AlertOut]:
    """Every job's alerts in the project, newest first: open ones by default."""
    query = (
        select(Alert, Job.name).join(Job, Job.job_id == Alert.job_id)
        .where(Job.project_id == project.project_id).order_by(Alert.created_at.desc())
    )
    if not include_resolved:
        query = query.where(Alert.resolved_at.is_(None))
    return [_alert_out(a, name) for a, name in (await session.execute(query)).all()]


@app.post("/v1/alerts/{alert_id}/resolve", response_model=AlertOut, tags=["alerts"])
async def resolve_alert(
    alert_id: uuid.UUID, project: Project = Depends(current_project), session: AsyncSession = Depends(get_session)
) -> AlertOut:
    """Mark an alert handled. The same finding can raise a new alert later."""
    row = (
        await session.execute(
            select(Alert, Job.name).join(Job, Job.job_id == Alert.job_id)
            .where(Alert.alert_id == alert_id, Job.project_id == project.project_id)
        )
    ).first()
    if row is None:
        raise HTTPException(404, "Alert not found")
    alert, name = row
    if alert.resolved_at is None:
        alert.resolved_at = datetime.now(UTC)
        await session.commit()
    return _alert_out(alert, name)


async def _retest_out(session: AsyncSession, row: Retest, job_name: str, project: Project) -> RetestOut:
    cap = float(project.retest_monthly_cap_usd)
    spent = float(await spent_this_month(session, project.project_id))
    decided = row.passed + row.failed
    verdict = conclusion(row.passed, row.failed, row.runs_planned, row.status)
    return RetestOut(
        confirmed_at=row.confirmed_at, provider_host=row.provider_host, evaluator=row.evaluator, price_basis=row.price_basis,
        sample_size=len(row.sample_run_ids) if row.sample_run_ids is not None else None,
        evidence=verdict["evidence"] if row.status not in ("QUEUED", "RUNNING") else "inconclusive",
        evidence_note=verdict["evidence_note"] if row.status not in ("QUEUED", "RUNNING") else "Still running: no result yet.",
        pass_rate_low=verdict["pass_rate_low"], pass_rate_high=verdict["pass_rate_high"],
        retest_id=row.retest_id, job=job_name, candidate_model=row.candidate_model, trigger=row.trigger,
        status=row.status, budget_usd=float(row.budget_usd), spent_usd=float(row.spent_usd),
        runs_planned=row.runs_planned, runs_done=row.runs_done, passed=row.passed, failed=row.failed,
        pass_rate=row.passed / decided if decided else None, monthly_cap_usd=cap,
        cap_remaining_usd=max(cap - spent, 0.0), message=row.message, created_at=row.created_at,
        started_at=row.started_at, finished_at=row.finished_at,
    )


@app.post("/v1/jobs/{job}/retest", response_model=RetestOut, status_code=202, tags=["retests"])
async def start_retest(
    job: str, body: RetestCreate, project: Project = Depends(current_project),
    user: User | None = Depends(optional_user), session: AsyncSession = Depends(get_session),
) -> RetestOut:
    """Queue a re-test: replay sampled past runs on `candidate_model`, spending at most `budget_usd`.

    Needs the single-use `confirmation` from `POST /v1/jobs/{job}/retest/preview` of exactly these values: nothing is sent to
    a provider before a person has seen what would be sent and confirmed it.

    409 with `{"code", "message"}` when it cannot start; `code` is one of consent_off, project_off,
    not_checkable, provider_key_required (ask for the key, then try again), cap_reached, already_running.
    Poll `GET /v1/jobs/{job}/retest/{id}` for progress.
    """
    found = await _job(session, project, job)
    wanted = body.sample_size or get_settings().retest_default_sample
    try:
        nonce = read_token(body.confirmation, project_id=project.project_id, job_id=found.job_id, candidate=body.candidate_model,
                           budget=body.budget_usd, sample=wanted, user_id=user.user_id if user else None)
        shown = await build_preview(session, project, found, body.candidate_model, body.budget_usd, body.sample_size,
                                    user_id=user.user_id if user else None)  # what the person is agreeing to, as of now
        row = await enqueue(session, project, found, body.candidate_model, body.budget_usd, "MANUAL")
    except RetestRefused as exc:
        raise HTTPException(409, {"code": exc.code, "message": str(exc)}) from exc
    row.runs_planned = wanted
    row.confirmation_hash, row.confirmed_at = single_use_hash(nonce), datetime.now(UTC)
    row.confirmed_by = user.user_id if user else None
    row.preview = {k: v for k, v in shown.items() if k not in ("confirmation", "expires_at")}
    row.price_basis = shown.get("price_basis")
    try:
        await session.commit()
    except IntegrityError as exc:  # the same confirmation used twice
        await session.rollback()
        raise HTTPException(409, {"code": "confirmation_used", "message": "This confirmation was already used. Ask for a new preview."}) from exc
    return await _retest_out(session, row, found.name, project)


@app.post("/v1/jobs/{job}/retest/preview", response_model=RetestPreviewOut, tags=["retests"])
async def preview_retest(
    job: str, body: RetestPreviewRequest, project: Project = Depends(current_project),
    user: User | None = Depends(optional_user), session: AsyncSession = Depends(get_session),
) -> RetestPreviewOut:
    """What a replay would send, to whom, and what it could cost, before anything is called. Makes no provider call and
    changes nothing. When it can start, the answer holds a single-use confirmation for exactly these values; starting the
    replay needs it, and it expires after a few minutes."""
    found = await _job(session, project, job)
    shown = await build_preview(session, project, found, body.candidate_model, body.budget_usd, body.sample_size,
                                user_id=user.user_id if user else None)
    return RetestPreviewOut(**shown)


@app.get("/v1/jobs/{job}/retest/{retest_id}", response_model=RetestOut, tags=["retests"])
async def get_retest(
    job: str, retest_id: uuid.UUID, project: Project = Depends(current_project),
    session: AsyncSession = Depends(get_session),
) -> RetestOut:
    """One re-test's progress and spend so far; the web app polls it every 2 s while it runs."""
    found = await _job(session, project, job)
    row = await session.get(Retest, retest_id)
    if row is None or row.job_id != found.job_id:
        raise HTTPException(404, "Re-test not found")
    return await _retest_out(session, row, found.name, project)


@app.get("/v1/jobs/{job}/retests", response_model=list[RetestOut], tags=["retests"])
async def list_retests(
    job: str, project: Project = Depends(current_project), session: AsyncSession = Depends(get_session)
) -> list[RetestOut]:
    """The job's re-tests, newest first."""
    found = await _job(session, project, job)
    rows = (
        await session.execute(select(Retest).where(Retest.job_id == found.job_id).order_by(Retest.created_at.desc()))
    ).scalars().all()
    return [await _retest_out(session, r, found.name, project) for r in rows]


def _key_out(key: ProviderKey | None) -> ProviderKeyOut | None:
    if key is None:
        return None
    return ProviderKeyOut(provider=key.provider, base_url=key.base_url, key_hint=key.key_hint,
                          created_at=key.created_at)


@app.get("/v1/retest/limits", response_model=RetestLimits, tags=["retests"])
async def get_retest_limits(
    request: Request = None,  # type: ignore[assignment]
    project: Project = Depends(current_project), session: AsyncSession = Depends(get_session)
) -> RetestLimits:
    """This month's re-test cap, what is spent, and whether the provider key has been given. Only people who may
    change the key see its last four characters; everyone else sees that one is stored."""
    cap, spent = float(project.retest_monthly_cap_usd), float(await spent_this_month(session, project.project_id))
    key = _key_out(await session.get(ProviderKey, project.project_id))
    if key is not None and not role_can(getattr(request.state, "role", None), "providerkey.change"):
        key = key.model_copy(update={"key_hint": "\u2022\u2022\u2022\u2022"})
    return RetestLimits(monthly_cap_usd=cap, spent_this_month_usd=spent, cap_remaining_usd=max(cap - spent, 0.0),
                        retest_allowed=project.retest_allowed, provider_key=key)


@app.put("/v1/provider-key", response_model=ProviderKeyOut, tags=["retests"])
async def put_provider_key(
    body: ProviderKeyIn, project: Project = Depends(current_project), session: AsyncSession = Depends(get_session)
) -> ProviderKeyOut:
    """Give (or replace) the key re-tests use. With the monthly cap, this is standing permission for
    re-tests to run within the cap. Encrypted at rest; never returned again."""
    try:
        key = await provider_keys.set_key(session, project.project_id, provider=body.provider, api_key=body.api_key,
                                          base_url=body.base_url, settings=get_settings())
    except SecretKeyMissing as exc:
        raise HTTPException(503, "The server has no SECRET_KEY set, so it cannot store provider keys") from exc
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    await session.commit()
    # A job that has only used one model is compared with a cheaper one now, once per job.
    try:
        await start_on_first_key(session, project)
    except Exception:  # the key is saved either way; the scheduler's triggers still run
        await session.rollback()
        log.exception("first-key re-tests were not started", extra={"project_id": project.project_id})
    return _key_out(key)


@app.delete("/v1/provider-key", status_code=204, tags=["retests"])
async def delete_provider_key(
    project: Project = Depends(current_project), session: AsyncSession = Depends(get_session)
) -> None:
    """Remove the key. Running re-tests finish the call in flight; no new ones start."""
    key = await session.get(ProviderKey, project.project_id)
    if key is not None:
        await session.delete(key)
        await session.commit()


@app.get("/v1/jobs/{job}/insights", response_model=JobInsightsOut, tags=["insights"])
async def get_job_insights(
    job: str,
    days: int = Query(default=90, ge=1, le=365, description="How many days back to count"),
    project: Project = Depends(current_project),
    session: AsyncSession = Depends(get_session),
) -> JobInsightsOut:
    """Cost per success per model, and pass rate per model by input-size band and by prompt version,
    each with its run count and 95% interval."""
    found = await _job(session, project, job)
    groups = await job_insights(session, found, days=days)
    return JobInsightsOut(job=found.name, days=days,
                          **{k: [BreakdownOut(**vars(b)) for b in v] for k, v in groups.items()})


def _event_out(e) -> FlowEventOut:
    return FlowEventOut(event_id=e.event_id, ts=e.ts, run_id=e.run_id, stage=e.stage, message=e.message, data=e.data)


@app.get("/v1/flow", response_model=list[FlowEventOut], tags=["flow"])
async def get_flow(
    after: int = Query(default=0, ge=0, description="Only events after this event_id; 0 = the latest ones"),
    limit: int = Query(default=100, ge=1, le=500),
    project: Project = Depends(current_project),
    session: AsyncSession = Depends(get_session),
) -> list[FlowEventOut]:
    """The live data-flow view, polled: each run's steps, oldest first."""
    return [_event_out(e) for e in await flow.events_after(session, project.project_id, after, limit)]


STREAM_POLL_SECONDS = 1.0
STREAM_HEARTBEAT_SECONDS = 15.0
STREAM_CATCH_UP = 200  # events read per query while a viewer catches up from its Last-Event-ID


@app.get("/v1/flow/stream", tags=["flow"], response_class=StreamingResponse)
async def stream_flow(
    request: Request,
    last_event_id: str | None = Header(default=None),
    project: Project = Depends(current_project),
    session: AsyncSession = Depends(get_session),
):
    """Server-Sent Events: each run's steps as they happen. The browser reconnects by itself and
    resumes from Last-Event-ID. Read-only, no WebSockets. Everyone watching a project shares one
    poller (pipeline/flow_hub.py); at most STREAMS_PER_IP connections per IP (429 beyond)."""
    try:
        cursor = int(last_event_id) if last_event_id else 0
    except ValueError:
        cursor = 0
    project_id = project.project_id
    settings = get_settings()
    client = getattr(request, "client", None)
    ip = client.host if client else "unknown"
    if not STREAMS.acquire(ip, settings.streams_per_ip, settings.streams_total):
        raise HTTPException(429, "Too many live views open from here; close one and try again",
                            headers={"Retry-After": "10"})
    try:
        viewer = await HUB.subscribe(project_id, async_sessionmaker(session.bind, expire_on_commit=False))
    except Exception:
        STREAMS.release(ip)
        raise

    def frame(e) -> str:
        return f"id: {e.event_id}\ndata: {json.dumps(_event_out(e).model_dump(mode='json'))}\n\n"

    async def events():
        nonlocal cursor
        try:
            # Catch up once from the database, then take events from the shared poller.
            if cursor == 0:  # start with the recent trail, so the view is not empty
                for e in await flow.events_after(session, project_id, 0, 50):
                    cursor = e.event_id
                    yield frame(e)
            else:
                while True:
                    batch = await flow.events_after(session, project_id, cursor, STREAM_CATCH_UP)
                    for e in batch:
                        cursor = e.event_id
                        yield frame(e)
                    if len(batch) < STREAM_CATCH_UP:
                        break
            await session.rollback()  # the request's connection goes back to the pool for the rest
            quiet = 0.0
            while not await request.is_disconnected():
                if viewer.overflowed:
                    raise Overflowed
                try:
                    e = await asyncio.wait_for(viewer.queue.get(), STREAM_POLL_SECONDS)
                except TimeoutError:
                    quiet += STREAM_POLL_SECONDS
                    if quiet >= STREAM_HEARTBEAT_SECONDS:  # keeps proxies from closing an idle connection
                        quiet = 0.0
                        yield ": still here\n\n"
                    continue
                quiet = 0.0
                if e.event_id > cursor:  # the catch-up may already have sent it
                    cursor = e.event_id
                    yield frame(e)
        except Overflowed:
            return  # the browser reconnects with Last-Event-ID and catches up
        finally:
            await HUB.unsubscribe(project_id, viewer)
            STREAMS.release(ip)

    return StreamingResponse(events(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# --- Usage limits (limits.py) ---

async def _limit_out(session: AsyncSession, limit: UsageLimit) -> UsageLimitOut:
    f = await limit_forecast(session, limit)
    return UsageLimitOut(
        limit_id=limit.limit_id, name=limit.name, window_hours=limit.window_hours, measure=limit.measure,
        size=float(limit.size) if limit.size is not None else None, model=limit.model,
        window_start=f.window_start, resets_at=f.resets_at, used=f.used, share_used=f.share_used,
        rate_per_hour=f.rate_per_hour, hours_to_reset=f.hours_to_reset, hours_to_full=f.hours_to_full,
        state=f.state, message=f.message,
        suggestions=[LimitSuggestionOut(job=x.job, current=x.current, suggested=x.suggested,
                                        share_of_use=x.share_of_use, reduction=x.reduction, note=x.note)
                     for x in f.suggestions],
        hours_to_full_after=f.hours_to_full_after, lasts_after=f.lasts_after,
    )


async def _own_limit(session: AsyncSession, project: Project, limit_id: uuid.UUID) -> UsageLimit:
    limit = await session.get(UsageLimit, limit_id)
    if limit is None or limit.project_id != project.project_id:
        raise HTTPException(404, "No such limit in this project")
    return limit


def _news_times(updated_at):
    return updated_at, (updated_at + news_service.MIN_REFRESH_GAP) if updated_at else None


@app.get("/v1/news", response_model=NewsOut, tags=["news"])
async def get_news(
    source: str | None = Query(default=None, max_length=60, description="Only this source"),
    mine: bool = Query(default=False, description="Only stories naming a model this project uses"),
    model: str | None = Query(default=None, max_length=200,
                              description="Only stories naming this model (e.g. an alert's model)"),
    job: str | None = Query(default=None, max_length=200, description="Only stories naming a model this job uses"),
    since: datetime | None = Query(default=None, description="Only stories published at or after this time"),
    until: datetime | None = Query(default=None, description="Only stories published at or before this time"),
    limit: int = Query(default=60, ge=1, le=200),
    project: Project = Depends(current_project), session: AsyncSession = Depends(get_session),
) -> NewsOut:
    """The latest AI news from public feeds (refreshed hourly), newest first. Stories that name a watched
    model carry it in `affects`: the project's models from the last 90 days, one job's with `job`, or one
    `model`. With `job` or `model` only those stories are returned."""
    job_id = (await _job(session, project, job)).job_id if job else None
    listed, models = await news_service.list_news(
        session, project.project_id, source=source, mine=mine, model=model, job_id=job_id, since=since,
        until=until, limit=limit)
    updated_at, next_at = _news_times(await news_service.last_refreshed(session))
    return NewsOut(
        items=[NewsItemOut(item_id=x.item.item_id, source=x.item.source, kind=x.item.kind, title=x.item.title,
                           link=x.item.link, summary=x.item.summary, published_at=x.item.published_at,
                           affects=x.affects) for x in listed],
        sources=[NewsSourceOut(source=f.source, kind=f.kind) for f in NEWS_FEEDS],
        your_models=models, updated_at=updated_at, next_refresh_at=next_at,
    )


@app.post("/v1/news/refresh", response_model=NewsRefreshOut, tags=["news"])
async def refresh_news(
    project: Project = Depends(current_project), session: AsyncSession = Depends(get_session),
) -> NewsRefreshOut:
    """Fetch the feeds now, unless they were fetched in the last 10 minutes (shared by everyone), in
    which case nothing is fetched and `refreshed` is false."""
    last = await news_service.last_refreshed(session)
    if last is not None and datetime.now(UTC) - last < news_service.MIN_REFRESH_GAP:
        updated_at, next_at = _news_times(last)
        return NewsRefreshOut(refreshed=False, added=0, failed_sources=[], updated_at=updated_at,
                              next_refresh_at=next_at)
    await session.commit()  # end this request's transaction before the fetch, which takes seconds
    result = await news_service.refresh(async_sessionmaker(session.bind, expire_on_commit=False))
    updated_at, next_at = _news_times(await news_service.last_refreshed(session))
    return NewsRefreshOut(refreshed=result.refreshed, added=result.added, failed_sources=result.failed,
                          updated_at=updated_at, next_refresh_at=next_at)


@app.get("/v1/limits", response_model=list[UsageLimitOut], tags=["limits"])
async def list_limits(
    project: Project = Depends(current_project), session: AsyncSession = Depends(get_session)
) -> list[UsageLimitOut]:
    """Every usage limit of the project, with whether it runs out before it resets at the current pace and,
    if so, what to change per job."""
    limits = (await session.execute(
        select(UsageLimit).where(UsageLimit.project_id == project.project_id).order_by(UsageLimit.created_at)
    )).scalars().all()
    return [await _limit_out(session, limit) for limit in limits]


@app.post("/v1/limits", response_model=UsageLimitOut, status_code=201, tags=["limits"])
async def create_limit(
    body: UsageLimitIn, project: Project = Depends(current_project), session: AsyncSession = Depends(get_session)
) -> UsageLimitOut:
    now = datetime.now(UTC)
    limit = UsageLimit(
        project_id=project.project_id, name=body.name.strip(), window_hours=body.window_hours,
        resets_at=body.resets_at, measure=body.measure, model=body.model.strip() if body.model else None,
        size=Decimal(str(body.size)) if body.size is not None else None,
        reported_used=Decimal(str(round(body.used_percent / 100, 4))) if body.used_percent is not None else None,
        reported_at=now if body.used_percent is not None else None,
    )
    session.add(limit)
    await session.commit()
    return await _limit_out(session, limit)


@app.put("/v1/limits/{limit_id}/used", response_model=UsageLimitOut, tags=["limits"])
async def report_limit_used(
    limit_id: uuid.UUID, body: UsedPercentIn, project: Project = Depends(current_project),
    session: AsyncSession = Depends(get_session),
) -> UsageLimitOut:
    """For a plan that only shows a percentage: the share used now, as the plan shows it."""
    limit = await _own_limit(session, project, limit_id)
    if limit.measure != "PERCENT":
        raise HTTPException(422, "Only a PERCENT limit is reported by hand; the others are counted from runs")
    limit.reported_used, limit.reported_at = Decimal(str(round(body.used_percent / 100, 4))), datetime.now(UTC)
    await session.commit()
    return await _limit_out(session, limit)


@app.delete("/v1/limits/{limit_id}", status_code=204, tags=["limits"])
async def delete_limit(
    limit_id: uuid.UUID, project: Project = Depends(current_project), session: AsyncSession = Depends(get_session)
) -> None:
    await session.delete(await _own_limit(session, project, limit_id))
    await session.commit()
