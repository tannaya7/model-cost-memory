"""Exact run cost from the usage the provider reported (technical plan 3.13).

    cost = tokens_in          x input price
         + tokens_out         x output price     (thinking tokens are billed as output)
         + cache_read_tokens  x cached-input price
         + cache_write_tokens x cache-write price

`tokens_in` means *uncached* input tokens: the recorder subtracts cached tokens from providers that
count them inside the input total, so nothing is billed twice. Prices are US dollars per million
tokens and come from the model catalog. Cost is never estimated from text length.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal

MILLION = Decimal(1_000_000)
SIX_PLACES = Decimal("0.000001")

# Providers price cache reads far below normal input and cache writes a little above it. The
# catalog stores input and output prices only, so these factors derive the other two.
DEFAULT_CACHE_READ_FACTOR = Decimal("0.1")
DEFAULT_CACHE_WRITE_FACTOR = Decimal("1.25")


WRITE_1H_FACTOR = Decimal("2")  # Anthropic 1-hour cache writes

# Anthropic's pricing page (https://platform.claude.com/docs/en/about-claude/pricing, opened 2026-11-16):
#   "Cache hit multiplier: Claude Fable 5.2 and Claude Mythos 5.2 0.025x; Claude Fable 5.1 and Claude
#   Mythos 5.1 0.025x; Claude Opus 5.5 0.05x; Claude Sonnet 5.5 0.05x; All other models 0.1x."
#   "5-minute cache write 1.25x base input price; 1-hour cache write 2x base input price."
# OpenAI's pricing page (https://developers.openai.com/api/docs/pricing, opened 2026-11-16, Standard tier),
# cached input / input: gpt-4o 1.25/2.50 = 0.5, gpt-4o-mini 0.075/0.15 = 0.5, gpt-4.1 0.50/2.00 = 0.25,
# gpt-4.1-mini 0.10/0.40 = 0.25, o3 0.50/2.00 = 0.25, gpt-5 family 0.1.
# Gemini 4 is 0.05 and DeepSeek has its own ratios (below); other Gemini families are 0.1 (verified on the Gemini
# pricing page 2026-11-17, except Gemini 2.0 which is no longer listed: UNVERIFIED). Other providers keep 0.1.
# Known gap: Gemini explicit-cache storage is billed per hour held, which usage does not report, so it is not costed.
# Keys are matched on a name boundary of the lowercased model name with "." read as "-": the key may not
# be glued to other letters/digits ("fable-5-10" is not "fable-5-1"), and may only be followed by the end,
# a "-" plus a digit (a date) or "-latest". Longer keys are listed first so "gpt-4o-mini" beats "gpt-4o".
_CACHE_READ_FACTORS: tuple[tuple[str, Decimal], ...] = (
    ("fable-5-1", Decimal("0.025")),
    ("fable-5-2", Decimal("0.025")),
    ("mythos-5-1", Decimal("0.025")),
    ("mythos-5-2", Decimal("0.025")),
    ("opus-5-5", Decimal("0.05")),
    ("sonnet-5-5", Decimal("0.05")),
    ("gpt-4o-mini", Decimal("0.5")),
    ("gpt-4o", Decimal("0.5")),
    ("gpt-4-1-mini", Decimal("0.25")),
    ("gpt-4-1", Decimal("0.25")),
    ("o3", Decimal("0.25")),
    # Gemini 4 (https://aistudio.google.com/docs/pricing.md): Carbon and Argon cached $0.10 vs input $2.00,
    # Hydrogen $0.075 vs $1.50: 0.05x. Every other Gemini family on that page (2.5, 3 Flash Preview, 3.1,
    # 3.5, 3.6, 3.8) is 0.1x, the default below. The page's SCHEDULED PRICE CHANGES (Gemini 4 Carbon/Argon
    # input $2 to $4 and output $10 to $20 from 2026-12-01; 3.6/3.8 Flash $0.75 to $1.50 from 2027-01-01) are
    # prices, not factors: they come from the synced catalog, so they are deliberately not hard-coded here.
    # The factor stays 0.05 across the Carbon/Argon change (cached $0.10 to $0.20 beside input $2 to $4).
    ("gemini-4-carbon", Decimal("0.05")),
    ("gemini-4-argon", Decimal("0.05")),
    ("gemini-4-hydrogen", Decimal("0.05")),
    # DeepSeek (https://api-docs.deepseek.com/quick_start/pricing, off-peak): cache hit / miss input is
    # flash 0.003/0.15 = 0.02 and v4-pro 0.022/0.66. Peak hours cost 2x on every category (the ratio is
    # unchanged), but the peak window was not read, so peak pricing is NOT modelled.
    ("deepseek-flash", Decimal("0.003") / Decimal("0.15")),
    ("deepseek-v4-pro", Decimal("0.022") / Decimal("0.66")),
)
_CACHE_READ_PATTERNS = tuple(
    (re.compile(r"(?<![a-z0-9])" + re.escape(key) + r"(?:$|-latest(?![a-z0-9])|-[0-9])"), factor)
    for key, factor in _CACHE_READ_FACTORS
)


def cache_factors(model: str | None) -> tuple[Decimal, Decimal]:
    """(cache read factor, cache write factor) for a model; unknown models get the defaults.

    The write factor here is the 5-minute rate; `write_factor_for_split` blends in the 1-hour rate
    when the response reports the split.
    """
    name = (model or "").lower().replace(".", "-")
    for pattern, factor in _CACHE_READ_PATTERNS:
        if pattern.search(name):
            return factor, DEFAULT_CACHE_WRITE_FACTOR
    return DEFAULT_CACHE_READ_FACTOR, DEFAULT_CACHE_WRITE_FACTOR


def write_factor_for_split(write_5m_tokens: int, write_1h_tokens: int) -> Decimal:
    """Blended write factor for a recorded 5-minute/1-hour split of cache-creation tokens."""
    total = write_5m_tokens + write_1h_tokens
    if total <= 0:
        return DEFAULT_CACHE_WRITE_FACTOR
    return (DEFAULT_CACHE_WRITE_FACTOR * write_5m_tokens + WRITE_1H_FACTOR * write_1h_tokens) / total


@dataclass(frozen=True)
class Price:
    input_per_mtok: Decimal
    output_per_mtok: Decimal
    cache_read_per_mtok: Decimal
    cache_write_per_mtok: Decimal

    @classmethod
    def from_input_output(
        cls,
        input_per_mtok: Decimal | float | str,
        output_per_mtok: Decimal | float | str,
        cache_read_factor: Decimal = DEFAULT_CACHE_READ_FACTOR,
        cache_write_factor: Decimal = DEFAULT_CACHE_WRITE_FACTOR,
        model: str | None = None,
    ) -> Price:
        """Pass `model` to use that model's cache factors (explicit factors still win when not default)."""
        if model is not None:
            read_f, write_f = cache_factors(model)
            if cache_read_factor == DEFAULT_CACHE_READ_FACTOR:
                cache_read_factor = read_f
            if cache_write_factor == DEFAULT_CACHE_WRITE_FACTOR:
                cache_write_factor = write_f
        price_in = Decimal(str(input_per_mtok))
        return cls(
            input_per_mtok=price_in,
            output_per_mtok=Decimal(str(output_per_mtok)),
            cache_read_per_mtok=price_in * cache_read_factor,
            cache_write_per_mtok=price_in * cache_write_factor,
        )


FREE = Price(Decimal(0), Decimal(0), Decimal(0), Decimal(0))  # local models cost nothing


def compute_cost(
    price: Price, tokens_in: int, tokens_out: int, cache_read_tokens: int = 0, cache_write_tokens: int = 0,
    cache_write_1h_tokens: int = 0,
) -> Decimal:
    """Cost in US dollars, rounded to six places (the precision stored on the run).

    `cache_write_1h_tokens` is the part of `cache_write_tokens` written to the 1-hour cache, priced at
    2x the input price instead of the 5-minute 1.25x ("1-hour cache write 2x base input price",
    Anthropic pricing page). It is clamped to the total writes.
    """
    one_hour = max(0, min(cache_write_1h_tokens, cache_write_tokens))
    write_total = Decimal(cache_write_tokens - one_hour) * price.cache_write_per_mtok
    if one_hour:
        write_total += Decimal(one_hour) * price.input_per_mtok * WRITE_1H_FACTOR
    total = (
        Decimal(tokens_in) * price.input_per_mtok
        + Decimal(tokens_out) * price.output_per_mtok
        + Decimal(cache_read_tokens) * price.cache_read_per_mtok
        + write_total
    ) / MILLION
    return total.quantize(SIX_PLACES, rounding=ROUND_HALF_UP)
