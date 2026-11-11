"""Calling the candidate model: the only place this system sends a prompt to a provider.

Any OpenAI-compatible endpoint works (OpenAI, Gemini's and Groq's OpenAI-compatible endpoints, Ollama),
so one client covers paid and free tiers. A re-test shares the customer's quota with their production
traffic, so the client is built to take as little of it as it can:

- **Paced.** Calls start at least `min_interval` seconds apart, across all of a re-test's concurrent
  calls, so a burst never empties a per-minute quota before the first 429 arrives.
- **Capped output.** Every call sets an output limit (`max_tokens`), so one runaway answer cannot cost
  more than the runner reserved for it. Reasoning models that only accept `max_completion_tokens` are
  detected from the provider's error and retried once with that name.
- **Backs off on 429.** It waits for the provider's Retry-After (seconds, milliseconds, or an HTTP date)
  when sent, otherwise 2, 4, 8 ... seconds, up to MAX_WAIT_SECONDS, plus up to 25% random jitter so
  concurrent calls do not retry in step. After RATE_LIMIT_RETRIES it gives up with `RateLimited`.

Any other provider error ends the re-test with its partial results (`ProviderError`).
"""

from __future__ import annotations

import asyncio
import random
import time
from email.utils import parsedate_to_datetime
from typing import Any, Protocol

RATE_LIMIT_RETRIES = 5
MAX_WAIT_SECONDS = 300.0  # free tiers often reset per minute or longer; 60 s gave up too soon
JITTER = 0.25
MIN_INTERVAL_SECONDS = 1.0


class RateLimited(RuntimeError):
    """The provider kept answering 429 after every retry."""


class ProviderError(RuntimeError):
    """The provider failed in a way retrying will not fix."""


class ProviderClient(Protocol):
    async def complete(self, model: str, prompt: str, *, effort: str | None = None,
                       max_tokens: int | None = None) -> Any:
        """Send one prompt, at the given reasoning effort if any, with at most `max_tokens` of output;
        return the provider's response (OpenAI-shaped)."""


def retry_after_seconds(headers: Any, now: float | None = None) -> float | None:
    """How long the provider asked us to wait, from `retry-after-ms` or `retry-after` (seconds or an
    HTTP date). None when it did not say, or said something unreadable."""
    if headers is None:
        return None
    millis = headers.get("retry-after-ms")
    if millis:
        try:
            return max(float(millis) / 1000, 0.0)
        except ValueError:
            pass
    value = headers.get("retry-after")
    if not value:
        return None
    try:
        return max(float(value), 0.0)
    except ValueError:
        pass
    try:
        when = parsedate_to_datetime(value)
    except (TypeError, ValueError):
        return None
    if when is None:
        return None
    return max(when.timestamp() - (now if now is not None else time.time()), 0.0)


def backoff_seconds(attempt: int, asked: float | None, rng: random.Random) -> float:
    """The wait before retry `attempt` (0-based): the provider's Retry-After when given, otherwise
    2^(attempt+1) seconds; capped at MAX_WAIT_SECONDS, then up to JITTER more at random."""
    base = asked if asked is not None else 2.0 ** (attempt + 1)
    base = min(base, MAX_WAIT_SECONDS)
    return base * (1 + rng.uniform(0, JITTER))


class OpenAICompatible:
    def __init__(self, base_url: str, api_key: str, *, sleep=asyncio.sleep, clock=time.monotonic,
                 min_interval: float = MIN_INTERVAL_SECONDS, rng: random.Random | None = None):
        from openai import AsyncOpenAI

        self._client = AsyncOpenAI(base_url=base_url, api_key=api_key, max_retries=0, timeout=120)
        self._sleep = sleep
        self._clock = clock
        self._min_interval = min_interval
        self._rng = rng or random.Random()
        self._pace = asyncio.Lock()
        self._next_start = 0.0
        self._limit_param = "max_tokens"  # becomes "max_completion_tokens" if the provider asks for it

    async def _wait_turn(self) -> None:
        """Hold each call until `min_interval` after the previous one started."""
        async with self._pace:
            now = self._clock()
            if now < self._next_start:
                await self._sleep(self._next_start - now)
                now = self._clock()
            self._next_start = max(now, self._next_start) + self._min_interval

    async def _create(self, model: str, prompt: str, extra: dict) -> Any:
        import openai

        try:
            return await self._client.chat.completions.create(
                model=model, messages=[{"role": "user", "content": prompt}], **extra)
        except openai.BadRequestError as exc:
            # Reasoning models reject max_tokens and name the parameter they want instead.
            if self._limit_param == "max_tokens" and "max_tokens" in extra and "max_completion_tokens" in str(exc):
                self._limit_param = "max_completion_tokens"
                extra = {("max_completion_tokens" if k == "max_tokens" else k): v for k, v in extra.items()}
                return await self._client.chat.completions.create(
                    model=model, messages=[{"role": "user", "content": prompt}], **extra)
            raise

    async def complete(self, model: str, prompt: str, *, effort: str | None = None,
                       max_tokens: int | None = None) -> Any:
        import openai

        for attempt in range(RATE_LIMIT_RETRIES + 1):
            extra: dict[str, Any] = {"reasoning_effort": effort} if effort else {}
            if max_tokens is not None:
                extra[self._limit_param] = max_tokens  # the name learned so far
            await self._wait_turn()
            try:
                return await self._create(model, prompt, extra)
            except openai.RateLimitError as exc:
                if attempt == RATE_LIMIT_RETRIES:
                    raise RateLimited(str(exc)) from exc
                asked = retry_after_seconds(exc.response.headers if exc.response is not None else None)
                await self._sleep(backoff_seconds(attempt, asked, self._rng))
            except openai.APIError as exc:
                raise ProviderError(str(exc)) from exc
        raise RateLimited("rate limited")  # unreachable; keeps type checkers content
