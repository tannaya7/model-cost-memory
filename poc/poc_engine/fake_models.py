"""Simulated AI provider, so the POC needs no API keys and costs nothing.

It behaves like a real provider in the ways that matter here: it returns an output, the
provider-resolved model version, and token usage (input, output incl. thinking, cache read/write).
Each model version has a different chance of getting the answer right, and long inputs are harder.

Two customer jobs:
  invoice-extract  pull vendor, invoice number, date and total out of an invoice   (ANSWER_KEY check)
  ticket-classify  label a support ticket with a category and priority             (SCHEMA check)
"""

import json
import random

VENDORS = ["Acme Supplies", "Northwind Traders", "Globex Ltd", "Initech", "Umbrella Retail",
           "Stark Components", "Wayne Logistics", "Hooli Cloud"]
CATEGORIES = ["billing", "bug", "account", "feature_request"]

# P(correct answer) by model version: (short input, long input). prompt v2 helps on long inputs.
ACCURACY = {
    "invoice-extract": {
        "mini-2026-06": (0.97, 0.78),
        "pro-2026-03": (0.99, 0.975),
        "pro-2026-09": (0.93, 0.88),       # the upgrade that quietly got worse
        "max-2026-05": (0.995, 0.985),
        "classic-2025-11": (0.98, 0.96),
    },
    "ticket-classify": {
        "mini-2026-06": (0.99, 0.99),
        "pro-2026-09": (0.985, 0.985),
        "max-2026-05": (0.99, 0.99),
    },
}
PROMPT_V2_LONG_BONUS = 0.12
THINKING_TOKENS = {"max": 320}            # hidden reasoning, billed as output
LATENCY_MS = {"mini": (350, 900), "pro": (900, 1800), "max": (2500, 5200), "classic": (1100, 2100)}
SYSTEM_PROMPT_TOKENS = 350                # cached after the first call


def make_invoice(rng: random.Random) -> tuple[str, dict, int]:
    lines = rng.randint(3, 8) if rng.random() < 0.65 else rng.randint(25, 60)
    ref = {"vendor": rng.choice(VENDORS),
           "invoice_number": f"INV-{rng.randint(10000, 99999)}",
           "date": f"2026-{rng.randint(1, 9):02d}-{rng.randint(1, 28):02d}",
           "total": round(rng.uniform(50, 9000), 2)}
    items = "\n".join(f"  item {i + 1}: widget-{rng.randint(100, 999)} x{rng.randint(1, 9)}"
                      for i in range(min(lines, 6)))
    more = f"\n  ... {lines - 6} more lines" if lines > 6 else ""
    prompt = (f"Extract vendor, invoice_number, date and total as JSON.\n\nINVOICE\n"
              f"From: {ref['vendor']}\nNo: {ref['invoice_number']}\nDate: {ref['date']}\n"
              f"Lines:\n{items}{more}\nTOTAL DUE: {ref['total']}")
    tokens_in = 300 + 60 * lines
    return prompt, ref, tokens_in


def make_ticket(rng: random.Random) -> tuple[str, dict | None, int]:
    cat = rng.choice(CATEGORIES)
    prompt = (f"Classify this ticket as JSON with 'category' ({', '.join(CATEGORIES)}) and "
              f"'priority' (1-3).\n\nTICKET: customer writes about a {cat.replace('_', ' ')} problem.")
    return prompt, None, rng.randint(180, 520)


def call(model_version: str, job: str, prompt: str, reference: dict | None, tokens_in: int,
         prompt_version: str, rng: random.Random, first_call_today: bool = False) -> dict:
    """Pretend to call the provider. Returns a response shaped like a real one."""
    model = model_version.split("-")[0]
    short_p, long_p = ACCURACY[job][model_version]
    long_input = tokens_in >= 1000
    p = long_p if long_input else short_p
    if long_input and prompt_version == "v2":
        p = min(0.99, p + PROMPT_V2_LONG_BONUS)
    correct = rng.random() < p

    if job == "invoice-extract":
        out = dict(reference)
        if not correct:
            mistake = rng.choice(["total", "date", "vendor"])
            if mistake == "total":
                out["total"] = round(out["total"] * rng.choice([0.9, 1.1, 10]), 2)
            elif mistake == "date":
                y, m, d = out["date"].split("-")
                out["date"] = f"{d}/{m}/{y}"
            else:
                out.pop("vendor")
        output = json.dumps(out)
    else:
        cat = next((c for c in CATEGORIES if c.replace("_", " ") in prompt), "bug")
        out = {"category": cat, "priority": rng.randint(1, 3)}
        if not correct:
            if rng.random() < 0.5:
                out["category"] = "other"
            else:
                out["priority"] = "high"
        output = json.dumps(out)

    cache_read = 0 if first_call_today else SYSTEM_PROMPT_TOKENS
    cache_write = SYSTEM_PROMPT_TOKENS if first_call_today else 0
    lo, hi = LATENCY_MS[model]
    return {
        "model": model,
        "model_version": model_version,           # providers report the resolved version
        "output": output,
        "usage": {
            "input_tokens": tokens_in,
            "output_tokens": rng.randint(55, 95) + THINKING_TOKENS.get(model, 0),
            "cache_read_tokens": cache_read,
            "cache_write_tokens": cache_write,
        },
        "latency_ms": rng.randint(lo, hi),
    }
