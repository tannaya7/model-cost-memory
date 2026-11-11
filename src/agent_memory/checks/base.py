"""The OutcomeChecker interface every check kind implements.

A checker looks at a model's output (and, for an answer key, the expected answer) and returns PASS,
FAIL or UNKNOWN with a short reason. It is plain code: no model ever decides an outcome, so the same
run always gets the same result.
"""

from __future__ import annotations

import json
import re
from abc import ABC, abstractmethod
from dataclasses import dataclass
from enum import Enum
from typing import Any


class Outcome(str, Enum):
    PASS = "PASS"
    FAIL = "FAIL"
    UNKNOWN = "UNKNOWN"


@dataclass(frozen=True)
class CheckResult:
    outcome: Outcome
    reason: str | None = None


class OutcomeChecker(ABC):
    @abstractmethod
    def check(self, output: str | None, expected: dict[str, Any] | None = None) -> CheckResult:
        """Return PASS or FAIL, or UNKNOWN when the check cannot be decided yet."""


_FENCE = re.compile(r"^```[a-zA-Z0-9_-]*\s*\n(.*?)\n?```\s*$", re.DOTALL)


def parse_json(text: str | None) -> tuple[bool, Any]:
    """Parse model output as JSON, tolerating a markdown code fence or text around one object.

    Returns (ok, value). Models often wrap JSON in prose or fences; that is still a usable answer.
    """
    if not text or not text.strip():
        return False, None
    candidate = text.strip()
    fenced = _FENCE.match(candidate)
    if fenced:
        candidate = fenced.group(1).strip()
    try:
        return True, json.loads(candidate)
    except ValueError:
        pass
    start, end = candidate.find("{"), candidate.rfind("}")
    if start != -1 and end > start:
        try:
            return True, json.loads(candidate[start : end + 1])
        except ValueError:
            return False, None
    return False, None
