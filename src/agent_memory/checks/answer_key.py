"""Answer-key check: do the fields in the model's JSON output match the expected values?

The job lists which fields to compare (`check_config.fields`). The sender supplies the expected
values with each run. Numbers match within half a cent after stripping currency symbols and
thousands separators; text matches ignoring case and extra whitespace.
"""

from __future__ import annotations

import math
import re
from typing import Any

from .base import CheckResult, Outcome, OutcomeChecker, parse_json

_NUMBER = re.compile(r"^[-+]?\d+(\.\d+)?$")
MONEY_TOLERANCE = 0.005


def _as_number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        cleaned = re.sub(r"[\s$€£¥,]", "", value)
        if _NUMBER.match(cleaned):
            return float(cleaned)
    return None


def _text(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value)).strip().casefold()


def values_match(expected: Any, actual: Any) -> bool:
    exp_num, act_num = _as_number(expected), _as_number(actual)
    if exp_num is not None and act_num is not None:
        return math.isclose(exp_num, act_num, abs_tol=MONEY_TOLERANCE)
    return _text(expected) == _text(actual)


class AnswerKeyChecker(OutcomeChecker):
    def __init__(self, fields: list[str]) -> None:
        self.fields = fields

    def check(self, output: str | None, expected: dict[str, Any] | None = None) -> CheckResult:
        missing = [f for f in self.fields if not expected or f not in expected]
        if missing:
            return CheckResult(
                Outcome.UNKNOWN,
                "no expected value supplied for: " + ", ".join(missing) + " (send it with the run or label it later)",
            )
        ok, parsed = parse_json(output)
        if not ok or not isinstance(parsed, dict):
            return CheckResult(Outcome.FAIL, "output is not a JSON object")
        wrong = []
        for field in self.fields:
            if field not in parsed:
                wrong.append(f"{field}: missing")
            elif not values_match(expected[field], parsed[field]):
                wrong.append(f"{field}: expected {expected[field]}, got {parsed[field]}")
        if wrong:
            return CheckResult(Outcome.FAIL, "; ".join(wrong))
        return CheckResult(Outcome.PASS, f"all {len(self.fields)} fields match")
