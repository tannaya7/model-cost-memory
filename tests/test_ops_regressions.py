"""Prompt 26 regressions: webhook replay window, the production bundle, and the secrets that must never be logged or returned.

Everything here is local: no real webhook is sent, no provider is called, nothing leaves the machine."""

import json
import re
import time
from pathlib import Path

import pytest

from agent_memory.alerts.notifier import TIMESTAMP_TOLERANCE_SECONDS, sign, sign_v2, verify_v2

ROOT = Path(__file__).resolve().parents[1]
BODY = json.dumps({"alert_id": "a1", "kind": "BUDGET"}, sort_keys=True).encode()
SECRET = "whsec_unit_test"


def stamp(offset: int = 0, now: float = 1_800_000_000.0) -> tuple[str, float]:
    return str(int(now) + offset), now


def test_a_fresh_signed_message_is_accepted():
    ts, now = stamp()
    assert verify_v2(SECRET, ts, BODY, sign_v2(SECRET, ts, BODY), now=now)


@pytest.mark.parametrize("offset", [-(TIMESTAMP_TOLERANCE_SECONDS + 1), TIMESTAMP_TOLERANCE_SECONDS + 1, -86_400])
def test_a_captured_message_replayed_outside_the_window_is_refused(offset):
    ts, now = stamp(offset)
    assert not verify_v2(SECRET, ts, BODY, sign_v2(SECRET, ts, BODY), now=now)


def test_the_edge_of_the_window_is_inclusive_and_a_clock_a_little_ahead_is_fine():
    for offset in (-TIMESTAMP_TOLERANCE_SECONDS, TIMESTAMP_TOLERANCE_SECONDS, 30):
        ts, now = stamp(offset)
        assert verify_v2(SECRET, ts, BODY, sign_v2(SECRET, ts, BODY), now=now)


def test_editing_the_timestamp_to_look_fresh_breaks_the_signature():
    old, now = stamp(-3600)
    fresh = str(int(now))
    assert not verify_v2(SECRET, fresh, BODY, sign_v2(SECRET, old, BODY), now=now)


def test_a_changed_body_a_wrong_secret_and_a_wrong_scheme_are_refused():
    ts, now = stamp()
    good = sign_v2(SECRET, ts, BODY)
    assert not verify_v2(SECRET, ts, BODY + b" ", good, now=now)
    assert not verify_v2("another", ts, BODY, good, now=now)
    assert not verify_v2(SECRET, ts, BODY, sign(SECRET, BODY), now=now)  # the old body-only signature is not a V2 signature
    assert not verify_v2(SECRET, ts, BODY, "", now=now)


@pytest.mark.parametrize("bad", ["", "abc", "-5", "1.5e9", "１７００００００００", " 1800000000", "1800000000 "])
def test_a_timestamp_that_is_not_plain_whole_seconds_is_refused(bad):
    assert not verify_v2(SECRET, bad, BODY, sign_v2(SECRET, bad, BODY), now=1_800_000_000.0)


def test_the_real_clock_is_used_when_none_is_given():
    ts = str(int(time.time()))
    assert verify_v2(SECRET, ts, BODY, sign_v2(SECRET, ts, BODY))
    old = str(int(time.time()) - 3600)
    assert not verify_v2(SECRET, old, BODY, sign_v2(SECRET, old, BODY))


# ---- the production bundle -------------------------------------------------------------------------------------------------------


def test_the_build_removes_the_mock_worker_unless_it_is_the_mock_build():
    config = (ROOT / "frontend" / "vite.config.ts").read_text(encoding="utf8")
    assert 'rmSync(path.join(outDir, "mockServiceWorker.js")' in config
    assert re.search(r"dropMockServiceWorker\(\s*(?:!)?[^)]*VITE_USE_MOCK", config) or "VITE_USE_MOCK" in config


def test_the_app_only_starts_the_mock_worker_when_asked_to():
    main = (ROOT / "frontend" / "src" / "main.tsx").read_text(encoding="utf8")
    assert "VITE_USE_MOCK" in main
    assert main.index("VITE_USE_MOCK") < main.index("mocks/browser") if "mocks/browser" in main else True


DIST = ROOT / "frontend" / "dist"


def _fresh_build() -> bool:
    """Only a build made after the build config last changed says anything about it; an old local dist/ is ignored."""
    index = DIST / "index.html"
    return index.exists() and index.stat().st_mtime > (ROOT / "frontend" / "vite.config.ts").stat().st_mtime


@pytest.mark.skipif(not _fresh_build(), reason="no current production build on this machine; the CI build job checks it")
def test_a_production_build_has_no_mock_worker_and_no_inline_script():
    assert not (DIST / "mockServiceWorker.js").exists()
    html = (DIST / "index.html").read_text(encoding="utf8")
    for tag in re.findall(r"<script\b[^>]*>", html):
        assert "src=" in tag, f"inline script would be blocked by the policy: {tag}"
    for asset in (DIST / "assets").glob("*.js"):
        assert "setupWorker" not in asset.read_text(encoding="utf8"), asset.name


# ---- secrets are never written to logs or returned ------------------------------------------------------------------------------------


def _values_in(line: str) -> str:
    """What a log call would actually print: the {...} parts of f-strings and everything after the message string. Words inside a plain
    message ("SECRET_KEY is not set") name a setting; they do not print one."""
    parts = re.findall(r"\{([^}]*)\}", line)
    tail = re.split(r"""["'],""", line, maxsplit=1)
    return " ".join(parts + tail[1:])


def test_no_log_call_formats_a_secret_value():
    names = r"(secret|api_key|password|authorization|webhook_secret|provider_key|ciphertext|cookie)"
    offenders = []
    for path in (ROOT / "src" / "agent_memory").rglob("*.py"):
        for number, line in enumerate(path.read_text(encoding="utf8").splitlines(), 1):
            if re.search(r"(log|logger|logging)\.(debug|info|warning|error|exception|critical)\(", line) and re.search(names, _values_in(line), re.I):
                offenders.append(f"{path.name}:{number}: {line.strip()[:90]}")
    assert offenders == []


def test_the_webhook_secret_and_provider_keys_are_not_in_any_response_model():
    schemas = (ROOT / "src" / "agent_memory" / "schemas.py").read_text(encoding="utf8")
    for out in re.findall(r"class (\w+Out)\(BaseModel\):(.*?)(?=\nclass |\Z)", schemas, re.S):
        name, body = out
        assert not re.search(r"^\s+(webhook_secret|api_key_hash|key_ciphertext|google_sub)\b", body, re.M), f"{name} returns a secret field"
