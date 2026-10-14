"""Cost is arithmetic on reported usage (no database needed)."""

from decimal import Decimal

from hypothesis import given
from hypothesis import strategies as st

from agent_memory.costing import FREE, Price, compute_cost


def test_input_and_output_are_priced_separately():
    price = Price.from_input_output(3, 15)  # dollars per million tokens
    assert compute_cost(price, 2000, 500) == Decimal("0.013500")


def test_thinking_tokens_are_part_of_output_and_cost_output_price():
    price = Price.from_input_output(3, 15)
    assert compute_cost(price, 0, 1_000_000) == Decimal("15.000000")


def test_cache_reads_are_cheaper_and_writes_dearer_than_normal_input():
    price = Price.from_input_output(10, 50)
    normal = compute_cost(price, 1_000_000, 0)
    cached = compute_cost(price, 0, 0, cache_read_tokens=1_000_000)
    written = compute_cost(price, 0, 0, cache_write_tokens=1_000_000)
    assert cached < normal < written
    assert (cached, normal, written) == (Decimal("1.000000"), Decimal("10.000000"), Decimal("12.500000"))


def test_local_models_cost_nothing():
    assert compute_cost(FREE, 5000, 5000, 100, 100) == Decimal("0.000000")


def test_rounds_to_six_places():
    price = Price.from_input_output("0.25", "1.25")
    assert compute_cost(price, 1, 0) == Decimal("0.000000")  # a quarter of a millionth of a dollar
    assert compute_cost(price, 3, 0) == Decimal("0.000001")


@given(
    st.integers(0, 10_000_000), st.integers(0, 10_000_000),
    st.integers(0, 10_000_000), st.integers(0, 10_000_000),
)
def test_more_usage_never_costs_less(a, b, c, d):
    price = Price.from_input_output(3, 15)
    base = compute_cost(price, a, b, c, d)
    assert compute_cost(price, a + 1, b, c, d) >= base
    assert compute_cost(price, a, b + 1, c, d) >= base
    assert base >= 0
