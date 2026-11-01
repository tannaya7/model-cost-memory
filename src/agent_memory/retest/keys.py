"""The customer's provider key for re-tests.

Asked for only when a re-test is first needed (decided 26 Oct), never at project creation. Giving
the key together with the project's monthly cap is standing permission: re-tests then run on their
own within the cap. The key is encrypted with the server's SECRET_KEY, only its last four characters
are ever shown again, and only the re-test runner decrypts it.

`provider` names the catalog provider the endpoint serves (e.g. "openai", "gemini", "groq"), so a new
model from that provider can be re-tested automatically; `base_url` is its OpenAI-compatible address.
"""

from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy.ext.asyncio import AsyncSession

from ..config import Settings
from ..models import ProviderKey
from ..security import decrypt, encrypt
from .provider import OpenAICompatible, ProviderClient

KNOWN_ENDPOINTS = {  # convenience defaults; any OpenAI-compatible base_url works
    "openai": "https://api.openai.com/v1",
    "gemini": "https://generativelanguage.googleapis.com/v1beta/openai/",
    "groq": "https://api.groq.com/openai/v1",
}


async def set_key(
    session: AsyncSession, project_id: str, *, provider: str, api_key: str, base_url: str | None,
    settings: Settings,
) -> ProviderKey:
    url = base_url or KNOWN_ENDPOINTS.get(provider.lower())
    if not url:
        raise ValueError(f"Give the base_url for provider '{provider}' (an OpenAI-compatible endpoint)")
    row = await session.get(ProviderKey, project_id)
    if row is None:
        row = ProviderKey(project_id=project_id)
        session.add(row)
    row.provider, row.base_url = provider.lower(), url
    row.key_encrypted, row.key_hint = encrypt(api_key, settings.secret_key), api_key[-4:]
    row.created_at = datetime.now(UTC)
    await session.flush()
    return row


def client_for(key: ProviderKey, settings: Settings) -> ProviderClient:
    return OpenAICompatible(key.base_url, decrypt(key.key_encrypted, settings.secret_key))
