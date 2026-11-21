"""Cross-site request check for requests that act through the sign-in cookie.

The session cookie is SameSite=Lax, which already stops a cross-site page from making the browser send it
on a POST. This adds a second, server-side check (it also covers sibling subdomains, which Lax does not):
a request that changes something (POST, PUT, PATCH, DELETE) under /v1/ or /auth/ and carries the session
cookie is refused with 403 unless it comes from this site.

The policy, in order:
- Not a changing method, or no session cookie, or a project key is sent (the key decides who the caller
  is, as in auth/access.py): allowed. SDKs and scripts use keys and are never affected.
- An `Origin` header is sent (browsers add it to every cross-origin and every POST): allowed only when its
  host is this server's own host (the `Host` header) or PUBLIC_URL's host. The second covers the local
  development proxy, which forwards the browser's `http://localhost:5174` origin to the API on another port.
  `Origin: null` is refused.
- No `Origin`: allowed only when `Sec-Fetch-Site` is absent (curl, tests, older clients) or `same-origin`.
  `same-site` and `cross-site` are refused.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from urllib.parse import urlsplit

from .config import Settings, get_settings

UNSAFE_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})
CHECKED_PREFIXES = ("/v1/", "/auth/")
SESSION_COOKIE = "mcm_session"
REFUSAL = "This request came from another site, so it was refused. Reload the page and try again."


def _netloc(url: str) -> str:
    try:
        return urlsplit(url).netloc.lower()
    except ValueError:
        return ""


def cross_site(headers: dict[str, str], settings: Settings) -> bool:
    """True when a cookie-authenticated, changing request does not come from this site."""
    origin = headers.get("origin")
    if origin is not None:
        allowed = {_netloc(settings.public_url)}
        if headers.get("host"):
            allowed.add(headers["host"].lower())
        origin_host = _netloc(origin)
        return not origin_host or origin_host not in allowed
    return headers.get("sec-fetch-site", "same-origin").lower() != "same-origin"


class CsrfMiddleware:
    def __init__(self, app, *, settings_factory: Callable[[], Settings] = get_settings):
        self.app = app
        self.settings_factory = settings_factory

    async def __call__(self, scope, receive, send) -> None:
        if (scope["type"] != "http" or scope.get("method") not in UNSAFE_METHODS
                or not scope.get("path", "").startswith(CHECKED_PREFIXES)):
            await self.app(scope, receive, send)
            return
        headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope.get("headers", [])}
        if (SESSION_COOKIE + "=") not in headers.get("cookie", "") or "x-api-key" in headers \
                or headers.get("authorization", "").lower().startswith("bearer "):
            await self.app(scope, receive, send)
            return
        if cross_site(headers, self.settings_factory()):
            body = json.dumps({"detail": REFUSAL}).encode()
            await send({"type": "http.response.start", "status": 403,
                        "headers": [(b"content-type", b"application/json"),
                                    (b"content-length", str(len(body)).encode())]})
            await send({"type": "http.response.body", "body": body})
            return
        await self.app(scope, receive, send)
