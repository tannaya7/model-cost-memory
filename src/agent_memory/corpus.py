"""Synthetic invoices with known answers, for the held-out check (scripts/holdout_check.py).

Every invoice is generated from its answer, so the expected values are exact and free: nothing is
hand-labelled and no model is involved. The documents come in three difficulty levels, so a small
model fails more often than a large one and the system has real pass and fail differences to learn
from:

  easy    one clean layout, one date, one total
  medium  distractors: a purchase-order number, a due date, a subtotal and a tax line
  hard    awkward formats: dates like "13 Oct 2026", thousands separators, several amounts and ids

Everything is deterministic for a given seed, and the documents are synthetic, which is what makes
it acceptable to send them to free-tier model providers.
"""

from __future__ import annotations

import random
from dataclasses import dataclass
from datetime import date, timedelta
from decimal import ROUND_HALF_UP, Decimal
from typing import Any

JOB_NAME = "invoice-extract"
JOB_FIELDS = ["vendor", "invoice_number", "date", "total"]
DIFFICULTIES = ("easy", "medium", "hard")

PROMPT = (
    "Extract the vendor name, the invoice number, the invoice date (as YYYY-MM-DD) and the total amount "
    "due from the invoice below. Reply with only a JSON object with the keys vendor, invoice_number, "
    "date and total (a number).\n\nInvoice:\n{text}"
)

VENDORS = [
    "Northwind Traders", "Acme Supplies Ltd", "Bluebird Logistics", "Harbor & Finch LLP", "Quill Office Goods",
    "Summit Cloud Services", "Greenleaf Catering", "Ironclad Hardware", "Marlowe Print Works", "Tidewater Freight",
    "Sunrise Bakery Co", "Orbit Software Inc", "Kestrel Instruments", "Lantern Studio", "Redwood Timber",
]
ITEMS = [
    "Consulting hours", "Office chairs", "Cloud hosting", "Printer paper (box)", "Freight charge", "Software licence",
    "Catering - lunch", "Maintenance visit", "Network cable", "Design work", "Packaging", "Training session",
]
MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


@dataclass(frozen=True)
class Invoice:
    id: str
    difficulty: str
    text: str
    expected: dict[str, Any]

    @property
    def prompt(self) -> str:
        return PROMPT.format(text=self.text)


def _money(value: Decimal) -> Decimal:
    return value.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def _lines(rng: random.Random, count: int) -> list[tuple[str, int, Decimal]]:
    return [(rng.choice(ITEMS), rng.randint(1, 12), _money(Decimal(rng.randint(500, 90000)) / 100)) for _ in range(count)]


def _fmt_amount(value: Decimal, thousands: bool) -> str:
    return f"{value:,.2f}" if thousands else f"{value:.2f}"


def _render(rng: random.Random, difficulty: str, vendor: str, number: str, when: date, lines, total: Decimal, subtotal: Decimal, tax: Decimal) -> str:
    po = f"PO-{rng.randint(10000, 99999)}"
    due = when + timedelta(days=rng.choice([14, 30, 45]))
    rows = [f"{name}  x{qty}  @ {_fmt_amount(price, difficulty == 'hard')}" for name, qty, price in lines]
    if difficulty == "easy":
        return "\n".join(
            [f"INVOICE {number}", f"From: {vendor}", f"Date: {when.isoformat()}", *rows, f"Total due: {_fmt_amount(total, False)}"]
        )
    if difficulty == "medium":
        return "\n".join(
            [vendor, f"Invoice No: {number}", f"Invoice date: {when.isoformat()}   Due date: {due.isoformat()}",
             f"Your reference: {po}", "", *rows, "", f"Subtotal: {_fmt_amount(subtotal, False)}",
             f"Tax: {_fmt_amount(tax, False)}", f"TOTAL DUE: {_fmt_amount(total, False)}"]
        )
    shown = f"{when.day} {MONTHS[when.month - 1]} {when.year}"
    return "\n".join(
        [f"{vendor.upper()} - TAX INVOICE", f"Ref {po} / Inv. {number}", f"Issued {shown} (payable by {due.day} {MONTHS[due.month - 1]} {due.year})",
         "", *rows, "", f"Net: USD {_fmt_amount(subtotal, True)}", f"VAT: USD {_fmt_amount(tax, True)}",
         f"Balance payable: USD {_fmt_amount(total, True)}", f"Previous balance carried: USD {_fmt_amount(_money(total / 3), True)}"]
    )


def generate_invoices(n: int, seed: int = 7) -> list[Invoice]:
    """`n` invoices, cycling through the difficulty levels, identical for the same seed."""
    rng = random.Random(seed)
    used: set[str] = set()
    invoices = []
    for i in range(n):
        difficulty = DIFFICULTIES[i % len(DIFFICULTIES)]
        number = f"INV-{rng.randint(1000, 9999)}"
        while number in used:
            number = f"INV-{rng.randint(1000, 9999)}"
        used.add(number)
        vendor = rng.choice(VENDORS)
        when = date(2026, 1, 1) + timedelta(days=rng.randint(0, 300))
        lines = _lines(rng, rng.randint(1, 4 if difficulty == "easy" else 6))
        subtotal = _money(sum((price * qty for _, qty, price in lines), Decimal(0)))
        tax = _money(subtotal * Decimal(rng.choice(["0", "0.05", "0.08", "0.2"])))
        total = subtotal + tax
        text = _render(rng, difficulty, vendor, number, when, lines, total, subtotal, tax)
        expected = {"vendor": vendor, "invoice_number": number, "date": when.isoformat(), "total": float(total)}
        invoices.append(Invoice(id=f"inv-{seed}-{i:04d}", difficulty=difficulty, text=text, expected=expected))
    return invoices
