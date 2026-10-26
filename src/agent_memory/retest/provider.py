"""Calling the candidate model: the only place this system sends a prompt to a provider.

Any OpenAI-compatible endpoint works (OpenAI, Gemini's and Groq's OpenAI-compatible endpoints, Ollama),
so one client covers paid and free tiers. A 429 ("too many requests") is answered by waiting
(Retry-After when the provider sends it, otherwise 2, 4, 8 ... seconds) and trying again a few times:
a free key's quota is shared with the customer's production traffic, so re-tests back off rather
than compete. Any other provider error ends the re-test with its partial results.
"""

from __future__ import annotations

import asyncio
from typing import Any, Protocol

RATE_LIMIT_RETRIES = 5
MAX_WAIT_SECONDS = 60.0


class RateLimited(RuntimeError):
    """The provider kept answering 429 after every retry."""


class ProviderError(RuntimeError):
    """The provider failed in a way retrying will not fix."""


class ProviderClient(Protocol):
    async def complete(self, model: str, prompt: str) -> Any:
        """Send one prompt; return the provider's response (OpenAI-shaped)."""


class OpenAICompatible:
    def __init__(self, base_url: str, api_key: str, *, sleep=asyncio.sleep):
        from openai import AsyncOpenAI

        self._client = AsyncOpenAI(base_url=base_url, api_key=api_key, max_retries=0, timeout=60)
        self._sleep = sleep

    async def complete(self, model: str, prompt: str) -> Any:
        import openai

        for attempt in range(RATE_LIMIT_RETRIES + 1):
            try:
                return await self._client.chat.completions.create(
                    model=model, messages=[{"role": "user", "content": prompt}]
                )
            except openai.RateLimitError as exc:
                if attempt == RATE_LIMIT_RETRIES:
                    raise RateLimited(str(exc)) from exc
                retry_after = exc.response.headers.get("retry-after") if exc.response is not None else None
                try:
                    wait = float(retry_after) if retry_after else 2.0 ** (attempt + 1)
                except ValueError:
                    wait = 2.0 ** (attempt + 1)
                await self._sleep(min(wait, MAX_WAIT_SECONDS))
            except openai.APIError as exc:
                raise ProviderError(str(exc)) from exc
        raise RateLimited("rate limited")  # unreachable; keeps type checkers content
