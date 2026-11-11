"""Late-label check: the outcome is not known when the run arrives.

The run is stored UNKNOWN. The engineer supplies PASS or FAIL later with
POST /v1/runs/{id}/label, for example once a customer confirms or rejects the answer.
"""

from __future__ import annotations

from typing import Any

from .base import CheckResult, Outcome, OutcomeChecker


class LateLabelChecker(OutcomeChecker):
    def check(self, output: str | None, expected: dict[str, Any] | None = None) -> CheckResult:
        return CheckResult(Outcome.UNKNOWN, "waiting for a label (POST /v1/runs/{id}/label)")
