"""Alert records: raised by the regression sweep and the catalog sync, read by the API, delivered by
the notifier. One open alert per finding (the partial unique index on `dedupe_key`), so a sweep that
sees the same regression again does not raise it twice; once resolved, the finding can recur.
"""

from __future__ import annotations

import logging
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from ..catalog.lifecycle import lifecycles, most_used
from ..models import Alert, Job, Recommendation, Run
from ..versions import normalize, same_family

log = logging.getLogger("agent_memory.alerts")


async def raise_alert(
    session: AsyncSession, job: Job, kind: str, dedupe_key: str, detail: dict, *, now: datetime
) -> Alert | None:
    """Store an alert unless the same finding is already open. Returns the new alert, or None."""
    statement = (
        insert(Alert)
        .values(job_id=job.job_id, kind=kind, dedupe_key=dedupe_key, detail=detail, created_at=now,
                next_attempt_at=now)
        .on_conflict_do_nothing(index_elements=["job_id", "dedupe_key"], index_where=Alert.resolved_at.is_(None))
        .returning(Alert.alert_id)
    )
    alert_id = (await session.execute(statement)).scalar_one_or_none()
    if alert_id is None:
        return None
    log.info("alert raised", extra={"job_id": str(job.job_id), "project_id": job.project_id, "kind": kind,
                                    "alert_id": str(alert_id), "summary": detail.get("summary")})
    return await session.get(Alert, alert_id)


async def catalog_alerts(
    session: AsyncSession, status_changes: list[tuple[str, str, str]], *, now: datetime
) -> list[Alert]:
    """MODEL_DEPRECATED for every job whose current recommendation uses a model that was just
    deprecated or retired by the provider that job uses (another provider retiring it is not enough)."""
    raised: list[Alert] = []
    changed = {normalize(model): new for model, old, new in status_changes if new in ("DEPRECATED", "RETIRED")}
    if not changed:
        return raised
    current = (
        await session.execute(
            select(Recommendation, Job).join(Job, Job.job_id == Recommendation.job_id)
            .where(Recommendation.invalid_at.is_(None))
        )
    ).all()
    for rec, job in current:
        for model, status in changed.items():
            if rec.model and (normalize(rec.model_version) == model or same_family(rec.model, model)):
                used = (
                    await session.execute(
                        select(Run.provider).where(Run.job_id == job.job_id, Run.model == rec.model).limit(500)
                    )
                ).scalars().all()
                life = (await lifecycles(session, {model: most_used(list(used))}, today=now.date()))[model]
                if life.status not in ("DEPRECATED", "RETIRED"):
                    continue  # still served by this job's provider
                status = life.status
                verb = "was retired" if status == "RETIRED" else "is deprecated"
                alert = await raise_alert(
                    session, job, "MODEL_DEPRECATED", f"MODEL_DEPRECATED|{model}|{status}",
                    {"model": rec.model, "model_version": rec.model_version, "catalog_model": model,
                     "status": status, "note": life.note,
                     "summary": f"{rec.model}, recommended for {job.name}, {verb}"
                                + (f" ({life.note})" if life.note else "")},
                    now=now,
                )
                if alert:
                    raised.append(alert)
    return raised
