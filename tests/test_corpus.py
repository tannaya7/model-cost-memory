"""The invoice corpus is deterministic and its answers are exact (no database needed)."""

import re
from decimal import Decimal

from agent_memory.checks import Outcome, build_checker
from agent_memory.corpus import DIFFICULTIES, JOB_FIELDS, generate_invoices


def test_the_same_seed_gives_the_same_corpus():
    assert generate_invoices(30, seed=1) == generate_invoices(30, seed=1)
    assert generate_invoices(30, seed=1) != generate_invoices(30, seed=2)


def test_difficulty_levels_are_balanced_and_ids_are_unique():
    invoices = generate_invoices(90)
    for level in DIFFICULTIES:
        assert sum(i.difficulty == level for i in invoices) == 30
    assert len({i.id for i in invoices}) == 90
    assert len({i.expected["invoice_number"] for i in invoices}) == 90


def test_expected_answers_are_exact_and_present_in_the_document():
    for inv in generate_invoices(60):
        assert set(inv.expected) == set(JOB_FIELDS)
        assert re.fullmatch(r"\d{4}-\d{2}-\d{2}", inv.expected["date"])
        assert inv.expected["vendor"].casefold() in inv.text.casefold()
        assert inv.expected["invoice_number"] in inv.text
        total = Decimal(str(inv.expected["total"]))
        assert f"{total:.2f}" in inv.text or f"{total:,.2f}" in inv.text


def test_hard_invoices_contain_distractors_the_easy_ones_do_not():
    easy = next(i for i in generate_invoices(3) if i.difficulty == "easy")
    hard = next(i for i in generate_invoices(3) if i.difficulty == "hard")
    assert "Subtotal" not in easy.text and "PO-" not in easy.text
    assert "PO-" in hard.text and "Previous balance" in hard.text


def test_the_answer_key_checker_accepts_the_expected_answer_and_rejects_a_wrong_one():
    inv = generate_invoices(1)[0]
    checker = build_checker("ANSWER_KEY", {"fields": JOB_FIELDS})
    right = '{"vendor": "%s", "invoice_number": "%s", "date": "%s", "total": %s}' % (
        inv.expected["vendor"], inv.expected["invoice_number"], inv.expected["date"], inv.expected["total"])
    assert checker.check(right, inv.expected).outcome is Outcome.PASS
    wrong = right.replace(inv.expected["invoice_number"], "INV-0000")
    assert checker.check(wrong, inv.expected).outcome is Outcome.FAIL
