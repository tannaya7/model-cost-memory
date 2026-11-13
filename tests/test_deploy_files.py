"""The server files are at least well-formed (a real deployment is a Week 7 task)."""

import shutil
import subprocess
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[1]
COMPOSE = yaml.safe_load((ROOT / "docker-compose.yml").read_text(encoding="utf8"))


def test_every_service_is_defined_and_only_caddy_is_public():
    assert set(COMPOSE["services"]) == {"db", "api", "worker", "scheduler", "caddy"}
    for name, svc in COMPOSE["services"].items():
        for port in svc.get("ports", []):
            public = not port.startswith("127.0.0.1:")
            assert public == (name == "caddy"), f"{name} exposes {port}"


def test_services_wait_for_a_healthy_database_and_run_non_default_commands():
    for name in ("api", "worker", "scheduler"):
        assert COMPOSE["services"][name]["depends_on"]["db"]["condition"] == "service_healthy"
    assert "healthcheck" in COMPOSE["services"]["db"]
    assert COMPOSE["services"]["worker"]["build"]["args"]["INSTALL_TARGET"] == ".[embeddings]"


def test_the_database_password_comes_from_the_environment_and_has_no_default():
    for value in (COMPOSE["services"]["db"]["environment"]["POSTGRES_PASSWORD"], COMPOSE["x-app-env"]["DATABASE_URL"]):
        assert "${POSTGRES_PASSWORD:?" in value  # compose refuses to start without one
        assert ":-" not in value  # never a fallback password


def test_caddy_proxies_the_api_without_buffering_and_serves_the_app():
    caddyfile = (ROOT / "deploy" / "Caddyfile").read_text(encoding="utf8")
    assert "flush_interval -1" in caddyfile  # Server-Sent Events must not be buffered
    assert "reverse_proxy api:8000" in caddyfile and "try_files {path} /index.html" in caddyfile
    assert "{$DOMAIN}" in caddyfile


def test_every_health_check_reaches_the_api_not_the_web_app():
    """/healthz/scheduler must be proxied: served as the web app it would answer 200 with HTML, so an uptime
    monitor would never see a stopped scheduler."""
    caddyfile = (ROOT / "deploy" / "Caddyfile").read_text(encoding="utf8")
    matcher = next(line for line in caddyfile.splitlines() if line.strip().startswith("@api path"))
    assert "/healthz/*" in matcher.split() and "/healthz" in matcher.split()


def test_caddy_stops_other_sites_framing_or_scripting_the_app():
    caddyfile = (ROOT / "deploy" / "Caddyfile").read_text(encoding="utf8")
    policy = next(line for line in caddyfile.splitlines() if "Content-Security-Policy" in line)
    assert "frame-ancestors 'none'" in policy and "script-src 'self';" in policy and "object-src 'none'" in policy
    assert "unsafe-inline" not in policy.split("script-src", 1)[1].split(";", 1)[0]  # no inline scripts
    assert 'X-Frame-Options "DENY"' in caddyfile


def test_the_built_app_loads_nothing_the_policy_would_block():
    index = (ROOT / "frontend" / "index.html").read_text(encoding="utf8")
    assert "http://" not in index and "https://" not in index  # every script and style is served from this origin


@pytest.mark.skipif(shutil.which("bash") is None, reason="bash is needed to check the scripts")
@pytest.mark.parametrize("script", ["backup.sh", "restore.sh", "deploy.sh"])
def test_deploy_scripts_parse_and_fail_on_error(script):
    path = ROOT / "deploy" / script
    # A relative path with forward slashes: every bash reads it (WSL's cannot read a C:\ path).
    assert subprocess.run(["bash", "-n", f"deploy/{script}"], cwd=ROOT, capture_output=True).returncode == 0
    assert "set -euo pipefail" in path.read_text(encoding="utf8")


def test_the_image_carries_what_the_server_needs_to_migrate():
    dockerfile = (ROOT / "Dockerfile").read_text(encoding="utf8")
    for needed in ("alembic.ini", "migrations", "scripts", "USER app"):
        assert needed in dockerfile


FAKES = """
docker() { [ "${FAKE_DUMP:-}" = empty ] || printf 'PGDMP fake dump'; }
rclone() { echo "rclone $*" >> calls.log; }
curl() { echo "curl $*" >> calls.log; }
"""


def _backup(tmp_path, env_file: str, **env):
    """Run deploy/backup.sh in a scratch folder, with docker, rclone and curl replaced by stand-ins."""
    import os

    (tmp_path / "backup.sh").write_bytes((ROOT / "deploy" / "backup.sh").read_bytes())
    (tmp_path / "fakes.sh").write_text(FAKES, encoding="utf8", newline="\n")
    (tmp_path / ".env").write_text(env_file, encoding="utf8", newline="\n")
    result = subprocess.run(["bash", "backup.sh"], cwd=tmp_path, capture_output=True, text=True,
                            env={**os.environ, "BASH_ENV": "fakes.sh", **env})
    calls = (tmp_path / "calls.log").read_text(encoding="utf8") if (tmp_path / "calls.log").exists() else ""
    return result, calls


@pytest.mark.skipif(shutil.which("bash") is None, reason="bash is needed to run the script")
def test_a_backup_is_copied_off_the_machine_and_reports_success(tmp_path):
    result, calls = _backup(tmp_path, "BACKUP_REMOTE=offsite:mcm   # an rclone crypt remote\n"
                                      "BACKUP_PING_URL=https://hc.example/abc\n")
    assert result.returncode == 0, result.stderr
    assert list((tmp_path / "backups").glob("mcm-*.dump"))
    assert "rclone copy backups/mcm-" in calls and "offsite:mcm" in calls
    assert "rclone delete offsite:mcm --min-age 30d" in calls
    assert "https://hc.example/abc" in calls and "/fail" not in calls


@pytest.mark.skipif(shutil.which("bash") is None, reason="bash is needed to run the script")
def test_a_failed_backup_pings_fail_and_copies_nothing(tmp_path):
    result, calls = _backup(tmp_path, "BACKUP_REMOTE=offsite:mcm\nBACKUP_PING_URL=https://hc.example/abc\n",
                            FAKE_DUMP="empty")
    assert result.returncode != 0 and "empty" in result.stderr
    assert "rclone" not in calls and "https://hc.example/abc/fail" in calls


@pytest.mark.skipif(shutil.which("bash") is None, reason="bash is needed to run the script")
def test_without_a_remote_the_backup_warns_that_it_is_only_local(tmp_path):
    result, calls = _backup(tmp_path, "POSTGRES_PASSWORD=x\n")
    assert result.returncode == 0 and "only on this machine" in result.stderr and calls == ""
