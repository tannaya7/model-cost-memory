"""Structured logging (no database needed)."""

import asyncio
import io
import json
import logging

import pytest

from agent_memory.logging_config import (
    ContextFilter,
    JsonFormatter,
    bind,
    configure_logging,
    current_context,
    set_context,
)


@pytest.fixture
def stream():
    buffer = io.StringIO()
    configure_logging(level="DEBUG", fmt="json", stream=buffer)
    yield buffer
    root = logging.getLogger()
    for handler in list(root.handlers):
        if getattr(handler, "_agent_memory", False):
            root.removeHandler(handler)


def lines(stream):
    return [json.loads(line) for line in stream.getvalue().splitlines() if line.strip()]


def test_every_line_is_json_with_the_basic_fields(stream):
    logging.getLogger("agent_memory.test").info("hello %s", "world")
    (line,) = lines(stream)
    assert line["message"] == "hello world" and line["level"] == "INFO" and line["logger"] == "agent_memory.test"
    assert line["ts"].endswith("+00:00") and "T" in line["ts"]


def test_extra_fields_are_part_of_the_line(stream):
    logging.getLogger("agent_memory.test").info("run recorded", extra={"run_id": "r1", "outcome": "PASS"})
    (line,) = lines(stream)
    assert line["run_id"] == "r1" and line["outcome"] == "PASS"


def test_bound_context_is_attached_inside_the_block_and_removed_after(stream):
    log = logging.getLogger("agent_memory.test")
    with bind(project_id="demo", job_id="j1"):
        log.info("inside")
        with bind(run_id="r9"):
            log.info("nested")
    log.info("after")
    inside, nested, after = lines(stream)
    assert (inside["project_id"], inside["job_id"]) == ("demo", "j1") and "run_id" not in inside
    assert nested["run_id"] == "r9" and nested["project_id"] == "demo"
    assert "project_id" not in after and current_context() == {}


def test_explicit_extra_wins_over_the_bound_context(stream):
    with bind(run_id="from-context"):
        logging.getLogger("agent_memory.test").info("x", extra={"run_id": "explicit"})
    assert lines(stream)[0]["run_id"] == "explicit"


async def test_each_task_has_its_own_context(stream):
    log = logging.getLogger("agent_memory.test")

    async def request(name):
        set_context(project_id=name)
        await asyncio.sleep(0.01)
        log.info("handled")

    await asyncio.gather(request("a"), request("b"))
    handled = [line for line in lines(stream) if line["message"] == "handled"]
    assert sorted(line["project_id"] for line in handled) == ["a", "b"]  # no bleed between concurrent requests


def test_exceptions_are_included(stream):
    try:
        raise ValueError("boom")
    except ValueError:
        logging.getLogger("agent_memory.test").exception("failed")
    line = lines(stream)[0]
    assert "ValueError: boom" in line["exception"]


def test_unserialisable_values_do_not_break_logging(stream):
    logging.getLogger("agent_memory.test").info("odd", extra={"thing": object()})
    assert "object" in lines(stream)[0]["thing"]


def test_text_format_appends_the_fields():
    buffer = io.StringIO()
    configure_logging(level="INFO", fmt="text", stream=buffer)
    try:
        with bind(project_id="demo"):
            logging.getLogger("agent_memory.test").info("hello", extra={"run_id": "r1"})
        out = buffer.getvalue()
        assert "hello" in out and "run_id=r1" in out and "project_id=demo" in out
    finally:
        for handler in list(logging.getLogger().handlers):
            if getattr(handler, "_agent_memory", False):
                logging.getLogger().removeHandler(handler)


def test_configuring_twice_does_not_duplicate_lines(stream):
    configure_logging(level="DEBUG", fmt="json", stream=stream)
    logging.getLogger("agent_memory.test").info("once")
    assert len(lines(stream)) == 1


def test_an_unknown_format_is_rejected():
    with pytest.raises(ValueError):
        configure_logging(fmt="xml")


def test_formatter_and_filter_can_be_used_directly():
    record = logging.makeLogRecord({"msg": "hi", "levelname": "INFO", "name": "n"})
    with bind(job_id="j"):
        ContextFilter().filter(record)
    assert json.loads(JsonFormatter().format(record))["job_id"] == "j"
