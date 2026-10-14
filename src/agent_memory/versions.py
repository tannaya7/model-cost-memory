"""Model name and version normalisation.

Providers name models in many ways: an alias ("model-a"), a dated build ("model-a-2026-09-15"),
a compact date ("model-a-20260915"), a provider prefix ("acme/model-a"), or "-latest". To decide
whether two runs used the same model, and which version replaced which, names are reduced to a
*family* (the model without its date or alias suffix). The stored run keeps the string exactly as
the provider returned it; normalisation is only used for grouping and for matching catalog prices.
"""

from __future__ import annotations

import re

_SUFFIXES = [
    re.compile(r"[-_@.]\d{4}-\d{2}-\d{2}$"),  # model-2026-09-15
    re.compile(r"[-_@.]\d{8}$"),  # model-20260915
    re.compile(r"[-_@.]\d{4}-\d{2}$"),  # model-2026-09
    re.compile(r"[-_@.]\d{6}$"),  # model-202609
    re.compile(r"[-_@.](latest|preview|stable)$"),  # model-latest
]
_DATE = re.compile(r"(\d{4})-?(\d{2})(?:-?(\d{2}))?$")


def normalize(name: str) -> str:
    """Lower-case, trimmed, without a provider prefix ("acme/model-a" -> "model-a")."""
    cleaned = name.strip().lower()
    if "/" in cleaned:
        cleaned = cleaned.rsplit("/", 1)[1]
    return cleaned


def family(name: str) -> str:
    """The model without its date or alias suffix: "model-a-2026-09-15" -> "model-a"."""
    out = normalize(name)
    changed = True
    while changed:
        changed = False
        for pattern in _SUFFIXES:
            stripped = pattern.sub("", out)
            if stripped != out and stripped:
                out, changed = stripped, True
    return out


def version_label(name: str) -> str:
    """The version part of a name: its date when it has one ("2026-09-15"), otherwise the whole name."""
    out = normalize(name)
    match = _DATE.search(out)
    if match and out != family(out):
        year, month, day = match.group(1), match.group(2), match.group(3)
        return f"{year}-{month}" + (f"-{day}" if day else "")
    return out


def same_family(a: str, b: str) -> bool:
    return family(a) == family(b)
