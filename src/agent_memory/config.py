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


def _bool(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in ("1", "true", "yes")


@dataclass(frozen=True)
class Settings:
    database_url: str = ""
    # Connections per process (API, worker, scheduler, and any script): pool + overflow. Four processes
    # at the defaults use at most 20, within what a small or free-tier Postgres allows.
    db_pool_size: int = 3
    db_max_overflow: int = 2
    # Re-tests: a hard monthly ceiling per project (default for new projects).
    retest_monthly_cap_usd: float = 10.0
    # Recommendation: minimum weighted evidence before a verdict, and the tolerance rule: a cheaper
    # model qualifies when we are `confidence_level` sure it is at most `tolerance_points` worse.
    evidence_floor: float = 25.0
    tolerance_points: float = 0.03
    confidence_level: float = 0.95
    # Advising a move to a cheaper model asks more: the verdict is recomputed every day, and each day is
    # another chance for a lucky streak to pass at 95%. Advice already given is kept at confidence_level,
    # so a model must clear the higher bar to be advised and fall below the usual one to be withdrawn.
    switch_confidence: float = 0.99
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
    # Regression detection. The sweep re-tests every day, so each check must be stricter than a one-off
    # test would be. A version change is flagged when p < alpha (tightened while the new version has
    # fewer than ref_runs runs) AND the drop is at least min_drop, with min_runs runs on each side.
    # A silent drop uses silent_alpha and the same min_drop. Chosen by simulation (reports/).
    regression_alpha: float = 0.005
    regression_ref_runs: int = 500
    regression_min_drop: float = 0.03
    regression_min_runs: int = 30
    silent_alpha: float = 0.001
    # Re-tests: provider calls at once per re-test (low, because a free key shares its quota with
    # the customer's production traffic), and the default number of prompts replayed.
    retest_concurrency: int = 2
    retest_default_sample: int = 50
    retest_auto_budget_usd: float = 1.0  # budget of a re-test the system starts on its own
    # Secret for encrypting stored provider keys and signing session cookies. Required in production.
    secret_key: str = ""
    # Google sign-in (Week 11). Without a client id, sign-in is off and the project key is used.
    google_client_id: str = ""
    google_client_secret: str = ""
    public_url: str = "http://localhost:5174"  # where the web app is served; the OAuth redirect comes back here
    dev_login: bool = False  # local development only: sign in as any email without Google
    # A project anyone may read without a key (the public demo); empty means none.
    demo_project_id: str = ""
    # Optional two-sentence recommendation summary (Claude). Off unless a key is set. Written once per
    # verdict and stored; at most summary_daily_limit calls a day across the server.
    summary_model: str = "claude-haiku-5-5"
    summary_daily_limit: int = 200
    # Outbound URLs (webhooks, re-test endpoints) must be public addresses unless this is on (urls.py).
    allow_private_urls: bool = False
    # Abuse limits (ratelimit.py). Requests per minute per project key, and per IP for requests without
    # one; runs a project may record per UTC day; live-stream connections per IP and in all.
    rate_limit_key_per_minute: int = 1200
    rate_limit_ip_per_minute: int = 120
    runs_per_day_per_project: int = 200_000
    streams_per_ip: int = 3
    streams_total: int = 200
    extras: dict[str, str] = field(default_factory=dict)

    @classmethod
    def from_env(cls) -> Settings:
        url = os.environ.get("DATABASE_URL", "")
        return cls(
            database_url=normalize_database_url(url) if url else "",
            db_pool_size=_int("DB_POOL_SIZE", 3),
            db_max_overflow=_int("DB_MAX_OVERFLOW", 2),
            retest_monthly_cap_usd=_float("RETEST_MONTHLY_CAP_USD", 10.0),
            evidence_floor=_float("EVIDENCE_FLOOR", 25.0),
            tolerance_points=_float("TOLERANCE_POINTS", 0.03),
            confidence_level=_float("CONFIDENCE_LEVEL", 0.95),
            switch_confidence=_float("SWITCH_CONFIDENCE", 0.99),
            decay_base_days=_float("DECAY_BASE_DAYS", 30.0),
            version_factor_superseded=_float("VERSION_FACTOR_SUPERSEDED", 0.25),
            archive_below_weight=_float("ARCHIVE_BELOW_WEIGHT", 0.05),
            catalog_source_url=os.environ.get("CATALOG_SOURCE_URL", cls.catalog_source_url),
            outbox_batch_size=_int("OUTBOX_BATCH_SIZE", 32),
            outbox_max_retries=_int("OUTBOX_MAX_RETRIES", 5),
            outbox_stuck_minutes=_int("OUTBOX_STUCK_MINUTES", 10),
            outbox_done_retention_days=_int("OUTBOX_DONE_RETENTION_DAYS", 7),
            regression_alpha=_float("REGRESSION_ALPHA", 0.005),
            regression_ref_runs=_int("REGRESSION_REF_RUNS", 500),
            regression_min_drop=_float("REGRESSION_MIN_DROP", 0.03),
            regression_min_runs=_int("REGRESSION_MIN_RUNS", 30),
            silent_alpha=_float("SILENT_ALPHA", 0.001),
            retest_concurrency=_int("RETEST_CONCURRENCY", 2),
            retest_default_sample=_int("RETEST_DEFAULT_SAMPLE", 50),
            retest_auto_budget_usd=_float("RETEST_AUTO_BUDGET_USD", 1.0),
            secret_key=os.environ.get("SECRET_KEY", ""),
            google_client_id=os.environ.get("GOOGLE_CLIENT_ID", ""),
            google_client_secret=os.environ.get("GOOGLE_CLIENT_SECRET", ""),
            public_url=os.environ.get("PUBLIC_URL", cls.public_url).rstrip("/"),
            dev_login=_bool("DEV_LOGIN"),
            demo_project_id=os.environ.get("DEMO_PROJECT_ID", ""),
            summary_model=os.environ.get("SUMMARY_MODEL", cls.summary_model),
            summary_daily_limit=_int("SUMMARY_DAILY_LIMIT", 200),
            allow_private_urls=_bool("ALLOW_PRIVATE_URLS"),
            rate_limit_key_per_minute=_int("RATE_LIMIT_KEY_PER_MINUTE", 1200),
            rate_limit_ip_per_minute=_int("RATE_LIMIT_IP_PER_MINUTE", 120),
            runs_per_day_per_project=_int("RUNS_PER_DAY_PER_PROJECT", 200_000),
            streams_per_ip=_int("STREAMS_PER_IP", 3),
            streams_total=_int("STREAMS_TOTAL", 200),
        )

    @property
    def is_public(self) -> bool:
        """Served over https: a real deployment, not a laptop."""
        return self.public_url.startswith("https://")


MIN_SECRET_KEY_LENGTH = 32


class UnsafeSettings(RuntimeError):
    """The settings would run a public server unsafely; the process refuses to start."""


def startup_problems(settings: Settings) -> list[str]:
    """What makes these settings unsafe to serve with. Empty when they are fine.

    A SECRET_KEY, when set, must be long enough to resist guessing (it signs sign-in cookies and
    protects stored provider keys). On a public (https) server it is required, and the development
    switches that skip sign-in or the private-address check are refused."""
    problems = []
    if settings.secret_key and len(settings.secret_key) < MIN_SECRET_KEY_LENGTH:
        problems.append(f"SECRET_KEY must be at least {MIN_SECRET_KEY_LENGTH} characters "
                        "(generate one with: python -c \"import secrets; print(secrets.token_urlsafe(48))\")")
    if settings.is_public:
        if not settings.secret_key:
            problems.append("SECRET_KEY is required on a server whose PUBLIC_URL is https")
        if settings.dev_login:
            problems.append("DEV_LOGIN lets anyone sign in as any email; it is refused when PUBLIC_URL is https")
        if settings.allow_private_urls:
            problems.append("ALLOW_PRIVATE_URLS lets projects make this server call its own network; "
                            "it is refused when PUBLIC_URL is https")
    return problems


def check_startup(settings: Settings | None = None) -> None:
    """Raise UnsafeSettings listing every problem (the API and the scheduler call this first)."""
    problems = startup_problems(settings or get_settings())
    if problems:
        raise UnsafeSettings("Refusing to start: " + "; ".join(problems))


def get_settings() -> Settings:
    return Settings.from_env()
