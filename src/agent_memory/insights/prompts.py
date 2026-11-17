"""Where your tokens went: which prompts use the most tokens, and how much of each is identical in every call.

Production runs only, over the last `days` days. Token sums are exact (billed fields); the repeated-start and
repeated-end shares come from the stored prompt text of the most recent calls and are only computed from
MIN_SAMPLES or more of them. Only the shares and a short preview of the repeated start leave this module.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import Job, Run

MAX_SAMPLES = 50  # most recent calls with stored text used per group
MIN_SAMPLES = 5  # fewer than this and we say nothing about repeated text
PREVIEW_MIN_SHARE = 0.10
PREVIEW_CHARS = 120

_TOTAL = Run.tokens_in + Run.tokens_out + Run.cache_read_tokens + Run.cache_write_tokens


@dataclass
class Repeated:
    start_chars: int
    end_chars: int
    start_share: float
    end_share: float
    start_text: str


def _prefix_ok(prompts: list[str], n: int) -> bool:
    return all(n == len(p) or p[n].isspace() or p[n - 1].isspace() for p in prompts)


def _suffix_ok(prompts: list[str], n: int) -> bool:
    return all(n == len(p) or p[len(p) - n - 1].isspace() or p[len(p) - n].isspace() for p in prompts)


def common_prefix_len(prompts: list[str]) -> int:
    """Length of the longest common start, cut back so no word is split."""
    if not prompts:
        return 0
    n = 0
    shortest = min(len(p) for p in prompts)
    first = prompts[0]
    while n < shortest and all(p[n] == first[n] for p in prompts):
        n += 1
    while n > 0 and not _prefix_ok(prompts, n):
        n -= 1
    return n


def common_suffix_len(prompts: list[str], cap: int | None = None) -> int:
    """Length of the longest common end (at most `cap`), cut back so no word is split."""
    if not prompts:
        return 0
    shortest = min(len(p) for p in prompts)
    limit = shortest if cap is None else max(0, min(cap, shortest))
    first = prompts[0]
    n = 0
    while n < limit and all(p[len(p) - 1 - n] == first[len(first) - 1 - n] for p in prompts):
        n += 1
    while n > 0 and not _suffix_ok(prompts, n):
        n -= 1
    return n


def _preview(text: str) -> str:
    flat = " ".join(text.split())
    return flat if len(flat) <= PREVIEW_CHARS else flat[: PREVIEW_CHARS - 1].rstrip() + "…"


def repeated_parts(prompts: list[str]) -> Repeated | None:
    """What every prompt starts and ends with. None when there are too few prompts to say."""
    if len(prompts) < MIN_SAMPLES:
        return None
    mean = sum(len(p) for p in prompts) / len(prompts)
    if mean == 0:
        return Repeated(0, 0, 0.0, 0.0, "")
    start = common_prefix_len(prompts)
    # the end must not overlap the start in any single prompt
    end = common_suffix_len(prompts, cap=min(len(p) for p in prompts) - start)
    return Repeated(
        start, end,
        round(min(1.0, max(0.0, start / mean)), 3), round(min(1.0, max(0.0, end / mean)), 3),
        prompts[0][:start],
    )


@dataclass
class PromptGroup:
    job: str
    prompt_version: str | None
    calls: int
    tokens_in: int
    tokens_out: int
    cache_read_tokens: int
    cache_write_tokens: int
    total_tokens: int
    share: float
    avg_tokens_in: float
    avg_tokens_out: float
    cache_read_share: float | None
    text_samples: int
    repeated_start_share: float | None
    repeated_end_share: float | None
    repeated_start_preview: str | None


@dataclass
class PromptInsights:
    days: int
    total_tokens: int
    groups: list[PromptGroup]


async def prompt_insights(
    session: AsyncSession, project_id: str, *, days: int = 30, job: str | None = None, limit: int = 3,
    now: datetime | None = None,
) -> PromptInsights:
    since = (now or datetime.now(UTC)) - timedelta(days=days)
    scope = (Run.project_id == project_id, Run.run_kind == "PRODUCTION", Run.created_at >= since)

    grand = int((await session.execute(select(func.coalesce(func.sum(_TOTAL), 0)).where(*scope))).scalar_one())

    total = func.coalesce(func.sum(_TOTAL), 0).label("total")
    query = (
        select(Job.name, Run.job_id, Run.prompt_version, func.count(),
               func.coalesce(func.sum(Run.tokens_in), 0), func.coalesce(func.sum(Run.tokens_out), 0),
               func.coalesce(func.sum(Run.cache_read_tokens), 0), func.coalesce(func.sum(Run.cache_write_tokens), 0),
               total)
        .join(Job, Job.job_id == Run.job_id).where(*scope)
        .group_by(Job.name, Run.job_id, Run.prompt_version)
        .order_by(total.desc(), Job.name, Run.prompt_version).limit(limit)
    )
    if job is not None:
        query = query.where(Job.name == job)
    rows = (await session.execute(query)).all()

    groups: list[PromptGroup] = []
    for name, job_id, version, calls, t_in, t_out, c_read, c_write, tot in rows:
        t_in, t_out, c_read, c_write, tot = int(t_in), int(t_out), int(c_read), int(c_write), int(tot)
        same_version = Run.prompt_version.is_(None) if version is None else Run.prompt_version == version
        texts = (
            await session.execute(
                select(Run.prompt).where(*scope, Run.job_id == job_id, same_version,
                                         Run.content_removed_at.is_(None), Run.prompt.is_not(None))
                .order_by(Run.created_at.desc()).limit(MAX_SAMPLES)
            )
        ).scalars().all()
        found = repeated_parts(list(texts))
        denom = c_read + t_in
        groups.append(PromptGroup(
            job=name, prompt_version=version, calls=calls, tokens_in=t_in, tokens_out=t_out,
            cache_read_tokens=c_read, cache_write_tokens=c_write, total_tokens=tot,
            share=tot / grand if grand else 0.0,
            avg_tokens_in=t_in / calls if calls else 0.0, avg_tokens_out=t_out / calls if calls else 0.0,
            cache_read_share=c_read / denom if denom else None,
            text_samples=len(texts),
            repeated_start_share=found.start_share if found else None,
            repeated_end_share=found.end_share if found else None,
            repeated_start_preview=(
                _preview(found.start_text) if found and found.start_share >= PREVIEW_MIN_SHARE and found.start_text.strip()
                else None
            ),
        ))
    return PromptInsights(days=days, total_tokens=grand, groups=groups)
