"""A model option: a model family, and the reasoning effort it was run at when the run says so.

The same model at low and at medium effort costs different amounts and can pass different shares of a
job's checks, so the engine compares each pair as its own option: "sonnet-5@low" next to
"opus-5-5@medium". A run that names no effort is the model alone ("sonnet-5"), as before effort was
recorded, so jobs that never send it are judged exactly as they were.
"""

from __future__ import annotations

SEPARATOR = "@"
MAX_EFFORT_LENGTH = 20


def normalize_effort(effort: str | None) -> str | None:
    """"Low " -> "low"; empty -> None."""
    if effort is None:
        return None
    value = effort.strip().lower()
    return value or None


def option_name(model: str, effort: str | None) -> str:
    effort = normalize_effort(effort)
    return f"{model}{SEPARATOR}{effort}" if effort else model


def split_option(name: str) -> tuple[str, str | None]:
    """"sonnet-5@low" -> ("sonnet-5", "low"); "sonnet-5" -> ("sonnet-5", None)."""
    model, _, effort = name.partition(SEPARATOR)
    return model, (effort or None)
