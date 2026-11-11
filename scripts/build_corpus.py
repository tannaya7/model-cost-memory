"""Write the invoice-extraction corpus to a JSONL file (one invoice and its exact answer per line).

  python scripts/build_corpus.py                       # 200 invoices to corpus/invoices.jsonl
  python scripts/build_corpus.py --n 300 --seed 11 --out corpus/big.jsonl
"""

from __future__ import annotations

import argparse
from pathlib import Path

from agent_memory.corpus import generate_invoices, to_jsonl

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--n", type=int, default=200, help="number of invoices (default 200)")
    parser.add_argument("--seed", type=int, default=7, help="the same seed always gives the same corpus")
    parser.add_argument("--out", default="corpus/invoices.jsonl")
    args = parser.parse_args()
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(to_jsonl(generate_invoices(args.n, args.seed)), encoding="utf8", newline="\n")
    print(f"wrote {args.n} invoices to {out}")
