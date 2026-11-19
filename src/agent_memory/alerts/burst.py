"""Token burst detection: is token use in the latest window far above the trailing average?

Pure: it takes points and a clock and returns a verdict. watch.check_token_bursts runs it every hour and states the
window, the baseline, the factor and the volume floor in the alert.

This is a usage heads-up from hour-long totals of recorded calls. It is not a prediction of provider throttling: it
reads no provider signal and cannot see a short, second-by-second rate limit.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta

MIN_BASELINE_WINDOWS = 3  # fewer windows with history than this is too little to judge


@dataclass(frozen=True)
class Burst:
    is_burst: bool
    latest_tokens: int
    baseline_tokens: float  # average tokens per window before the latest one
    ratio: float | None  # latest / baseline; None when there is no usable baseline


def detect_token_burst(
    points: list[tuple[datetime, int]], now: datetime, window_minutes: int = 60, factor: float = 3.0,
    baseline_windows: int = 24,
) -> Burst:
    """`points` are (time, tokens) per call. The latest window is (now - window, now]; the baseline is
    the average per window over the `baseline_windows` windows before it (empty windows count as
    zero, so a quiet app that suddenly spikes is a burst). A burst needs at least MIN_BASELINE_WINDOWS
    earlier windows that had traffic, a positive baseline, and latest > factor * baseline."""
    window = timedelta(minutes=window_minutes)
    start = now - window
    base_start = start - baseline_windows * window
    latest = sum(t for ts, t in points if start < ts <= now)
    earlier = [(ts, t) for ts, t in points if base_start < ts <= start]
    baseline = sum(t for _, t in earlier) / baseline_windows
    busy_windows = {int((start - ts) / window) for ts, _ in earlier}
    if len(busy_windows) < MIN_BASELINE_WINDOWS or baseline <= 0:
        return Burst(False, latest, baseline, None)
    return Burst(latest > factor * baseline, latest, baseline, latest / baseline)
