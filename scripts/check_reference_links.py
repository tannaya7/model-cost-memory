"""Check that every official link the app shows still opens: the makers' docs, pricing and deprecation pages, and the
per-model pages the Compare screen links to.

Opt-in and read-only. It is not part of the test suite (the suite never uses the network). It sends one polite GET per address
to a maker's public documentation page, with a pause between requests, and sends nothing about any project or person.

    python scripts/check_reference_links.py            # exit 1 if any address does not answer 200
    python scripts/check_reference_links.py --list     # only print the addresses

A page that moves shows up here first, and the fix is to update the table it came from
(src/agent_memory/catalog/official.py or frontend/src/screens/compare/profile/modelLinks.ts).
"""

from __future__ import annotations

import re
import sys
import time
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from agent_memory.catalog.official import official_links  # noqa: E402

LINKS_TS = ROOT / "frontend" / "src" / "screens" / "compare" / "profile" / "modelLinks.ts"
HOSTS = {"platform.claude.com", "aistudio.google.com", "developers.openai.com"}
PAUSE_SECONDS = 0.4


def per_model_pages() -> list[str]:
    """The per-model pages modelLinks.ts says exist, rebuilt the way it builds them."""
    text = LINKS_TS.read_text(encoding="utf8")

    def ids(name: str) -> list[str]:
        block = re.search(rf"const {name} = new Set\(\[(.*?)\]\)", text, re.S)
        return re.findall(r'"([^"]+)"', block.group(1)) if block else []

    return (
        [f"https://platform.claude.com/docs/en/models/{s}/overview" for s in ids("ANTHROPIC_PAGES")]
        + [f"https://aistudio.google.com/docs/models/{i}" for i in ids("GOOGLE_PAGES")]
        + [f"https://developers.openai.com/api/docs/models/{i}" for i in ids("OPENAI_PAGES")]
    )


def main() -> int:
    urls = list(dict.fromkeys(official_links() + per_model_pages()))
    bad_hosts = [u for u in urls if not u.startswith("https://") or u.split("/")[2] not in HOSTS]
    if bad_hosts:
        print("NOT A MAKER'S OWN HTTPS ADDRESS:", *bad_hosts, sep="\n  ")
        return 1
    if "--list" in sys.argv:
        print(*urls, sep="\n")
        return 0
    failures = 0
    with httpx.Client(timeout=25.0, follow_redirects=True, headers={"User-Agent": "model-cost-memory-link-check", "Accept": "text/markdown, text/html"}) as client:
        for url in urls:
            try:
                code = client.get(url).status_code
            except httpx.HTTPError as exc:
                code = f"{type(exc).__name__}"
            ok = code == 200
            failures += not ok
            print(f"{'ok  ' if ok else 'FAIL'} {code} {url}")
            time.sleep(PAUSE_SECONDS)
    print(f"\n{len(urls) - failures} of {len(urls)} addresses answered 200")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
