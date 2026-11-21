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


def test_cache_read_factor_follows_the_model_family():
    from agent_memory.costing import cache_factors

    assert cache_factors("claude-opus-5-5-20260901")[0] == Decimal("0.05")
    assert cache_factors("Claude-Sonnet-5.5")[0] == Decimal("0.05")
    assert cache_factors("claude-fable-5-2")[0] == Decimal("0.025")
    assert cache_factors("something-unknown") == (Decimal("0.1"), Decimal("1.25"))
    assert cache_factors(None) == (Decimal("0.1"), Decimal("1.25"))


def test_price_uses_model_cache_factor_and_keeps_default_for_unknown():
    fable = Price.from_input_output(10, 50, model="claude-fable-5-1")
    other = Price.from_input_output(10, 50, model="gpt-x")
    assert compute_cost(fable, 0, 0, cache_read_tokens=1_000_000) == Decimal("0.250000")
    assert compute_cost(other, 0, 0, cache_read_tokens=1_000_000) == Decimal("1.000000")
    assert compute_cost(fable, 0, 0, cache_write_tokens=1_000_000) == Decimal("12.500000")  # priced at the 5-minute rate


def test_write_factor_blends_the_five_minute_and_one_hour_split():
    from agent_memory.costing import write_factor_for_split

    assert write_factor_for_split(100, 0) == Decimal("1.25")
    assert write_factor_for_split(0, 100) == Decimal("2")
    assert write_factor_for_split(50, 50) == Decimal("1.625")
    assert write_factor_for_split(0, 0) == Decimal("1.25")


def test_f2_f3_f4_cache_read_factors_per_family():
    """Audit F2/F3/F4. OpenAI pricing page (opened 2026-11-16): cached input / input is 0.5 for gpt-4o and
    gpt-4o-mini, 0.25 for gpt-4.1(-mini) and o3. Anthropic pricing page: Mythos 5.1 is 0.025x like Fable 5.1."""
    from agent_memory.costing import cache_factors

    d = Decimal
    assert cache_factors("gpt-4o")[0] == d("0.5")
    assert cache_factors("gpt-4o-2024-08-06")[0] == d("0.5")
    assert cache_factors("gpt-4o-mini")[0] == d("0.5")
    assert cache_factors("gpt-4.1")[0] == d("0.25")
    assert cache_factors("gpt-4.1-mini-2025-04-14")[0] == d("0.25")
    assert cache_factors("o3")[0] == d("0.25")
    assert cache_factors("claude-mythos-5-1")[0] == d("0.025")
    # F4: a longer version number is not the shorter one
    assert cache_factors("claude-fable-5-10")[0] == d("0.1")
    assert cache_factors("claude-sonnet-5-50")[0] == d("0.1")
    assert cache_factors("claude-sonnet-5-5-20261001")[0] == d("0.05")
    assert cache_factors("gpt-5")[0] == d("0.1")
    assert cache_factors("o3-mini")[0] == d("0.1")  # not priced here: default, never o3's factor


def test_f5_one_hour_cache_writes_cost_twice_the_input_price():
    """Audit F5. Anthropic pricing page: '5-minute cache write 1.25x, 1-hour cache write 2x base input price'."""
    price = Price.from_input_output(10, 50)
    assert compute_cost(price, 0, 0, cache_write_tokens=1_000_000) == Decimal("12.500000")
    assert compute_cost(price, 0, 0, cache_write_tokens=1_000_000, cache_write_1h_tokens=1_000_000) == Decimal("20.000000")
    assert compute_cost(price, 0, 0, cache_write_tokens=1_000_000, cache_write_1h_tokens=500_000) == Decimal("16.250000")
    # the split can never exceed the total writes
    assert compute_cost(price, 0, 0, cache_write_tokens=100, cache_write_1h_tokens=10**9) == compute_cost(
        price, 0, 0, cache_write_tokens=100, cache_write_1h_tokens=100)


def test_gemini_4_cache_read_is_005_and_older_gemini_families_stay_01():
    # Gemini pricing page: Carbon/Argon $0.10 cached vs $2.00 input, Hydrogen $0.075 vs $1.50 = 0.05x.
    # The scheduled price changes (Carbon/Argon doubling 2026-12-01, 3.6/3.8 Flash 2027-01-01) are catalog
    # prices, not factors, so nothing here depends on the date.
    from agent_memory.costing import cache_factors

    for name in ("gemini-4-carbon", "gemini/gemini-4-argon", "gemini-4-hydrogen"):
        assert cache_factors(name)[0] == Decimal("0.05")
    for name in ("gemini-2.5-pro", "gemini-3-flash-preview", "gemini-3.1-pro-preview", "gemini-3.5-flash-lite",
                 "gemini-3.6-flash", "gemini-3.8-flash"):
        assert cache_factors(name)[0] == Decimal("0.1")
    assert cache_factors("gemini-4-carbon")[1] == Decimal("1.25")


def test_deepseek_cache_hit_factors_come_from_the_official_off_peak_prices():
    from agent_memory.costing import cache_factors

    assert cache_factors("deepseek-flash")[0] == Decimal("0.02")
    assert cache_factors("deepseek/deepseek-v4-pro")[0] == Decimal("0.022") / Decimal("0.66")
    price = Price.from_input_output("0.66", "1.98", model="deepseek-v4-pro")
    assert price.cache_read_per_mtok.quantize(Decimal("0.001")) == Decimal("0.022")
