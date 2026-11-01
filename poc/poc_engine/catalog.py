"""Model catalog: which models exist, their prices, and whether they are ACTIVE, DEPRECATED or RETIRED.

The real system syncs this daily from a public model list (LiteLLM's) plus manual overrides.
The POC seeds four made-up models so nothing depends on a real provider:

  mini     cheap, very good on short inputs, weaker on long ones; being DEPRECATED soon
  pro      mid-price; its upgrade from pro-2026-03 to pro-2026-09 quietly got worse
  max      expensive, best quality, writes hidden "thinking" tokens (billed as output)
  classic  was good, but has been RETIRED by its provider
"""

from . import db

# model, version, status, shutdown, superseded_by, $/1M in, out, cache read, cache write
SEED = [
    ("mini", "mini-2026-06", "DEPRECATED", "2026-12-31", None, 0.20, 0.80, 0.02, 0.25),
    ("pro", "pro-2026-03", "DEPRECATED", "2026-11-30", "pro-2026-09", 1.00, 5.00, 0.10, 1.25),
    ("pro", "pro-2026-09", "ACTIVE", None, None, 1.00, 5.00, 0.10, 1.25),
    ("max", "max-2026-05", "ACTIVE", None, None, 5.00, 25.00, 0.50, 6.25),
    ("classic", "classic-2025-11", "RETIRED", "2026-09-30", None, 2.00, 10.00, 0.20, 2.50),
]


def seed() -> None:
    with db.conn() as c:
        c.executemany(
            "INSERT OR REPLACE INTO model_catalog VALUES (?,?,?,?,?,?,?,?,?)", SEED
        )


def entry(model: str, version: str) -> dict | None:
    return db.one(
        "SELECT * FROM model_catalog WHERE model=? AND model_version=?", (model, version)
    )


def latest_version(model: str) -> dict | None:
    """The newest version of a model that has not been superseded."""
    return db.one(
        "SELECT * FROM model_catalog WHERE model=? AND superseded_by IS NULL", (model,)
    )


def all_entries() -> list[dict]:
    return db.rows("SELECT * FROM model_catalog ORDER BY model, model_version")


def cost_usd(entry_row: dict, tokens_in: int, tokens_out: int,
             cache_read: int, cache_write: int) -> tuple[float, dict]:
    """Cost of one run from the usage the provider reported (tech plan 3.13).

    Returns the total and the four parts, so the trace can show the arithmetic.
    """
    parts = {
        "input": tokens_in * entry_row["price_in"] / 1e6,
        "output": tokens_out * entry_row["price_out"] / 1e6,
        "cache_read": cache_read * entry_row["price_cache_read"] / 1e6,
        "cache_write": cache_write * entry_row["price_cache_write"] / 1e6,
    }
    return round(sum(parts.values()), 8), {k: round(v, 8) for k, v in parts.items()}
