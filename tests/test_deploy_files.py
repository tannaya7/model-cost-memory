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


def test_the_database_password_comes_from_the_environment():
    assert "${POSTGRES_PASSWORD" in COMPOSE["services"]["db"]["environment"]["POSTGRES_PASSWORD"]
    assert "${POSTGRES_PASSWORD" in COMPOSE["x-app-env"]["DATABASE_URL"]


def test_caddy_proxies_the_api_without_buffering_and_serves_the_app():
    caddyfile = (ROOT / "deploy" / "Caddyfile").read_text(encoding="utf8")
    assert "flush_interval -1" in caddyfile  # Server-Sent Events must not be buffered
    assert "reverse_proxy api:8000" in caddyfile and "try_files {path} /index.html" in caddyfile
    assert "{$DOMAIN}" in caddyfile


@pytest.mark.skipif(shutil.which("bash") is None, reason="bash is needed to check the scripts")
@pytest.mark.parametrize("script", ["backup.sh", "restore.sh", "deploy.sh"])
def test_deploy_scripts_parse_and_fail_on_error(script):
    path = ROOT / "deploy" / script
    assert subprocess.run(["bash", "-n", str(path)], capture_output=True).returncode == 0
    assert "set -euo pipefail" in path.read_text(encoding="utf8")


def test_the_image_carries_what_the_server_needs_to_migrate():
    dockerfile = (ROOT / "Dockerfile").read_text(encoding="utf8")
    for needed in ("alembic.ini", "migrations", "scripts", "USER app"):
        assert needed in dockerfile
