"""The simulated world: models whose true quality we know, changing over simulated days.

Each model family has a cost per run and a list of versions; each version takes over from the one
before on its release day, as a provider's alias would. A version's true pass rate depends on the
workload mix: short and long documents pass at different rates, and the share of long documents
drifts over the timeline (workload drift). A drop can be injected into a version from a given day,
under an unchanged name (a silent change). A family can be retired on a day: it stops serving and the
catalog marks it RETIRED.

Because the true rates are known, the right answer at any moment is known too (`truth`), which is
what the regression evaluation and the staleness experiment score against.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class Version:
    name: str  # the provider-resolved version string, e.g. "acme-mini-2026-03-01"
    released: int  # first simulated day it serves traffic
    rate_short: float  # true pass rate on short documents
    rate_long: float  # true pass rate on long documents
    drop_day: int | None = None  # a silent change: from this day the rate falls by drop_size
    drop_size: float = 0.0


@dataclass(frozen=True)
class SimModel:
    family: str
    cost: float  # US dollars per run
    versions: tuple[Version, ...]
    retired_day: int | None = None

    def version_on(self, day: int) -> Version | None:
        if self.retired_day is not None and day >= self.retired_day:
            return None
        live = [v for v in self.versions if v.released <= day]
        return max(live, key=lambda v: v.released) if live else None


@dataclass(frozen=True)
class Scenario:
    job: str
    models: tuple[SimModel, ...]
    production: str  # the family the application uses at the start
    days: int
    runs_per_day: int  # production runs
    retest_per_day: int  # evidence gathered on every other live model (the re-test runner's job)
    long_share_start: float = 0.2  # share of long documents on day 0 ...
    long_share_end: float = 0.2  # ... and on the last day, linearly in between
    seed: int = 0
    extra: dict = field(default_factory=dict)

    def model(self, family: str) -> SimModel:
        return next(m for m in self.models if m.family == family)

    def long_share(self, day: int) -> float:
        if self.days <= 1:
            return self.long_share_start
        t = min(max(day / (self.days - 1), 0.0), 1.0)
        return self.long_share_start + t * (self.long_share_end - self.long_share_start)


def true_rate(version: Version, day: int, long_share: float) -> float:
    rate = (1 - long_share) * version.rate_short + long_share * version.rate_long
    if version.drop_day is not None and day >= version.drop_day:
        rate -= version.drop_size
    return min(max(rate, 0.0), 1.0)


def truth(scenario: Scenario, day: int, margin: float) -> str | None:
    """The right recommendation on `day`: of the live models within `margin` of the best true pass
    rate, the cheapest per success."""
    share = scenario.long_share(day)
    live = [(m, true_rate(v, day, share)) for m in scenario.models if (v := m.version_on(day)) is not None]
    if not live:
        return None
    best = max(rate for _, rate in live)
    eligible = [(m, rate) for m, rate in live if rate >= best - margin and rate > 0]
    return min(eligible, key=lambda mr: mr[0].cost / mr[1])[0].family
