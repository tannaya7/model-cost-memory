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
    ) -> Price:
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
