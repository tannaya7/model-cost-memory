"""Abuse limits for a public server: request rate, body size, daily runs, and live streams.

Kept in the API process's memory, which is right for the one API process this system runs (deploy/).
Behind several processes each would count on its own, so the limits would loosen by that factor.

- **Request rate** (`RateLimitMiddleware`): a token bucket per caller on `/v1/*` and `/auth/*`. A caller is
  its project key when it sends one (the SDK can send a burst of runs, so keys get a higher rate), and
  otherwise its IP address (the web app, the demo, anyone probing). Over the limit: 429 with Retry-After.
- **Body size**: a request body over MAX_BODY_BYTES is refused with 413, whether or not it declares its
  length. Caddy refuses larger bodies first (deploy/Caddyfile); this covers a server without it.
- **Runs per day** (`DailyRuns`): a project may record at most `runs_per_day_per_project` runs per UTC
  day. The count starts from the database on a project's first run of the day, then counts in memory.
- **Live streams** (`StreamSlots`): a few `/v1/flow/stream` connections per IP and a ceiling in all.
"""

from __future__ import annotations

import hashlib
import json
import math
import time
from collections.abc import Awaitable, Callable
from datetime import UTC, date, datetime

from .config import Settings, get_settings
from .security import extract_key

MAX_BODY_BYTES = 5 * 1024 * 1024  # a run with a long document prompt and its output fits easily
LIMITED_PREFIXES = ("/v1/", "/auth/")
MAX_TRACKED = 50_000  # callers remembered at once; idle ones are dropped first


class TokenBuckets:
    """`rate` tokens a minute per key, holding at most `rate` (one minute's burst)."""

    def __init__(self, clock: Callable[[], float] = time.monotonic):
        self._clock = clock
        self._buckets: dict[str, tuple[float, float]] = {}  # key -> (tokens, last refill)

    def take(self, key: str, rate: int) -> float:
        """Spend one token. Returns 0 when allowed, else the seconds until a token is available."""
        now = self._clock()
        tokens, last = self._buckets.get(key, (float(rate), now))
        tokens = min(float(rate), tokens + (now - last) * rate / 60.0)
        if tokens >= 1.0:
            self._buckets[key] = (tokens - 1.0, now)
            self._prune(now)
            return 0.0
        self._buckets[key] = (tokens, now)
        return (1.0 - tokens) * 60.0 / rate

    def _prune(self, now: float) -> None:
        if len(self._buckets) <= MAX_TRACKED:
            return
        # A bucket idle for a minute is full again, so forgetting it changes nothing.
        self._buckets = {k: v for k, v in self._buckets.items() if now - v[1] < 60.0}

    def clear(self) -> None:
        self._buckets.clear()


def client_ip(scope: dict) -> str:
    client = scope.get("client")
    return client[0] if client else "unknown"


def caller(scope: dict) -> tuple[str, bool]:
    """(bucket key, has a project key). The key itself is never stored, only a hash of it."""
    headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope.get("headers", [])}
    key = extract_key(headers.get("x-api-key"), headers.get("authorization"))
    if key:
        return "key:" + hashlib.sha256(key.encode()).hexdigest()[:32], True
    return "ip:" + client_ip(scope), False


async def _send_json(send, status: int, detail: str, extra_headers: list[tuple[bytes, bytes]] = ()) -> None:
    body = json.dumps({"detail": detail}).encode()
    await send({"type": "http.response.start", "status": status,
                "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode()),
                            *extra_headers]})
    await send({"type": "http.response.body", "body": body})


class BodyTooLarge(Exception):
    pass


class RateLimitMiddleware:
    """Plain ASGI (not BaseHTTPMiddleware), so streaming responses pass through unbuffered."""

    def __init__(self, app, *, settings_factory: Callable[[], Settings] = get_settings,
                 buckets: TokenBuckets | None = None):
        self.app = app
        self.settings_factory = settings_factory
        self.buckets = buckets or BUCKETS

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] != "http" or not scope.get("path", "").startswith(LIMITED_PREFIXES):
            await self.app(scope, receive, send)
            return
        settings = self.settings_factory()
        key, keyed = caller(scope)
        rate = settings.rate_limit_key_per_minute if keyed else settings.rate_limit_ip_per_minute
        if rate > 0:
            wait = self.buckets.take(key, rate)
            if wait > 0:
                await _send_json(send, 429, "Too many requests; slow down and try again shortly",
                                 [(b"retry-after", str(max(1, math.ceil(wait))).encode())])
                return
        declared = next((v for k, v in scope.get("headers", []) if k.lower() == b"content-length"), None)
        if declared is not None:
            try:
                if int(declared) > MAX_BODY_BYTES:
                    await _send_json(send, 413, f"Request body over {MAX_BODY_BYTES // (1024 * 1024)} MB")
                    return
            except ValueError:
                await _send_json(send, 400, "Bad Content-Length")
                return
        received = 0
        started = False

        async def counted_receive():
            nonlocal received
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > MAX_BODY_BYTES:
                    raise BodyTooLarge
            return message

        async def tracking_send(message):
            nonlocal started
            if message["type"] == "http.response.start":
                started = True
            await send(message)

        try:
            await self.app(scope, counted_receive, tracking_send)
        except BodyTooLarge:
            if not started:
                await _send_json(send, 413, f"Request body over {MAX_BODY_BYTES // (1024 * 1024)} MB")


class DailyRuns:
    """Runs recorded per project per UTC day, to refuse runs over the daily limit."""

    def __init__(self):
        self._day: date | None = None
        self._counts: dict[str, int] = {}

    async def admit(self, project_id: str, limit: int, count_today: Callable[[datetime], Awaitable[int]],
                    now: datetime | None = None) -> bool:
        """True and counted when the project may record one more run today; False when it may not."""
        now = now or datetime.now(UTC)
        today = now.date()
        if self._day != today:
            self._day, self._counts = today, {}
        if project_id not in self._counts:
            self._counts[project_id] = await count_today(datetime(today.year, today.month, today.day, tzinfo=UTC))
        if limit > 0 and self._counts[project_id] >= limit:
            return False
        self._counts[project_id] += 1
        return True

    def forget(self, project_id: str) -> None:
        """A run that was admitted but not stored (a duplicate) is not counted."""
        if project_id in self._counts and self._counts[project_id] > 0:
            self._counts[project_id] -= 1

    def clear(self) -> None:
        self._day, self._counts = None, {}


class StreamSlots:
    """Open live-stream connections, per IP and in all."""

    def __init__(self):
        self.by_ip: dict[str, int] = {}
        self.total = 0

    def acquire(self, ip: str, per_ip: int, total: int) -> bool:
        if self.total >= total or self.by_ip.get(ip, 0) >= per_ip:
            return False
        self.by_ip[ip] = self.by_ip.get(ip, 0) + 1
        self.total += 1
        return True

    def release(self, ip: str) -> None:
        left = self.by_ip.get(ip, 0) - 1
        if left > 0:
            self.by_ip[ip] = left
        else:
            self.by_ip.pop(ip, None)
        self.total = max(self.total - 1, 0)


# The API process's shared state (tests reset it between tests with `reset()`).
BUCKETS = TokenBuckets()
DAILY_RUNS = DailyRuns()
STREAMS = StreamSlots()


def reset() -> None:
    BUCKETS.clear()
    DAILY_RUNS.clear()
    STREAMS.by_ip.clear()
    STREAMS.total = 0
