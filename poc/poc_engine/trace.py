"""POC-only trace: every step a run goes through is written to the `events` table so the web page
can show data travelling through the system. The real system uses structured logs instead."""

from datetime import datetime, timezone

from . import db


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def log(stage: str, message: str, run_id: str | None = None, data: dict | None = None) -> None:
    with db.conn() as c:
        c.execute(
            "INSERT INTO events (ts, run_id, stage, message, data) VALUES (?,?,?,?,?)",
            (now_iso(), run_id, stage, message, db.dumps(data) if data is not None else None),
        )
