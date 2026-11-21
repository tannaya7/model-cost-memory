"""Project API keys: generation, hashing and reading them from a request.

A key is shown once, when the project is created, and only its SHA-256 hash is stored. Keys are
long random strings, so a plain fast hash is enough (there is nothing to brute-force).
"""

from __future__ import annotations

import base64
import hashlib
import hmac
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


def derive(secret_key: str, purpose: str) -> bytes:
    """A 32-byte key for one purpose, from SECRET_KEY (HMAC-SHA256 keyed by the secret, with the purpose
    as the message). The cookie signer and the provider-key cipher get different keys, so neither
    use can reveal or forge the other's."""
    return hmac.new(secret_key.encode(), purpose.encode(), hashlib.sha256).digest()


# Used only when the server has no SECRET_KEY (a laptop): hashes then stay stable between restarts but are guessable, because this
# string is public. A real server has a SECRET_KEY, and the product refuses to start in production without one.
NO_SECRET_PROMPT_KEY = "development only: SECRET_KEY is not set"


def prompt_hash_key(project_id: str, secret_key: str) -> bytes:
    """The key that makes one project's prompt hashes its own: another project, or anyone without the server's secret, cannot
    recompute or compare them."""
    return derive(secret_key or NO_SECRET_PROMPT_KEY, f"prompt-hash/v2/{project_id}")


def keyed_prompt_hash(project_id: str, plain_sha256_hex: str, secret_key: str) -> str:
    """HMAC-SHA256 of a prompt's plain SHA-256, under this project's key. It is built from the plain hash on purpose: a row stored
    before keying (which kept only the plain hash, its text possibly long deleted) converts to exactly the value a new call with
    the same prompt gets, so every match survives the change."""
    return hmac.new(prompt_hash_key(project_id, secret_key), plain_sha256_hex.encode(), hashlib.sha256).hexdigest()


def session_secret(secret_key: str) -> str:
    """The key that signs sign-in cookies."""
    return base64.urlsafe_b64encode(derive(secret_key, "mcm session cookie v1")).decode()


def _fernet(secret_key: str):
    """Encrypts with the provider-key key. Also reads keys stored before the keys were separated
    (encrypted with SHA-256 of SECRET_KEY itself); they are re-encrypted the next time they are saved."""
    from cryptography.fernet import Fernet, MultiFernet

    if not secret_key:
        raise SecretKeyMissing("set SECRET_KEY on the server to store provider keys")
    current = Fernet(base64.urlsafe_b64encode(derive(secret_key, "mcm provider keys v1")))
    legacy = Fernet(base64.urlsafe_b64encode(hashlib.sha256(secret_key.encode()).digest()))
    return MultiFernet([current, legacy])


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
