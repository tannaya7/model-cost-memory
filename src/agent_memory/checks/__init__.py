"""Outcome checkers: resolve each run to PASS, FAIL or UNKNOWN. Never decided by a model."""

from __future__ import annotations

import logging
from typing import Any

from .answer_key import AnswerKeyChecker
from .base import CheckResult, Outcome, OutcomeChecker, parse_json
from .late_label import LateLabelChecker
from .schema import SchemaChecker

log = logging.getLogger("agent_memory.checks")

__all__ = [
    "CheckResult", "Outcome", "OutcomeChecker", "build_checker", "check_run", "parse_json",
]


def build_checker(check_kind: str, check_config: dict[str, Any]) -> OutcomeChecker:
    """The checker for a job's check kind. TEST_COMMAND (a code sandbox) is a later job type."""
    if check_kind == "ANSWER_KEY":
        return AnswerKeyChecker(list(check_config["fields"]))
    if check_kind == "SCHEMA":
        return SchemaChecker(check_config["schema"])
    if check_kind == "LATE_LABEL":
        return LateLabelChecker()
    raise ValueError(f"check kind {check_kind} is not available in this version")


def check_run(
    check_kind: str, check_config: dict[str, Any], output: str | None, expected: dict[str, Any] | None
) -> CheckResult:
    """Resolve one run. A check that cannot run is UNKNOWN with the reason, never a guess."""
    try:
        return build_checker(check_kind, check_config).check(output, expected)
    except Exception as exc:  # a broken job definition must not lose the run
        log.warning("outcome check could not run: %s", exc)
        return CheckResult(Outcome.UNKNOWN, f"the check could not run: {exc}")
