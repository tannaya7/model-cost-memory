"""Importance and freshness decay (tech plan 3.4).

importance = 1 + 2·[FAIL] + min(1, cost / job's mean cost)     failures and costly runs matter more
S          = max(1, importance) × 30 × version_factor           how slowly a run is forgotten (days)
R(t)       = e^(−t / S)                                          its weight today, t = age in days
version_factor = 1.0 for a current model version, 0.25 once a newer version exists (fades ~4× faster)
"""

import math
from datetime import datetime, timezone

ARCHIVE_BELOW = 0.05


def importance(outcome: str, cost: float, job_mean_cost: float) -> float:
    rel = min(1.0, cost / job_mean_cost) if job_mean_cost > 0 else 1.0
    return round(1.0 + (2.0 if outcome == "FAIL" else 0.0) + rel, 4)


def version_factor(catalog_entry: dict | None) -> float:
    if catalog_entry and catalog_entry.get("superseded_by"):
        return 0.25
    return 1.0


def stability(imp: float, vf: float) -> float:
    return round(max(1.0, imp) * 30 * vf, 4)


def age_days(created_at: str, now: datetime | None = None) -> float:
    now = now or datetime.now(timezone.utc)
    return max(0.0, (now - datetime.fromisoformat(created_at)).total_seconds() / 86400)


def weight(created_at: str, s: float, now: datetime | None = None) -> float:
    return math.exp(-age_days(created_at, now) / s)
