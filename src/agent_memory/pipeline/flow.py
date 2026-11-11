"""The live data-flow view: a trail of each run crossing the pipeline (technical plan 3.14, Week 12).

    sdk          the call was recorded (by the SDK, or by the re-test runner)
    api          the API accepted it and queued it (run + outbox row in one transaction)
    check        its outcome was decided, with the reason
    index        the sync worker embedded it: searchable
    consolidate  the job's stored recommendation changed because of new evidence

Each event is added in the same transaction as the step it describes, so the view never shows a
step that did not happen. The janitor deletes events after a day: they are a view, not evidence.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import FlowEvent

RETENTION = timedelta(days=1)


def emit(session: AsyncSession, project_id: str, stage: str, message: str, *, run_id=None,
         data: dict | None = None) -> None:
    session.add(FlowEvent(project_id=project_id, run_id=run_id, stage=stage, message=message, data=data))


async def events_after(session: AsyncSession, project_id: str, after: int, limit: int) -> list[FlowEvent]:
    """Events newer than `after`, oldest first. With after=0, the most recent `limit` events."""
    query = select(FlowEvent).where(FlowEvent.project_id == project_id)
    if after > 0:
        rows = (await session.execute(query.where(FlowEvent.event_id > after)
                                      .order_by(FlowEvent.event_id).limit(limit))).scalars().all()
        return list(rows)
    rows = (await session.execute(query.order_by(FlowEvent.event_id.desc()).limit(limit))).scalars().all()
    return list(reversed(rows))


async def purge(session: AsyncSession, *, now: datetime | None = None) -> int:
    result = await session.execute(delete(FlowEvent).where(FlowEvent.ts < (now or datetime.now(UTC)) - RETENTION))
    await session.commit()
    return result.rowcount
