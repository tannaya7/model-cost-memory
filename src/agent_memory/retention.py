"""What the system keeps about a customer, and how it lets go of it.

**Retention.** Each project keeps a run's content for `content_retention_days` (90 by default). After
that, `clear_old_content` empties the prompt, the answer, the tool calls, the answer key and the prompt
embedding, and stamps `content_removed_at`. The figures the statistics read stay: pass/fail and its
reason, model and version, tokens, cost, latency and the prompt's hash. So recommendations, decay and
regression checks are unchanged; only re-tests (which replay old prompts) and similar-run search lose
the cleared runs, and both already skip them. The scheduler runs it daily, in batches.

**Deletion.** `delete_project` removes a project and everything recorded under it in one transaction,
children first because the tables reference each other. It is what an erasure request needs (GDPR
Article 17); the web app offers it to the project's owner, `scripts/delete_project.py` to the operator.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime

from sqlalchemy import delete, func, literal, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from .models import (
    Alert,
    FlowEvent,
    Job,
    OutboxRow,
    Project,
    ProviderKey,
    Recommendation,
    RecommendationSummary,
    Retest,
    Run,
    UsageLimit,
)

log = logging.getLogger("agent_memory.retention")

DEFAULT_RETENTION_DAYS = 90
BATCH = 5000  # runs cleared per statement, so no single update holds its locks for long


async def clear_old_content(session: AsyncSession, *, now: datetime | None = None, batch: int = BATCH,
                            max_batches: int = 200) -> int:
    """Clear the content of runs older than their project's retention. Returns how many runs were
    cleared. Commits after every batch."""
    now = now or datetime.now(UTC)
    # make_interval(years, months, weeks, days): each project's own retention.
    cutoff = literal(now, Run.created_at.type) - func.make_interval(0, 0, 0, Project.content_retention_days)
    total = 0
    for _ in range(max_batches):
        due = (
            select(Run.run_id)
            .join(Project, Project.project_id == Run.project_id)
            .where(Run.content_removed_at.is_(None), Run.created_at < cutoff)
            .limit(batch)
            .with_for_update(of=Run, skip_locked=True)
            .scalar_subquery()
        )
        result = await session.execute(
            update(Run).where(Run.run_id.in_(due))
            .values(prompt=None, output=None, tool_calls=None, expected=None, embedding=None,
                    content_removed_at=now)
            .execution_options(synchronize_session=False)
        )
        await session.commit()
        total += result.rowcount
        if result.rowcount < batch:
            break
    if total:
        log.info("cleared old run content", extra={"runs": total})
    return total


async def delete_project(session: AsyncSession, project_id: str) -> bool:
    """Delete a project and everything recorded under it. False when there is no such project. The
    caller commits (the API) or this is the whole transaction (the script)."""
    if await session.get(Project, project_id) is None:
        return False
    jobs = select(Job.job_id).where(Job.project_id == project_id).scalar_subquery()
    runs = select(Run.run_id).where(Run.project_id == project_id).scalar_subquery()
    # Children before parents: outbox -> runs -> retests -> jobs, recommendations point at each other.
    await session.execute(delete(OutboxRow).where(OutboxRow.run_id.in_(runs)))
    await session.execute(delete(FlowEvent).where(FlowEvent.project_id == project_id))
    await session.execute(delete(RecommendationSummary).where(RecommendationSummary.job_id.in_(jobs)))
    await session.execute(delete(Alert).where(Alert.job_id.in_(jobs)))
    await session.execute(update(Recommendation).where(Recommendation.job_id.in_(jobs))
                          .values(superseded_by_id=None))
    await session.execute(delete(Recommendation).where(Recommendation.job_id.in_(jobs)))
    await session.execute(delete(Run).where(Run.project_id == project_id))
    await session.execute(delete(Retest).where(Retest.project_id == project_id))
    await session.execute(delete(Job).where(Job.project_id == project_id))
    await session.execute(delete(UsageLimit).where(UsageLimit.project_id == project_id))
    await session.execute(delete(ProviderKey).where(ProviderKey.project_id == project_id))
    await session.execute(delete(Project).where(Project.project_id == project_id))
    log.info("project deleted", extra={"project_id": project_id})
    return True


async def remaining_rows(session: AsyncSession, project_id: str) -> dict[str, int]:
    """Rows still referring to a project, table by table (used by tests and the delete script)."""
    out = {}
    for table in ("jobs", "runs", "retests", "usage_limits", "provider_keys", "flow_events", "projects"):
        out[table] = (await session.execute(
            text(f"SELECT count(*) FROM {table} WHERE project_id = :p"), {"p": project_id})).scalar_one()
    return out
