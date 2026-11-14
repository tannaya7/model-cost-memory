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

from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal

MILLION = Decimal(1_000_000)
SIX_PLACES = Decimal("0.000001")

# Providers price cache reads far below normal input and cache writes a little above it. The
# catalog stores input and output prices only, so these factors derive the other two.
DEFAULT_CACHE_READ_FACTOR = Decimal("0.1")
DEFAULT_CACHE_WRITE_FACTOR = Decimal("1.25")


WRITE_1H_FACTOR = Decimal("2")  # Anthropic 1-hour cache writes

# Anthropic's pricing page (retrieved 2026-11-14): cache read is 0.1x base input on most models,
# 0.05x on Opus 5.5 and Sonnet 5.5, 0.025x on Fable 5.1/5.2 and Mythos 5.2. Writes are 1.25x (5 minutes)
# or 2x (1 hour). Keys are matched as substrings of the lowercased model name with "." read as "-".
_CACHE_READ_FACTORS: tuple[tuple[str, Decimal], ...] = (
    ("fable-5-1", Decimal("0.025")),
    ("fable-5-2", Decimal("0.025")),
    ("mythos-5-2", Decimal("0.025")),
    ("opus-5-5", Decimal("0.05")),
    ("sonnet-5-5", Decimal("0.05")),
)


def cache_factors(model: str | None) -> tuple[Decimal, Decimal]:
    """(cache read factor, cache write factor) for a model; unknown models get the defaults.

    The run stores one cache-write count with no 5-minute/1-hour split, so writes are priced at the
    5-minute rate (an underestimate for 1-hour writes; use `write_factor_for_split` when the split is known).
    """
    name = (model or "").lower().replace(".", "-")
    for key, factor in _CACHE_READ_FACTORS:
        if key in name:
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
    price: Price, tokens_in: int, tokens_out: int, cache_read_tokens: int = 0, cache_write_tokens: int = 0
) -> Decimal:
    """Cost in US dollars, rounded to six places (the precision stored on the run)."""
    total = (
        Decimal(tokens_in) * price.input_per_mtok
        + Decimal(tokens_out) * price.output_per_mtok
        + Decimal(cache_read_tokens) * price.cache_read_per_mtok
        + Decimal(cache_write_tokens) * price.cache_write_per_mtok
    ) / MILLION
    return total.quantize(SIX_PLACES, rounding=ROUND_HALF_UP)
