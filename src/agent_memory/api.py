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
import logging
import secrets
import uuid
from collections import defaultdict
from contextlib import asynccontextmanager
from datetime import UTC, datetime

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from sqlalchemy import func, select, text, tuple_
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.middleware.sessions import SessionMiddleware

from . import __version__, ingest
from .db import dispose_engine, get_session
from .insights.service import job_insights, spend_by_job
from .logging_config import configure_logging, set_context
from .models import Alert, CatalogEntry, Job, Project, ProviderKey, Retest, Run
from .recommend.cache import cached_recommend
from .recommend.engine import JobRecommendation, ModelEvidence
from .recommend.summary import summarize
from .retest import keys as provider_keys
from .retest.runner import RetestRefused, enqueue, spent_this_month, start_on_first_key
from .schemas import (
    AlertOut,
    BreakdownOut,
    FlowEventOut,
    ForecastOut,
    Health,
    HistoryEntryOut,
    HistoryOut,
    JobCreate,
    JobInsightsOut,
    JobOut,
    LabelCreate,
    ModelEvidenceOut,
    ModelOut,
    ModelPage,
    ModelRef,
    ModelVersionSeen,
    ProviderKeyIn,
    ProviderKeyOut,
    RecommendationEvidence,
    RecommendationOut,
    RecommendationRules,
    RetestCreate,
    RetestLimits,
    RetestOut,
    RunAccepted,
    RunCreate,
    RunDetail,
    RunOut,
    RunPage,
    SpendOut,
)
from .auth import routes as auth_routes
from .auth.access import current_project
from .config import get_settings
from .security import SecretKeyMissing
from .pipeline import flow
from .storage import lineage
from .versions import normalize

PREVIEW_CHARS = 200
log = logging.getLogger("agent_memory.api")


@asynccontextmanager
async def lifespan(_: FastAPI):
    configure_logging()
    yield
    await dispose_engine()


app = FastAPI(title="Model & Cost Memory API", version=__version__, lifespan=lifespan)


def _session_secret() -> str:
    secret = get_settings().secret_key
    if not secret:
        log.warning("SECRET_KEY is not set: sign-in sessions will not survive a restart")
        return secrets.token_urlsafe(32)
    return secret


# The signed session cookie: httpOnly (Starlette's default), SameSite=Lax, Secure on an https site.
app.add_middleware(
    SessionMiddleware, secret_key=_session_secret(), session_cookie="mcm_session", same_site="lax",
    https_only=get_settings().public_url.startswith("https://"), max_age=14 * 24 * 3600,
)
app.include_router(auth_routes.router)


@app.get("/healthz", response_model=Health, tags=["system"])
async def healthz(session: AsyncSession = Depends(get_session)) -> Health:
    await session.execute(text("SELECT 1"))
    return Health(status="ok")


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


def _run_fields(r: Run, job_name: str) -> dict:
    return dict(
        run_id=r.run_id, job_id=r.job_id, job=job_name, model=r.model, model_version=r.model_version,
        prompt_version=r.prompt_version, tokens_in=r.tokens_in, tokens_out=r.tokens_out,
        cache_read_tokens=r.cache_read_tokens, cache_write_tokens=r.cache_write_tokens,
        cost_usd=float(r.cost_usd) if r.cost_usd is not None else None, latency_ms=r.latency_ms, outcome=r.outcome,
        outcome_reason=r.outcome_reason, run_kind=r.run_kind, state=r.state, created_at=r.created_at,
        prompt_preview=r.prompt[:PREVIEW_CHARS],
        output_preview=r.output[:PREVIEW_CHARS] if r.output is not None else None,
    )


def _run_out(r: Run, job_name: str) -> RunOut:
    return RunOut(**_run_fields(r, job_name))


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
    items = [_run_out(r, job_name) for r, job_name in page]
    next_cursor = _encode_cursor(page[-1][0].created_at, page[-1][0].run_id) if more else None
    return RunPage(items=items, next_cursor=next_cursor)


@app.post("/v1/jobs", response_model=JobOut, status_code=201, tags=["jobs"])
async def create_job_endpoint(
    body: JobCreate,
    project: Project = Depends(current_project),
    session: AsyncSession = Depends(get_session),
) -> JobOut:
    """Define a job and how a correct answer is recognised."""
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
    """Record one model call. Safe to retry: the same `run_id` is only ever stored once."""
    try:
        stored = await ingest.record_run(session, project, body)
    except ingest.UnknownJob as exc:
        raise HTTPException(404, f"Unknown job '{body.job}'. Create it first with POST /v1/jobs") from exc
    await session.commit()
    return RunAccepted(run_id=body.run_id, status="accepted" if stored else "duplicate")


@app.get("/v1/runs/{run_id}", response_model=RunDetail, tags=["runs"])
async def get_run(
    run_id: uuid.UUID,
    project: Project = Depends(current_project),
    session: AsyncSession = Depends(get_session),
) -> RunDetail:
    """One run in full: the whole prompt and output, and why it passed or failed."""
    run = (
        await session.execute(select(Run).where(Run.run_id == run_id, Run.project_id == project.project_id))
    ).scalar_one_or_none()
    if run is None:
        raise HTTPException(404, "Run not found")
    return RunDetail(
        **_run_fields(run, await _job_name(session, run.job_id, project.project_id)),
        prompt=run.prompt, output=run.output, tool_calls=run.tool_calls,
    )


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
    items = [
        ModelOut(
            model=m.model, model_version=m.model_version, provider=m.provider, status=m.status,
            shutdown_date=m.shutdown_date,
            price_in_per_mtok=float(m.price_in_per_mtok) if m.price_in_per_mtok is not None else None,
            price_out_per_mtok=float(m.price_out_per_mtok) if m.price_out_per_mtok is not None else None,
            source=m.source, first_seen_at=m.first_seen_at, used_by_project=m.model in used_names,
        )
        for m in page
    ]
    next_cursor = None
    if more:
        next_cursor = base64.urlsafe_b64encode(f"{page[-1].model}|{page[-1].model_version}".encode()).decode()
    return ModelPage(items=items, next_cursor=next_cursor)


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
            )
            for m in d.models
        ],
        evidence=RecommendationEvidence(
            n_runs=r.n_runs, evidence_weight=r.evidence_weight, floor=r.settings.evidence_floor,
            failing_runs=[vars(f) for f in r.failing_runs],
        ),
        progress=d.progress, retest_candidates=d.retest_candidates,
        forecast=ForecastOut(**vars(r.forecast)) if r.forecast else None, summary=summary,
        summary_prompt_version=summary_version, warnings=d.warnings,
        next_step=d.next_step, computed_at=r.computed_at,
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
    result = await cached_recommend(session, await _job(session, project, job))
    log.info("verdict served", extra={"verdict": result.decision.verdict, "n_runs": result.n_runs,
                                      "evidence_weight": round(result.evidence_weight, 2)})
    return _recommendation_out(result, *await summarize(result, get_settings()))


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


def _alert_out(alert: Alert, job_name: str) -> AlertOut:
    return AlertOut(
        alert_id=alert.alert_id, job=job_name, kind=alert.kind, summary=alert.detail.get("summary", alert.kind),
        detail=alert.detail, created_at=alert.created_at, delivered_at=alert.delivered_at,
        delivery_attempts=alert.delivery_attempts, resolved_at=alert.resolved_at,
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
    return RetestOut(
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
    session: AsyncSession = Depends(get_session),
) -> RetestOut:
    """Queue a re-test: replay sampled past runs on `candidate_model`, spending at most `budget_usd`.

    409 with `{"code", "message"}` when it cannot start; `code` is one of consent_off, project_off,
    not_checkable, provider_key_required (ask for the key, then try again), cap_reached, already_running.
    Poll `GET /v1/jobs/{job}/retest/{id}` for progress.
    """
    found = await _job(session, project, job)
    try:
        row = await enqueue(session, project, found, body.candidate_model, body.budget_usd, "MANUAL")
    except RetestRefused as exc:
        raise HTTPException(409, {"code": exc.code, "message": str(exc)}) from exc
    row.runs_planned = body.sample_size or get_settings().retest_default_sample
    await session.commit()
    return await _retest_out(session, row, found.name, project)


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
    project: Project = Depends(current_project), session: AsyncSession = Depends(get_session)
) -> RetestLimits:
    """This month's re-test cap, what is spent, and whether the provider key has been given."""
    cap, spent = float(project.retest_monthly_cap_usd), float(await spent_this_month(session, project.project_id))
    return RetestLimits(monthly_cap_usd=cap, spent_this_month_usd=spent, cap_remaining_usd=max(cap - spent, 0.0),
                        retest_allowed=project.retest_allowed,
                        provider_key=_key_out(await session.get(ProviderKey, project.project_id)))


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


@app.get("/v1/flow/stream", tags=["flow"], response_class=StreamingResponse)
async def stream_flow(
    request: Request,
    last_event_id: str | None = Header(default=None),
    project: Project = Depends(current_project),
    session: AsyncSession = Depends(get_session),
):
    """Server-Sent Events: each run's steps as they happen. The browser reconnects by itself and
    resumes from Last-Event-ID. Read-only, one short query a second, no WebSockets."""
    try:
        cursor = int(last_event_id) if last_event_id else 0
    except ValueError:
        cursor = 0
    project_id = project.project_id

    def frame(e) -> str:
        return f"id: {e.event_id}\ndata: {json.dumps(_event_out(e).model_dump(mode='json'))}\n\n"

    async def events():
        nonlocal cursor
        quiet = 0.0
        if cursor == 0:  # start with the recent trail, so the view is not empty
            for e in await flow.events_after(session, project_id, 0, 50):
                cursor = e.event_id
                yield frame(e)
        while not await request.is_disconnected():
            await session.rollback()  # end the read so the next poll sees new rows
            fresh = await flow.events_after(session, project_id, cursor, 200)
            for e in fresh:
                cursor = e.event_id
                yield frame(e)
            quiet = 0.0 if fresh else quiet + STREAM_POLL_SECONDS
            if quiet >= STREAM_HEARTBEAT_SECONDS:  # keeps proxies from closing an idle connection
                quiet = 0.0
                yield ": still here\n\n"
            await asyncio.sleep(STREAM_POLL_SECONDS)

    return StreamingResponse(events(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
