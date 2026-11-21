"""Build the small standalone Python recorder package from the product's own recorder.

    python scripts/build_recorder_package.py            # writes sdk/python/
    python scripts/build_recorder_package.py --check    # fails if sdk/python/ is out of date

Why: `agent_memory` is the whole server. A customer's app only needs the recorder, which uses three plain files and one
dependency (httpx). This copies exactly those files, so the small package can never drift from the real recorder, and
copies the recorder's own tests so they run against the small package too.

Nothing here publishes anything. The package is marked private (the classifier `Private :: Do Not Upload` makes PyPI refuse
an upload) until the owner chooses its public name and licence.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src" / "agent_memory"
OUT = ROOT / "sdk" / "python"
FILES = ("recorder.py", "privacy.py", "usage_ledger.py")
PACKAGE = "mcm_recorder"  # the working name; the owner decides the public one

PYPROJECT = '''[build-system]
requires = ["setuptools>=68"]
build-backend = "setuptools.build_meta"

[project]
name = "mcm-recorder"
version = "0.0.1"
description = "Sends a copy of each AI call to a Model & Cost Memory dashboard. Never raises, never waits for the network."
readme = "README.md"
requires-python = ">=3.9"
dependencies = ["httpx"]
classifiers = [
    "Private :: Do Not Upload",  # until the owner chooses the public name and licence: PyPI refuses this
]

[tool.setuptools.packages.find]
where = ["src"]
'''

README = '''# mcm-recorder (working name, not published)

The small recorder for apps that use Model & Cost Memory. It is generated from the product's own recorder by
`scripts/build_recorder_package.py`, so do not edit it by hand.

```python
from mcm_recorder import RunRecorder, provider_for

with RunRecorder(job="read-invoices", provider=provider_for(client.base_url)) as rec:
    response = client.chat.completions.create(model="my-model", messages=[...])
    rec.capture(response, prompt=prompt, model="my-model")
```

**Optional: name the feature.** Pass `feature="support_summary"` (Python) or `feature: "support_summary"` (JavaScript) with a call and the
Cost analysis page shows what each of your features cost. It is entirely optional, and you choose whether to add it: Model & Cost Memory
never changes your code. The label is your own word. It is not verified, it is not an identity, and it is not an invoice-grade chargeback
record. Letters, digits, spaces and `. _ -` only, at most 100 characters; anything else is turned into an underscore. Calls without a label
are shown as "Unlabelled". Nothing is ever guessed from your prompts to fill it in.

Set `MCM_API_KEY` (your project key) and `MCM_API_URL` (the address of your Model & Cost Memory server).
It sends in a background thread, adds well under 5 ms to a call, and never raises into your app.

**Not published.** The classifier `Private :: Do Not Upload` stops an accidental upload. The public name and the licence are the
owner's decisions. Until then the Connect guide gives developers a small copy-paste function with nothing to install.
'''

INIT = '''"""The Model & Cost Memory recorder. Generated from the product's recorder: do not edit by hand."""

from .recorder import RunRecorder, Sender, provider_for, read_response

__all__ = ["RunRecorder", "Sender", "provider_for", "read_response"]
'''


def _functions(source: str) -> list[str]:
    """Split a test module into its header and one chunk per test function."""
    return re.split(r"(?m)^(?=(?:@pytest\.|async def test_|def test_))", source)


def build_tests() -> str:
    source = (ROOT / "tests" / "test_recorder.py").read_text(encoding="utf8")
    chunks = _functions(source)
    kept, buffer = [], ""
    for chunk in chunks:
        # decorators come as their own chunk and belong to the function that follows
        if chunk.startswith("@pytest."):
            buffer += chunk
            continue
        chunk = buffer + chunk
        buffer = ""
        if "agent_memory.insights" in chunk:  # needs the server side: not part of the small package
            continue
        kept.append(chunk)
    text = "".join(kept)
    text = text.replace("from agent_memory.recorder import", f"from {PACKAGE}.recorder import")
    return text


def render() -> dict[Path, str]:
    files: dict[Path, str] = {
        OUT / "pyproject.toml": PYPROJECT,
        OUT / "README.md": README,
        OUT / "src" / PACKAGE / "__init__.py": INIT,
        OUT / "tests" / "test_recorder.py": build_tests(),
    }
    for name in FILES:
        text = (SRC / name).read_text(encoding="utf8")
        text = text.replace("from agent_memory.recorder import", f"from {PACKAGE} import").replace('"agent_memory.recorder"', f'"{PACKAGE}.recorder"')
        files[OUT / "src" / PACKAGE / name] = text
    return files


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true", help="fail if sdk/python is out of date")
    args = parser.parse_args(argv)
    files = render()
    if args.check:
        stale = [str(p.relative_to(ROOT)) for p, text in files.items() if not p.exists() or p.read_text(encoding="utf8") != text]
        if stale:
            print("sdk/python is out of date; run scripts/build_recorder_package.py:\n  " + "\n  ".join(stale))
            return 1
        return 0
    for path, text in files.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf8", newline="\n")
    print(f"wrote {len(files)} files under {OUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
