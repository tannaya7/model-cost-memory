"""Quality flags for one recorded call: things about its usage block that look wrong or that a total cannot be trusted on.

A flag never stops a call from being recorded and never changes a number. It is stored beside the call (runs.data_flags) so the Data coverage
page can count it, say why, and show examples. Each rule is deterministic and explained here:

  TOTAL_MISMATCH            the provider's own total differs from the sum of its parts as this product reads them (usage_ledger._reconcile).
                            It can come from a field this product does not know yet, so it is a flag to review, not an error.
  UNRECOGNISED_USAGE        a usage block was sent but its layout is one this product does not recognise: nothing was read from it.
  REASONING_EXCEEDS_OUTPUT  reasoning tokens are reported as larger than the output tokens they are part of, for every provider this
                            product reads. That cannot be right, so the split is not trusted.
  CACHE_1H_EXCEEDS_WRITE    the part of cache writes kept for an hour is larger than all cache writes. Impossible, so not trusted.

What is NOT flagged here, because the data to do it does not exist: late or out-of-order events (the app's own clock is not recorded),
calls that never reached this product, and whether a streaming response ever delivered its final usage (a call without usage is counted
separately as "no usage block").
"""

from __future__ import annotations

from typing import Any

from .usage_ledger import read_usage

LABELS = {
    "TOTAL_MISMATCH": "The provider's own total differs from the sum of its parts",
    "UNRECOGNISED_USAGE": "The usage block has a layout this product does not recognise",
    "REASONING_EXCEEDS_OUTPUT": "Reasoning tokens are larger than the output they are part of",
    "CACHE_1H_EXCEEDS_WRITE": "The 1-hour cache write is larger than all cache writes",
}


def flags_for(*, usage_raw: dict[str, Any] | None, tokens_out: int | None, reasoning_tokens: int | None,
              cache_write_tokens: int | None, cache_write_1h_tokens: int | None) -> list[str]:
    found: list[str] = []
    if usage_raw:
        for note in read_usage(usage_raw)["notes"]:
            if "differs from the sum of its parts" in note:
                found.append("TOTAL_MISMATCH")
            elif "unrecognised shape" in note:
                found.append("UNRECOGNISED_USAGE")
    if reasoning_tokens is not None and tokens_out is not None and reasoning_tokens > tokens_out:
        found.append("REASONING_EXCEEDS_OUTPUT")
    if cache_write_1h_tokens and cache_write_tokens is not None and cache_write_1h_tokens > cache_write_tokens:
        found.append("CACHE_1H_EXCEEDS_WRITE")
    return sorted(set(found))
