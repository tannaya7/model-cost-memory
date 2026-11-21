"""Shared test cases that keep the JavaScript recorder reading usage exactly like the Python one.

    python scripts/build_usage_fixtures.py          # writes sdk/fixtures/usage_cases.json
    python scripts/build_usage_fixtures.py --check  # fails if it is out of date

Each case is a provider usage block (plain JSON) and what the Python reader makes of it. The JavaScript test reads the same file,
so a change to either reader that makes them disagree fails a test. The Python reader is the reference.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from agent_memory.usage_ledger import legacy_columns, read_usage  # noqa: E402

OUT = ROOT / "sdk" / "fixtures" / "usage_cases.json"

CASES: list[tuple[str, object]] = [
    ("anthropic basic", {"input_tokens": 800, "output_tokens": 120}),
    ("anthropic with cache read and write", {"input_tokens": 800, "output_tokens": 120, "cache_read_input_tokens": 300, "cache_creation_input_tokens": 50}),
    ("anthropic one hour cache split", {"input_tokens": 10, "output_tokens": 5, "cache_creation_input_tokens": 100, "cache_creation": {"ephemeral_1h_input_tokens": 60, "ephemeral_5m_input_tokens": 40}}),
    ("anthropic split without a total", {"input_tokens": 10, "output_tokens": 5, "cache_creation": {"ephemeral_1h_input_tokens": 60, "ephemeral_5m_input_tokens": 40}}),
    ("openai chat basic", {"prompt_tokens": 1000, "completion_tokens": 90, "total_tokens": 1090}),
    ("openai chat with cached tokens", {"prompt_tokens": 1000, "completion_tokens": 90, "prompt_tokens_details": {"cached_tokens": 400}}),
    ("openai chat with cache writes and reasoning", {"prompt_tokens": 1000, "completion_tokens": 90, "prompt_tokens_details": {"cached_tokens": 400, "cache_write_tokens": 100}, "completion_tokens_details": {"reasoning_tokens": 30}}),
    ("openai chat cached more than prompt", {"prompt_tokens": 100, "completion_tokens": 9, "prompt_tokens_details": {"cached_tokens": 400}}),
    ("openai responses", {"input_tokens": 500, "input_tokens_details": {"cached_tokens": 200}, "output_tokens": 70, "output_tokens_details": {"reasoning_tokens": 20}, "total_tokens": 570}),
    ("openai responses without cache write field", {"input_tokens": 500, "input_tokens_details": {"cached_tokens": 100}, "output_tokens": 70}),
    ("deepseek hit and miss", {"prompt_tokens": 300, "completion_tokens": 40, "prompt_cache_hit_tokens": 200, "prompt_cache_miss_tokens": 100}),
    ("deepseek hit only", {"prompt_tokens": 300, "completion_tokens": 40, "prompt_cache_hit_tokens": 200}),
    ("gemini rest camelCase", {"promptTokenCount": 900, "candidatesTokenCount": 60, "cachedContentTokenCount": 400, "thoughtsTokenCount": 25, "toolUsePromptTokenCount": 12, "totalTokenCount": 997}),
    ("gemini sdk snake_case", {"prompt_token_count": 900, "candidates_token_count": 60, "cached_content_token_count": 400}),
    ("zero is a real value", {"prompt_tokens": 0, "completion_tokens": 0}),
    ("negative and boolean counts are unknown", {"prompt_tokens": -5, "completion_tokens": True}),
    ("absurdly large count is unknown", {"prompt_tokens": 9_999_999_999, "completion_tokens": 3}),
    ("unrecognised shape", {"something_else": 5}),
    ("empty block", {}),
    ("no usage block", None),
]


def render() -> str:
    out = []
    for name, usage in CASES:
        ledger = read_usage(usage)
        fields = ledger["fields"]
        out.append({
            "name": name, "usage": usage,
            "expected": {"shape": ledger["shape"], "columns": legacy_columns(ledger),
                         "reasoning": fields["reasoning"], "tool_use_input": fields["tool_use_input"]},
        })
    return json.dumps(out, indent=1, sort_keys=True) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args(argv)
    text = render()
    if args.check:
        if not OUT.exists() or OUT.read_text(encoding="utf8") != text:
            print("sdk/fixtures/usage_cases.json is out of date; run scripts/build_usage_fixtures.py")
            return 1
        return 0
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(text, encoding="utf8", newline="\n")
    print(f"wrote {len(CASES)} cases to {OUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
