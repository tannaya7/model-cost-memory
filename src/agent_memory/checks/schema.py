"""Schema check: does the model's output parse as JSON that satisfies the job's JSON Schema?"""

from __future__ import annotations

from typing import Any

from jsonschema import Draft202012Validator

from .base import CheckResult, Outcome, OutcomeChecker, parse_json


class SchemaChecker(OutcomeChecker):
    def __init__(self, schema: dict[str, Any]) -> None:
        self._validator = Draft202012Validator(schema)

    def check(self, output: str | None, expected: dict[str, Any] | None = None) -> CheckResult:
        ok, parsed = parse_json(output)
        if not ok:
            return CheckResult(Outcome.FAIL, "output is not valid JSON")
        errors = sorted(self._validator.iter_errors(parsed), key=lambda e: list(e.absolute_path))
        if errors:
            first = errors[0]
            where = "/".join(str(p) for p in first.absolute_path) or "(root)"
            extra = f" (+{len(errors) - 1} more)" if len(errors) > 1 else ""
            return CheckResult(Outcome.FAIL, f"{where}: {first.message}{extra}")
        return CheckResult(Outcome.PASS, "output matches the schema")
