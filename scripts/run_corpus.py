"""Send the corpus to a model and record every call, exactly as an application would.

Works with any OpenAI-compatible endpoint, which includes local Ollama (free) and most free tiers:

  # local Ollama model, free
  python scripts/run_corpus.py --model llama3.2 --limit 50

  # Gemini's free tier (the provider, and so the price, is worked out from the address)
  python scripts/run_corpus.py --model gemini-2.5-flash-lite       --base-url https://generativelanguage.googleapis.com/v1beta/openai/ --api-key-env GEMINI_API_KEY

  # any other OpenAI-compatible endpoint: name the provider as the price list does
  python scripts/run_corpus.py --model some-model --base-url https://api.example.com/v1 --api-key-env EXAMPLE_KEY       --provider example

Needs MCM_API_KEY (the project key) and, unless --api-url is given, an API running on 127.0.0.1:8000.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

from openai import OpenAI

from agent_memory.config import load_dotenv_file
from agent_memory.corpus import ensure_job, from_jsonl, generate_invoices, replay
from agent_memory.recorder import Sender, provider_for


def main() -> int:
    load_dotenv_file()
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--model", required=True, help="model name as the endpoint knows it")
    parser.add_argument("--base-url", default="http://localhost:11434/v1", help="OpenAI-compatible endpoint (default: local Ollama)")
    parser.add_argument("--api-key-env", default="", help="environment variable holding the model provider key (not needed for Ollama)")
    parser.add_argument("--api-url", default=os.environ.get("MCM_API_URL", "http://127.0.0.1:8000"))
    parser.add_argument("--corpus", default="corpus/invoices.jsonl", help="JSONL from build_corpus.py (generated in memory if missing)")
    parser.add_argument("--limit", type=int, default=0, help="only the first N invoices")
    parser.add_argument("--prompt-version", default="v1")
    parser.add_argument("--provider", default="", help="who serves the model, for its price (default: from --base-url)")
    args = parser.parse_args()

    project_key = os.environ.get("MCM_API_KEY", "")
    if not project_key:
        print("Set MCM_API_KEY to your project key first (see scripts/create_project.py).", file=sys.stderr)
        return 2
    path = Path(args.corpus)
    invoices = from_jsonl(path.read_text(encoding="utf8")) if path.is_file() else generate_invoices(200)
    if args.limit:
        invoices = invoices[: args.limit]

    created = ensure_job(args.api_url, project_key)
    print("created the invoice-extract job" if created else "the invoice-extract job already exists")

    provider_key = os.environ.get(args.api_key_env, "") if args.api_key_env else "ollama"
    client = OpenAI(base_url=args.base_url, api_key=provider_key or "none")
    sender = Sender(args.api_url, project_key)

    def complete(prompt: str):
        return client.chat.completions.create(
            model=args.model, messages=[{"role": "user", "content": prompt}], temperature=0
        )

    provider = args.provider or provider_for(args.base_url)
    if provider is None:
        print("Unknown endpoint: pass --provider so the runs are priced at that provider's rate", file=sys.stderr)
    done = replay(invoices, complete, model=args.model, sender=sender, prompt_version=args.prompt_version,
                  provider=provider)
    sender.flush(30)
    print(f"sent {done} calls to {args.model}: {sender.sent} recorded, {sender.dropped} dropped")
    sender.close()
    return 0 if sender.dropped == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
