"""AlertNotifier: posts alerts to the project's webhook, signed with a shared secret, retried with
backoff. The alert stays open and visible from the API whether or not delivery succeeds.

Payload: {"alert_id", "kind", "job", "detail", "created_at", "text", "content"} as JSON. `text` and
`content` carry the same one-line message, so the URL can be a Slack, Google Chat, Mattermost (`text`)
or Discord (`content`) incoming webhook as well as your own endpoint. Figures and run ids only, never
prompt text. Header `X-MCM-Signature: sha256=<hex HMAC-SHA256 of the body with the project's
webhook_secret>`, so the receiver can check the message is ours.

Backoff after a failed attempt: 1, 2, 4, ... minutes, capped at 6 hours, with up to 20% jitter. After
MAX_ATTEMPTS failures (about a day and a half) delivery gives up (`delivery_failed_at`): the alert stays
open in the web app, and saving a new webhook URL tries every given-up alert again.

Sends run in parallel (SEND_CONCURRENCY at a time, each with a 10-second timeout), so one slow
webhook cannot hold up the others. Each URL is checked again right before sending (urls.py): a host
re-pointed at a private address after it was saved is refused, not called.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import random
from datetime import UTC, datetime, timedelta

import httpx
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import get_settings
from ..models import Alert, Job, Project
from ..urls import UnsafeUrl, check_outbound

log = logging.getLogger("agent_memory.alerts")
MAX_BACKOFF = timedelta(hours=6)
MAX_ATTEMPTS = 10
SEND_CONCURRENCY = 10
TIMEOUT_SECONDS = 10
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


def _describe(exc: Exception) -> str:
    """What went wrong, for the server's own record (never returned by the API)."""
    if isinstance(exc, httpx.HTTPStatusError):
        return f"the webhook answered HTTP {exc.response.status_code}"
    if isinstance(exc, httpx.TimeoutException):
        return f"the webhook did not answer within {TIMEOUT_SECONDS} s"
    if isinstance(exc, UnsafeUrl):
        return str(exc)
    return f"the webhook could not be reached ({type(exc).__name__})"


async def retry_given_up_alerts(session: AsyncSession, project_id: str) -> None:
    """A new webhook URL: try every open alert that gave up, from the start."""
    jobs = select(Job.job_id).where(Job.project_id == project_id)
    await session.execute(
        update(Alert).where(Alert.job_id.in_(jobs), Alert.delivered_at.is_(None), Alert.resolved_at.is_(None),
                            Alert.delivery_failed_at.is_not(None))
        .values(delivery_failed_at=None, delivery_attempts=0, next_attempt_at=None, last_error=None)
    )


async def deliver_pending(
    session: AsyncSession, *, now: datetime | None = None, transport: httpx.AsyncBaseTransport | None = None
) -> tuple[int, int]:
    """Try every open, undelivered alert that is due. Returns (delivered, failed)."""
    now = now or datetime.now(UTC)
    allow_private = get_settings().allow_private_urls
    due = (
        await session.execute(
            select(Alert, Job.name, Project.webhook_url, Project.webhook_secret)
            .join(Job, Job.job_id == Alert.job_id).join(Project, Project.project_id == Job.project_id)
            .where(Alert.delivered_at.is_(None), Alert.resolved_at.is_(None), Alert.delivery_failed_at.is_(None),
                   Project.webhook_url.is_not(None),
                   (Alert.next_attempt_at.is_(None)) | (Alert.next_attempt_at <= now))
            .order_by(Alert.created_at).limit(BATCH).with_for_update(of=Alert, skip_locked=True)
        )
    ).all()
    gate = asyncio.Semaphore(SEND_CONCURRENCY)

    async def send(client: httpx.AsyncClient, alert: Alert, job_name: str, url: str, secret: str | None):
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
        async with gate:
            try:
                await check_outbound(url, allow_private=allow_private)
                response = await client.post(url, content=body, headers=headers)
                response.raise_for_status()
            except (httpx.HTTPError, UnsafeUrl) as exc:
                return alert, exc
        return alert, None

    delivered = failed = 0
    # Redirects are not followed: a webhook that redirects could point the server anywhere.
    async with httpx.AsyncClient(timeout=TIMEOUT_SECONDS, transport=transport, follow_redirects=False) as client:
        results = await asyncio.gather(*(send(client, *row) for row in due))
    for alert, exc in results:
        alert.delivery_attempts += 1
        if exc is None:
            alert.delivered_at, alert.last_error = now, None
            delivered += 1
            log.info("alert delivered", extra={"alert_id": str(alert.alert_id), "kind": alert.kind})
            continue
        failed += 1
        alert.last_error = _describe(exc)[:500]
        if alert.delivery_attempts >= MAX_ATTEMPTS:
            alert.delivery_failed_at, alert.next_attempt_at = now, None
            log.warning("webhook delivery gave up", extra={"alert_id": str(alert.alert_id),
                                                            "attempts": alert.delivery_attempts,
                                                            "error": alert.last_error})
        else:
            alert.next_attempt_at = now + backoff(alert.delivery_attempts)
            log.warning("webhook delivery failed; will retry",
                        extra={"alert_id": str(alert.alert_id), "attempts": alert.delivery_attempts,
                               "next_attempt_at": alert.next_attempt_at.isoformat(), "error": alert.last_error})
    await session.commit()
    return delivered, failed
