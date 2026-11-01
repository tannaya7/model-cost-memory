"""Privacy rules for what is stored about a run.

Tool-call arguments can hold anything an agent passed to a tool: customer names, file contents, secrets.
So by default only each tool's name and call id are kept, which is enough to count and compare tool use.
A project must opt in (projects.store_tool_arguments) to keep arguments.

The same rule runs in the SDK (so arguments never leave the customer's application unless asked) and on
the server (so a client that sends them anyway still has them dropped).
"""

from __future__ import annotations

from typing import Any

MAX_TOOL_CALLS = 100
MAX_FIELD_CHARS = 200

_NAME_KEYS = ("name", "tool", "tool_name")
_ID_KEYS = ("id", "call_id", "tool_call_id", "tool_use_id")
_ARGUMENT_KEYS = ("arguments", "args", "input", "parameters")


def _first(entry: dict[str, Any], keys: tuple[str, ...]) -> Any:
    for key in keys:
        if entry.get(key) is not None:
            return entry[key]
    function = entry.get("function")
    if isinstance(function, dict):  # OpenAI style: {"id": ..., "function": {"name": ..., "arguments": ...}}
        for key in keys:
            if function.get(key) is not None:
                return function[key]
    return None


def _short(value: Any) -> str | None:
    return None if value is None else str(value)[:MAX_FIELD_CHARS]


def sanitize_tool_calls(calls: list[Any] | None, *, keep_arguments: bool = False) -> list[dict[str, Any]] | None:
    """Reduce tool calls to their names and ids (and arguments only when `keep_arguments`)."""
    if calls is None:
        return None
    cleaned: list[dict[str, Any]] = []
    for call in calls[:MAX_TOOL_CALLS]:
        if not isinstance(call, dict):
            continue
        name, call_id = _short(_first(call, _NAME_KEYS)), _short(_first(call, _ID_KEYS))
        if name is None and call_id is None:
            continue
        entry: dict[str, Any] = {"name": name, "id": call_id}
        if keep_arguments:
            arguments = _first(call, _ARGUMENT_KEYS)
            if arguments is not None:
                entry["arguments"] = arguments
        cleaned.append(entry)
    return cleaned
