"""detect_token_burst: the latest window against the trailing average."""

from datetime import UTC, datetime, timedelta

from agent_memory.alerts.burst import detect_token_burst

NOW = datetime(2026, 11, 13, 12, 0, tzinfo=UTC)


def hourly(tokens, hours=range(1, 25)):
    return [(NOW - timedelta(hours=h, minutes=30), tokens) for h in hours]


def test_a_spike_over_a_steady_baseline_is_a_burst():
    result = detect_token_burst(hourly(1000) + [(NOW - timedelta(minutes=5), 10_000)], NOW)
    assert result.is_burst and result.latest_tokens == 10_000
    assert result.baseline_tokens == 1000 and result.ratio == 10


def test_normal_traffic_is_not_a_burst():
    assert not detect_token_burst(hourly(1000) + [(NOW - timedelta(minutes=5), 1500)], NOW).is_burst


def test_exactly_at_the_factor_is_not_a_burst():
    assert not detect_token_burst(hourly(1000) + [(NOW - timedelta(minutes=5), 3000)], NOW).is_burst


def test_too_little_history_never_flags():
    points = hourly(1000, range(1, 3)) + [(NOW - timedelta(minutes=5), 100_000)]
    result = detect_token_burst(points, NOW)
    assert not result.is_burst and result.ratio is None


def test_no_history_never_flags():
    assert not detect_token_burst([(NOW - timedelta(minutes=5), 100_000)], NOW).is_burst


def test_points_in_the_future_or_too_old_are_ignored():
    points = hourly(1000) + [(NOW + timedelta(minutes=5), 99_999), (NOW - timedelta(days=9), 99_999)]
    result = detect_token_burst(points, NOW)
    assert result.latest_tokens == 0 and result.baseline_tokens == 1000 and not result.is_burst


def test_the_factor_is_adjustable():
    points = hourly(1000) + [(NOW - timedelta(minutes=5), 1600)]
    assert detect_token_burst(points, NOW, factor=1.5).is_burst
