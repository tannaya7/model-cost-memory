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


def generate_webhook_secret() -> str:
    """The shared secret a project's webhook payloads are signed with (HMAC-SHA256)."""
    return "whsec_" + secrets.token_urlsafe(24)


class SecretKeyMissing(RuntimeError):
    """The server has no SECRET_KEY, so it cannot store or read customer provider keys."""


def _fernet(secret_key: str):
    import base64

    from cryptography.fernet import Fernet

    if not secret_key:
        raise SecretKeyMissing("set SECRET_KEY on the server to store provider keys")
    return Fernet(base64.urlsafe_b64encode(hashlib.sha256(secret_key.encode()).digest()))


def encrypt(text: str, secret_key: str) -> str:
    """Encrypt a customer's provider key at rest (Fernet: AES-128-CBC with an HMAC)."""
    return _fernet(secret_key).encrypt(text.encode()).decode()


def decrypt(token: str, secret_key: str) -> str:
    return _fernet(secret_key).decrypt(token.encode()).decode()


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
