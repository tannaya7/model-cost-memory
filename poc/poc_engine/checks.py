"""Outcome checkers: decide PASS, FAIL or UNKNOWN for a run. No AI model is ever the judge.

ANSWER_KEY  the run arrives with the known-correct answer; listed fields must match exactly
SCHEMA      the output must be JSON with the required fields, types and allowed values

The real system adds TEST_COMMAND (tests run in a Docker sandbox) and LATE_LABEL.
"""

import json

TYPES = {"string": str, "integer": int, "number": (int, float), "boolean": bool}


def check(job: dict, output: str | None, reference: dict | None) -> tuple[str, str]:
    cfg = json.loads(job["check_config"])
    try:
        out = json.loads(output or "")
    except (ValueError, TypeError):
        return "FAIL", "output is not valid JSON"
    if not isinstance(out, dict):
        return "FAIL", "output is JSON but not an object"

    if job["check_kind"] == "ANSWER_KEY":
        if reference is None:
            return "UNKNOWN", "no answer key sent with this run; it can be labelled later"
        for field in cfg["fields"]:
            if out.get(field) != reference.get(field):
                return "FAIL", f"'{field}' is {out.get(field)!r}, expected {reference.get(field)!r}"
        return "PASS", f"all {len(cfg['fields'])} fields match the answer key"

    if job["check_kind"] == "SCHEMA":
        for field, typ in cfg["required"].items():
            if field not in out:
                return "FAIL", f"required field '{field}' is missing"
            if not isinstance(out[field], TYPES[typ]) or (typ == "integer" and isinstance(out[field], bool)):
                return "FAIL", f"'{field}' should be {typ}, got {type(out[field]).__name__}"
        for field, allowed in cfg.get("allowed", {}).items():
            if out.get(field) not in allowed:
                return "FAIL", f"'{field}' is {out.get(field)!r}, not one of {allowed}"
        return "PASS", "output matches the schema"

    return "UNKNOWN", f"unknown check kind {job['check_kind']}"
