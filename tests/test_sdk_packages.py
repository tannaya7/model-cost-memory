"""The standalone recorders in sdk/: they are in step with the real recorder, they pass their own tests without the server installed,
the JavaScript one reads usage like the Python one, and neither can be published by accident. No network is used."""

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SDK = ROOT / "sdk"


def run(args, cwd=ROOT, env=None, timeout=240):
    return subprocess.run(args, cwd=cwd, env=env, capture_output=True, text=True, timeout=timeout)


def test_the_small_python_package_is_exactly_what_the_real_recorder_makes():
    got = run([sys.executable, "scripts/build_recorder_package.py", "--check"])
    assert got.returncode == 0, got.stdout + got.stderr


def test_the_shared_usage_cases_are_in_step_with_the_python_reader():
    got = run([sys.executable, "scripts/build_usage_fixtures.py", "--check"])
    assert got.returncode == 0, got.stdout + got.stderr


def test_the_small_python_package_works_without_the_server_installed_and_passes_the_recorders_own_tests():
    env = {**os.environ, "PYTHONPATH": str(SDK / "python" / "src")}
    imported = run([sys.executable, "-c", "import sys, mcm_recorder; assert 'agent_memory' not in sys.modules; print('independent')"], env=env)
    assert imported.returncode == 0 and "independent" in imported.stdout, imported.stderr
    tests = run([sys.executable, "-m", "pytest", "tests", "-q", "-p", "no:cacheprovider"], cwd=SDK / "python", env=env)
    assert tests.returncode == 0, tests.stdout[-1500:] + tests.stderr[-500:]


def test_the_python_package_imports_only_httpx_from_outside_the_standard_library():
    allowed = {"httpx"}
    found = set()
    for path in (SDK / "python" / "src" / "mcm_recorder").glob("*.py"):
        for line in path.read_text(encoding="utf8").splitlines():
            if line.startswith(("import ", "from ")) and not line.startswith("from ."):
                top = line.split()[1].split(".")[0]
                if top not in sys.stdlib_module_names and top != "__future__":
                    found.add(top)
    assert found <= allowed, found


@pytest.mark.skipif(shutil.which("node") is None, reason="Node is not installed")
def test_the_javascript_recorder_passes_its_tests_including_the_python_parity_cases():
    got = run(["node", "--test"], cwd=SDK / "js")
    assert got.returncode == 0, got.stdout[-2000:] + got.stderr[-500:]
    assert "fail 0" in got.stdout


def test_the_parity_cases_cover_every_provider_shape_the_server_knows():
    cases = json.loads((SDK / "fixtures" / "usage_cases.json").read_text(encoding="utf8"))
    shapes = {c["expected"]["shape"] for c in cases}
    assert {"anthropic_messages", "openai_responses", "openai_chat", "deepseek_chat", "gemini", "none"} <= shapes
    assert len(cases) >= 15


def test_neither_package_can_be_published_by_accident():
    pyproject = (SDK / "python" / "pyproject.toml").read_text(encoding="utf8")
    assert "Private :: Do Not Upload" in pyproject
    package = json.loads((SDK / "js" / "package.json").read_text(encoding="utf8"))
    assert package["private"] is True and "publishConfig" not in package
    assert "publish" not in package.get("scripts", {})


def test_the_javascript_recorder_has_no_dependencies():
    package = json.loads((SDK / "js" / "package.json").read_text(encoding="utf8"))
    assert not package.get("dependencies") and not package.get("devDependencies")
    imports = [line for line in (SDK / "js" / "src" / "index.js").read_text(encoding="utf8").splitlines() if line.startswith("import ")]
    assert imports == ['import { randomUUID } from "node:crypto";']
