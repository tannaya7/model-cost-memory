"""Every dependency is pinned in requirements-lock.txt, and the image and CI install from it."""

import re
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def _name(requirement: str) -> str:
    return re.split(r"[\s\[<>=!~;]", requirement.strip(), maxsplit=1)[0].lower().replace("_", "-")


def _locked() -> dict[str, str]:
    pins = {}
    for line in (ROOT / "requirements-lock.txt").read_text(encoding="utf8").splitlines():
        if "==" in line and not line.lstrip().startswith("#"):
            name, version = line.split(";")[0].strip().split("==")
            pins[name.lower().replace("_", "-")] = version
    return pins


def test_every_declared_dependency_has_an_exact_version_in_the_lock():
    project = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf8"))["project"]
    declared = list(project["dependencies"])
    for extra in project["optional-dependencies"].values():
        declared += extra
    missing = sorted({_name(r) for r in declared} - set(_locked()))
    assert not missing, f"add these to requirements-lock.txt (see its header for the command): {missing}"


def test_the_image_and_ci_install_from_the_lock():
    assert "-c requirements-lock.txt" in (ROOT / "Dockerfile").read_text(encoding="utf8")
    assert "-c requirements-lock.txt" in (ROOT / ".github" / "workflows" / "ci.yml").read_text(encoding="utf8")
