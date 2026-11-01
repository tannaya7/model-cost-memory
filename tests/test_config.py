"""Settings and database URL handling (no database needed)."""

from agent_memory.config import Settings, load_dotenv_file, normalize_database_url


def test_neon_url_becomes_asyncpg_url():
    neon = "postgresql://user:pw@ep-cool-123.eu-central-1.aws.neon.tech/db?sslmode=require&channel_binding=require"
    out = normalize_database_url(neon)
    assert out.startswith("postgresql+asyncpg://user:pw@ep-cool-123")
    assert "ssl=require" in out
    assert "sslmode" not in out
    assert "channel_binding" not in out


def test_postgres_scheme_and_already_normalised_urls():
    assert normalize_database_url("postgres://u:p@h/d").startswith("postgresql+asyncpg://")
    ready = "postgresql+asyncpg://u:p@h:5432/d"
    assert normalize_database_url(ready) == ready


def test_settings_defaults_and_overrides(monkeypatch):
    monkeypatch.delenv("RETEST_MONTHLY_CAP_USD", raising=False)
    monkeypatch.setenv("DATABASE_URL", "postgres://u:p@h/d")
    monkeypatch.setenv("EVIDENCE_FLOOR", "40")
    s = Settings.from_env()
    assert s.database_url.startswith("postgresql+asyncpg://")
    assert s.retest_monthly_cap_usd == 10.0
    assert s.evidence_floor == 40.0


def test_dotenv_does_not_override_real_variables(tmp_path, monkeypatch):
    env = tmp_path / ".env"
    env.write_text("# comment\nFOO_TEST_A=from_file\nFOO_TEST_B=\"quoted\"  # trailing\n", encoding="utf8")
    monkeypatch.setenv("FOO_TEST_A", "from_env")
    monkeypatch.delenv("FOO_TEST_B", raising=False)
    load_dotenv_file(env)
    import os

    assert os.environ["FOO_TEST_A"] == "from_env"
    assert os.environ["FOO_TEST_B"] == "quoted"
