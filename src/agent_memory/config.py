"""Environment-driven settings. Every value comes from an environment variable; see .env.example.

Nothing here reads a file implicitly: `load_dotenv_file` is called only by scripts and the
Alembic environment, so tests and the API process see exactly the variables they were given.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit


def load_dotenv_file(path: str | os.PathLike[str] = ".env") -> None:
    """Load KEY=VALUE lines from a .env file into os.environ without overriding real variables."""
    p = Path(path)
    if not p.is_file():
        return
    for raw in p.read_text(encoding="utf8").splitlines():
        line = raw.split("#", 1)[0].strip() if not raw.lstrip().startswith("#") else ""
        if not line or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def normalize_database_url(url: str) -> str:
    """Turn any Postgres URL (for example the one Neon shows) into one SQLAlchemy+asyncpg accepts.

    - `postgres://` and `postgresql://` become `postgresql+asyncpg://`.
    - `sslmode=require` becomes `ssl=require`, the spelling asyncpg understands.
    - `channel_binding=...` is dropped, because asyncpg rejects it.
    """
    parts = urlsplit(url)
    scheme = parts.scheme
    if scheme in ("postgres", "postgresql"):
        scheme = "postgresql+asyncpg"
    query = []
    for key, value in parse_qsl(parts.query, keep_blank_values=True):
        if key == "channel_binding":
            continue
        if key == "sslmode":
            key = "ssl"
        query.append((key, value))
    return urlunsplit((scheme, parts.netloc, parts.path, urlencode(query), parts.fragment))


def _float(name: str, default: float) -> float:
    return float(os.environ.get(name, default))


def _int(name: str, default: int) -> int:
    return int(os.environ.get(name, default))


@dataclass(frozen=True)
class Settings:
    database_url: str = ""
    # Re-tests: a hard monthly ceiling per project (default for new projects).
    retest_monthly_cap_usd: float = 10.0
    # Recommendation: minimum weighted evidence before a verdict, and the tolerance rule: a cheaper
    # model qualifies when we are `confidence_level` sure it is at most `tolerance_points` worse.
    evidence_floor: float = 25.0
    tolerance_points: float = 0.03
    confidence_level: float = 0.95
    # Decay: stability S = importance x base_days x version_factor.
    decay_base_days: float = 30.0
    version_factor_superseded: float = 0.25
    archive_below_weight: float = 0.05
    # Public model price list used by the catalog sync.
    catalog_source_url: str = (
        "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json"
    )
    # Sync worker.
    outbox_batch_size: int = 32
    outbox_max_retries: int = 5
    outbox_stuck_minutes: int = 10
    outbox_done_retention_days: int = 7
    extras: dict[str, str] = field(default_factory=dict)

    @classmethod
    def from_env(cls) -> Settings:
        url = os.environ.get("DATABASE_URL", "")
        return cls(
            database_url=normalize_database_url(url) if url else "",
            retest_monthly_cap_usd=_float("RETEST_MONTHLY_CAP_USD", 10.0),
            evidence_floor=_float("EVIDENCE_FLOOR", 25.0),
            tolerance_points=_float("TOLERANCE_POINTS", 0.03),
            confidence_level=_float("CONFIDENCE_LEVEL", 0.95),
            decay_base_days=_float("DECAY_BASE_DAYS", 30.0),
            version_factor_superseded=_float("VERSION_FACTOR_SUPERSEDED", 0.25),
            archive_below_weight=_float("ARCHIVE_BELOW_WEIGHT", 0.05),
            catalog_source_url=os.environ.get("CATALOG_SOURCE_URL", cls.catalog_source_url),
            outbox_batch_size=_int("OUTBOX_BATCH_SIZE", 32),
            outbox_max_retries=_int("OUTBOX_MAX_RETRIES", 5),
            outbox_stuck_minutes=_int("OUTBOX_STUCK_MINUTES", 10),
            outbox_done_retention_days=_int("OUTBOX_DONE_RETENTION_DAYS", 7),
        )


def get_settings() -> Settings:
    return Settings.from_env()
