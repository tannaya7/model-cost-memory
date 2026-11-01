"""A throwaway database for the evaluation scripts: the one given, or an embedded Postgres in a
temporary folder (the `pgserver` dev extra) that is stopped and removed afterwards. Migrated to head
either way. Simulations write many projects, so never point them at a database with real data.
"""

from __future__ import annotations

import os
import shutil
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]


def migrate(url: str) -> None:
    from alembic import command
    from alembic.config import Config

    os.environ["DATABASE_URL"] = url
    cfg = Config(str(ROOT / "alembic.ini"))
    cfg.set_main_option("script_location", str(ROOT / "migrations"))
    command.upgrade(cfg, "head")


class ThrowawayDatabase:
    def __init__(self, url: str | None = None):
        self.url, self.server, self.workdir = url, None, None

    def __enter__(self) -> str:
        if not self.url:
            import pgserver  # dev extra

            self.workdir = tempfile.mkdtemp(prefix="mcm-sim-")
            self.server = pgserver.get_server(self.workdir, cleanup_mode=None)
            self.server.psql("CREATE EXTENSION IF NOT EXISTS vector;")
            self.url = self.server.get_uri()
        migrate(self.url)
        return self.url

    def __exit__(self, *exc) -> None:
        if self.server is not None:
            self.server.cleanup()
            shutil.rmtree(self.workdir, ignore_errors=True)
