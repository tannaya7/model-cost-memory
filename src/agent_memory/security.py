"""Project API keys: generation, hashing and reading them from a request.

A key is shown once, when the project is created, and only its SHA-256 hash is stored. Keys are
long random strings, so a plain fast hash is enough (there is nothing to brute-force).
"""

from __future__ import annotations

import hashlib
import secrets

KEY_PREFIX = "mcm_live_"


def generate_key() -> str:
    """A new project key, for example `mcm_live_pT3k...`."""
    return KEY_PREFIX + secrets.token_urlsafe(24)


def hash_key(key: str) -> str:
    return hashlib.sha256(key.encode("utf8")).hexdigest()


def extract_key(x_api_key: str | None, authorization: str | None) -> str | None:
    """Read the key from `X-API-Key`, or from `Authorization: Bearer <key>`."""
    if x_api_key and x_api_key.strip():
        return x_api_key.strip()
    if authorization:
        scheme, _, value = authorization.partition(" ")
        if scheme.lower() == "bearer" and value.strip():
            return value.strip()
    return None
