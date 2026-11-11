"""Outcome checkers (no database needed)."""

import pytest
from hypothesis import given
from hypothesis import strategies as st

from agent_memory.checks import Outcome, build_checker, check_run, parse_json
from agent_memory.checks.answer_key import AnswerKeyChecker, values_match
from agent_memory.checks.schema import SchemaChecker

EXPECTED = {"vendor": "ShopCo Ltd", "invoice_number": "INV-1042", "date": "2026-10-13", "total": 1250.0}
FIELDS = list(EXPECTED)


@pytest.mark.parametrize(
    "text, ok",
    [
        ('{"a": 1}', True),
        ('```json\n{"a": 1}\n```', True),
        ('```\n{"a": 1}\n```', True),
        ('Sure! Here it is: {"a": 1} Hope that helps.', True),
        ("not json at all", False),
        ("", False),
        (None, False),
        ('{"a": ', False),
    ],
)
def test_parse_json_tolerates_fences_and_prose(text, ok):
    assert parse_json(text)[0] is ok


@pytest.mark.parametrize(
    "expected, actual, match",
    [
        (1250.0, "1,250.00", True),
        (1250.0, "$1250", True),
        (1250.0, 1250.004, True),
        (1250.0, 1205.0, False),
        ("ShopCo Ltd", "  shopco   ltd ", True),
        ("2026-10-13", "2026-10-14", False),
        (True, "true", True),
        ("abc", None, False),
    ],
)
def test_value_matching(expected, actual, match):
    assert values_match(expected, actual) is match


def test_answer_key_passes_when_every_field_matches():
    out = '{"vendor": "shopco ltd", "invoice_number": "INV-1042", "date": "2026-10-13", "total": "1,250.00"}'
    result = AnswerKeyChecker(FIELDS).check(out, EXPECTED)
    assert result.outcome is Outcome.PASS and "all 4 fields" in result.reason


def test_answer_key_fails_and_names_the_wrong_fields():
    out = '{"vendor": "ShopCo Ltd", "invoice_number": "INV-1043", "date": "2026-10-13"}'
    result = AnswerKeyChecker(FIELDS).check(out, EXPECTED)
    assert result.outcome is Outcome.FAIL
    assert "invoice_number: expected INV-1042, got INV-1043" in result.reason
    assert "total: missing" in result.reason


def test_answer_key_fails_on_output_that_is_not_json():
    result = AnswerKeyChecker(FIELDS).check("The total is 1250", EXPECTED)
    assert result.outcome is Outcome.FAIL and "not a JSON object" in result.reason


def test_answer_key_is_unknown_without_an_expected_answer():
    result = AnswerKeyChecker(FIELDS).check('{"total": 1}', None)
    assert result.outcome is Outcome.UNKNOWN and "vendor" in result.reason
    partial = AnswerKeyChecker(FIELDS).check('{"total": 1}', {"total": 1})
    assert partial.outcome is Outcome.UNKNOWN


SCHEMA = {
    "type": "object", "required": ["category", "priority"],
    "properties": {"category": {"enum": ["billing", "bug"]}, "priority": {"type": "integer"}},
}


def test_schema_check_passes_a_conforming_answer():
    result = SchemaChecker(SCHEMA).check('{"category": "bug", "priority": 2}')
    assert result.outcome is Outcome.PASS


@pytest.mark.parametrize(
    "out, reason_part",
    [
        ('{"category": "other", "priority": 2}', "category"),
        ('{"category": "bug"}', "priority"),
        ('{"category": "bug", "priority": "high"}', "priority"),
        ("plain text", "not valid JSON"),
    ],
)
def test_schema_check_fails_with_the_reason(out, reason_part):
    result = SchemaChecker(SCHEMA).check(out)
    assert result.outcome is Outcome.FAIL and reason_part in result.reason


def test_late_label_jobs_stay_unknown_until_labelled():
    result = check_run("LATE_LABEL", {}, "anything", None)
    assert result.outcome is Outcome.UNKNOWN and "label" in result.reason


def test_a_check_that_cannot_run_is_unknown_not_a_guess():
    result = check_run("ANSWER_KEY", {"oops": []}, "{}", {"a": 1})  # broken job definition
    assert result.outcome is Outcome.UNKNOWN and "could not run" in result.reason
    unsupported = check_run("TEST_COMMAND", {"command": "pytest"}, "x", None)
    assert unsupported.outcome is Outcome.UNKNOWN


def test_build_checker_rejects_unsupported_kinds():
    with pytest.raises(ValueError):
        build_checker("TEST_COMMAND", {})


@given(st.text(max_size=200))
def test_no_output_can_crash_the_checkers(text):
    for checker in (AnswerKeyChecker(["a"]), SchemaChecker({"type": "object"})):
        result = checker.check(text, {"a": 1})
        assert result.outcome in Outcome
