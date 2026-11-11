"""AlertNotifier: posts alerts to the project's webhook, signed with a shared secret, retried with
backoff. The alert stays open and visible from the API whether or not delivery succeeds.

Payload: {"alert_id", "kind", "job", "detail", "created_at", "text", "content"} as JSON. `text` and
`content` carry the same one-line message, so the URL can be a Slack, Google Chat, Mattermost (`text`)
or Discord (`content`) incoming webhook as well as your own endpoint. Figures and run ids only, never
prompt text. Header `X-MCM-Signature: sha256=<hex HMAC-SHA256 of the body with the project's
webhook_secret>`, so the receiver can check the message is ours.

Backoff after a failed attempt: 1, 2, 4, ... minutes, capped at 6 hours, with up to 20% jitter.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import random
from datetime import UTC, datetime, timedelta

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import Alert, Job, Project

log = logging.getLogger("agent_memory.alerts")
MAX_BACKOFF = timedelta(hours=6)
BATCH = 50


def sign(secret: str, body: bytes) -> str:
    return "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()


KIND_LABELS = {
    "VERSION_REGRESSION": "Regression after a model upgrade",
    "SILENT_DROP": "Pass rate dropped with no version change",
    "MODEL_DEPRECATED": "Recommended model is being retired",
}


def chat_line(alert: Alert, job_name: str) -> str:
    """One readable line for a chat channel: what happened, to which job, with the figures."""
    summary = alert.detail.get("summary") or alert.kind
    return f"{KIND_LABELS.get(alert.kind, alert.kind)} in {job_name}: {summary}"


def backoff(attempts: int) -> timedelta:
    base = min(timedelta(minutes=2 ** max(attempts - 1, 0)), MAX_BACKOFF)
    return base * (1 + random.uniform(0, 0.2))


async def deliver_pending(
    session: AsyncSession, *, now: datetime | None = None, transport: httpx.AsyncBaseTransport | None = None
) -> tuple[int, int]:
    """Try every open, undelivered alert that is due. Returns (delivered, failed)."""
    now = now or datetime.now(UTC)
    due = (
        await session.execute(
            select(Alert, Job.name, Project.webhook_url, Project.webhook_secret)
            .join(Job, Job.job_id == Alert.job_id).join(Project, Project.project_id == Job.project_id)
            .where(Alert.delivered_at.is_(None), Alert.resolved_at.is_(None), Project.webhook_url.is_not(None),
                   (Alert.next_attempt_at.is_(None)) | (Alert.next_attempt_at <= now))
            .order_by(Alert.created_at).limit(BATCH).with_for_update(of=Alert, skip_locked=True)
        )
    ).all()
    delivered = failed = 0
    async with httpx.AsyncClient(timeout=10, transport=transport) as client:
        for alert, job_name, url, secret in due:
            body = json.dumps({
                "alert_id": str(alert.alert_id), "kind": alert.kind, "job": job_name, "detail": alert.detail,
                "created_at": alert.created_at.isoformat(),
                # Chat incoming webhooks show one of these: Slack, Google Chat and Mattermost read `text`,
                # Discord reads `content`. Other receivers use the fields above.
                "text": chat_line(alert, job_name), "content": chat_line(alert, job_name),
            }, sort_keys=True).encode()
            headers = {"Content-Type": "application/json"}
            if secret:
                headers["X-MCM-Signature"] = sign(secret, body)
            alert.delivery_attempts += 1
            try:
                response = await client.post(url, content=body, headers=headers)
                response.raise_for_status()
            except httpx.HTTPError as exc:
                alert.last_error = str(exc)[:500]
                alert.next_attempt_at = now + backoff(alert.delivery_attempts)
                failed += 1
                log.warning("webhook delivery failed; will retry",
                            extra={"alert_id": str(alert.alert_id), "attempts": alert.delivery_attempts,
                                   "next_attempt_at": alert.next_attempt_at.isoformat()})
            else:
                alert.delivered_at, alert.last_error = now, None
                delivered += 1
                log.info("alert delivered", extra={"alert_id": str(alert.alert_id), "kind": alert.kind})
    await session.commit()
    return delivered, failed
