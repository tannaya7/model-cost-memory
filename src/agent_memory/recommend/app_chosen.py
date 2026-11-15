"""Models that an app picks itself.

Cursor, GitHub Copilot, Windsurf and similar products choose the AI model per request, so a run whose
`model` is one of their labels has nothing the user could switch. Such a label is never suggested as a
model to move to, and a job whose current model is one gets no "switch" advice. Its runs and costs are
still recorded and counted as usual.

To cover another app, add its label to APP_CHOSEN_LABELS.
"""

from __future__ import annotations

# Lower case. A run's model matches when it equals a label, or starts with one followed by a
# separator (space, "-", "_", ":", "/", "(", ".", "@"), so "cursor-auto" and "Cursor Auto" match "cursor"
# but "cursorish" does not.
APP_CHOSEN_LABELS: tuple[str, ...] = (
    "cursor", "auto", "copilot", "github-copilot", "github copilot", "windsurf", "default",
    "codeium", "cascade", "composer", "tabnine", "supermaven", "cody",
)

_SEPARATORS = " -_:/(.@"

APP_CHOSEN_REASON = "This app chooses its own model, so there is nothing to switch here."


def is_app_chosen(model: str | None) -> bool:
    """True when `model` is an app's own label, not a real model that can be switched to."""
    if not model:
        return False
    name = model.strip().lower()
    return any(
        name == label or (name.startswith(label) and name[len(label)] in _SEPARATORS)
        for label in APP_CHOSEN_LABELS
    )
