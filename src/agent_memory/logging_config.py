"""Structured logging: JSON lines that carry run_id, job_id and project_id (technical plan 3.11).

One run can then be followed end to end by filtering the logs on its id. Fields are attached two ways:

  log.info("run recorded", extra={"run_id": rid, "outcome": "PASS"})   # for this one line
  with bind(project_id="demo", job_id=jid): ...                         # for every line inside the block
  set_context(project_id="demo")                                        # for the rest of this request or task

LOG_FORMAT=json (the default, for servers) or text (readable in a terminal); LOG_LEVEL defaults to INFO.
"""

from __future__ import annotations

import json
import logging
import os
import sys
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import UTC, datetime
from typing import Any

_context: ContextVar[dict[str, str]] = ContextVar("log_context", default={})

# Attributes every LogRecord has; anything else on a record came from `extra=` or the bound context.
_STANDARD = set(vars(logging.makeLogRecord({}))) | {"message", "asctime", "taskName"}


def set_context(**fields: Any) -> None:
    """Attach fields to every log line emitted by the current task (one API request is one task)."""
    _context.set({**_context.get(), **{k: str(v) for k, v in fields.items() if v is not None}})


@contextmanager
def bind(**fields: Any) -> Iterator[None]:
    """Attach fields to every log line emitted inside the block, then remove them."""
    token = _context.set({**_context.get(), **{k: str(v) for k, v in fields.items() if v is not None}})
    try:
        yield
    finally:
        _context.reset(token)


def current_context() -> dict[str, str]:
    return dict(_context.get())


class ContextFilter(logging.Filter):
    """Copies the bound context onto each record, without overriding fields given with extra=."""

    def filter(self, record: logging.LogRecord) -> bool:
        for key, value in _context.get().items():
            if not hasattr(record, key):
                setattr(record, key, value)
        return True


def _extras(record: logging.LogRecord) -> dict[str, Any]:
    return {k: v for k, v in record.__dict__.items() if k not in _STANDARD and not k.startswith("_")}


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "ts": datetime.fromtimestamp(record.created, UTC).isoformat(timespec="milliseconds"),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        payload.update(_extras(record))
        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)
        return json.dumps(payload, default=str, ensure_ascii=False)


class TextFormatter(logging.Formatter):
    def __init__(self) -> None:
        super().__init__("%(asctime)s %(levelname)s %(name)s %(message)s")

    def format(self, record: logging.LogRecord) -> str:
        line = super().format(record)
        extras = _extras(record)
        if extras:
            line += "  " + " ".join(f"{k}={v}" for k, v in extras.items())
        return line


def configure_logging(level: str | None = None, fmt: str | None = None, stream: Any = None) -> None:
    """Install the handler on the root logger. Safe to call more than once."""
    fmt = (fmt or os.environ.get("LOG_FORMAT", "json")).lower()
    if fmt not in ("json", "text"):
        raise ValueError("LOG_FORMAT must be json or text")
    handler = logging.StreamHandler(stream or sys.stderr)
    handler.setFormatter(JsonFormatter() if fmt == "json" else TextFormatter())
    handler.addFilter(ContextFilter())
    root = logging.getLogger()
    for existing in list(root.handlers):
        if getattr(existing, "_agent_memory", False):
            root.removeHandler(existing)
    handler._agent_memory = True  # type: ignore[attr-defined]
    root.addHandler(handler)
    root.setLevel((level or os.environ.get("LOG_LEVEL", "INFO")).upper())
