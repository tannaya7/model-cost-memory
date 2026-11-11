"""The corpus scripts run (no database or model needed)."""

import os
import subprocess
import sys
from pathlib import Path

from agent_memory.corpus import from_jsonl

ROOT = Path(__file__).resolve().parents[1]
ENV = {**os.environ, "PYTHONPATH": str(ROOT / "src")}


def run(script, *args, env=ENV, cwd=ROOT):
    return subprocess.run([sys.executable, str(ROOT / "scripts" / script), *args],
                          capture_output=True, text=True, env=env, cwd=cwd, timeout=60)


def test_build_corpus_writes_the_requested_number_of_invoices(tmp_path):
    out = tmp_path / "nested" / "invoices.jsonl"
    result = run("build_corpus.py", "--n", "12", "--seed", "3", "--out", str(out))
    assert result.returncode == 0, result.stderr
    invoices = from_jsonl(out.read_text(encoding="utf8"))
    assert len(invoices) == 12 and invoices[0].id == "inv-3-0000"


def test_run_corpus_needs_the_project_key(tmp_path):
    env = {k: v for k, v in ENV.items() if k != "MCM_API_KEY"}
    result = run("run_corpus.py", "--model", "m", env=env, cwd=tmp_path)
    assert result.returncode == 2 and "MCM_API_KEY" in result.stderr
