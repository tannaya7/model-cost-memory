"""FastAPI routes: ingest, recommendation, regressions, history, re-test, catalog, insights.

Stateless: every request opens its own database session. Every `/v1` route needs a project key
(`X-API-Key: <key>` or `Authorization: Bearer <key>`) and only ever sees that project's data.
The endpoints are listed in docs/ARCHITECTURE.md and added week by week.
"""

from __future__ import annotations

import base64
import binascii
import uuid
from collections import defaultdict
from contextlib import asynccontextmanager
from datetime import datetime

from fastapi import Depends, FastAPI, Header, HTTPException, Query
from sqlalchemy import func, select, text, tuple_
from sqlalchemy.ext.asyncio import AsyncSession

from . import __version__
from .db import dispose_engine, get_session
from .models import Job, Project, Run
from .schemas import Health, JobOut, RunOut, RunPage
from .security import extract_key, hash_key

PREVIEW_CHARS = 200


@asynccontextmanager
async def lifespan(_: FastAPI):
    yield
    await dispose_engine()


app = FastAPI(title="Model & Cost Memory API", version=__version__, lifespan=lifespan)


async def current_project(
    session: AsyncSession = Depends(get_session),
    x_api_key: str | None = Header(default=None),
    authorization: str | None = Header(default=None),
) -> Project:
    """The project that owns the key in the request, or 401."""
    key = extract_key(x_api_key, authorization)
    project = None
    if key:
        project = (
            await session.execute(select(Project).where(Project.api_key_hash == hash_key(key)))
        ).scalar_one_or_none()
    if project is None:
        raise HTTPException(401, "Missing or invalid project key", headers={"WWW-Authenticate": "Bearer"})
    return project


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
    items = [
        RunOut(
            run_id=r.run_id, job_id=r.job_id, job=job_name, model=r.model, model_version=r.model_version,
            prompt_version=r.prompt_version, tokens_in=r.tokens_in, tokens_out=r.tokens_out,
            cache_read_tokens=r.cache_read_tokens, cache_write_tokens=r.cache_write_tokens,
            cost_usd=float(r.cost_usd), latency_ms=r.latency_ms, outcome=r.outcome,
            outcome_reason=r.outcome_reason, run_kind=r.run_kind, state=r.state, created_at=r.created_at,
            prompt_preview=r.prompt[:PREVIEW_CHARS],
            output_preview=r.output[:PREVIEW_CHARS] if r.output is not None else None,
        )
        for r, job_name in page
    ]
    next_cursor = _encode_cursor(page[-1][0].created_at, page[-1][0].run_id) if more else None
    return RunPage(items=items, next_cursor=next_cursor)
