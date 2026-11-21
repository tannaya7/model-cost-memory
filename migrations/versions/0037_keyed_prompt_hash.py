"""Key the prompt hash, so a deleted prompt cannot be guessed back from what is left.

Revision ID: 0037
Revises: 0036

Until now runs.prompt_hash was the plain SHA-256 of the prompt text. Prompt text is deleted when retention runs, but a plain hash of a
short or common prompt can be guessed back, and the same prompt in two projects gave the same value. From now on the stored value is
HMAC-SHA256(per-project key from SECRET_KEY, plain SHA-256), and rows made earlier are converted here from their plain hash, so no
text is needed and every match (repeats, replays already done, cached vectors) carries over.

runs.hash_version   1 = still the plain hash, 2 = keyed. The conversion only touches version 1, so running it twice never keys a value
                    twice. New rows are version 2 by default.

SECRET_KEY must be the one the server will run with: the keyed value depends on it. With no SECRET_KEY (a laptop) a fixed development
string is used, the same one the server uses, so a laptop database still matches itself.

The conversion works in batches per project. It is one-way: the plain hashes cannot be recomputed from the keyed ones, so the downgrade
leaves them as they are (and keeps the marker column, so a later upgrade does not key them again). Older code run against a keyed
database would not match old and new rows of the same prompt; do not run old code against it.

Cost: one read and one write per run. Fine before the first customers; on a table of millions it takes minutes, not seconds.
"""

import hashlib
import hmac
import os

import sqlalchemy as sa
from alembic import op

revision = "0037"
down_revision = "0036"
branch_labels = None
depends_on = None

NO_SECRET_PROMPT_KEY = "development only: SECRET_KEY is not set"  # frozen copy of security.NO_SECRET_PROMPT_KEY
BATCH = 5000


def _key(project_id: str, secret: str) -> bytes:
    # frozen copy of security.prompt_hash_key: derive(secret, purpose) = HMAC-SHA256(secret, purpose)
    return hmac.new((secret or NO_SECRET_PROMPT_KEY).encode(), f"prompt-hash/v2/{project_id}".encode(), hashlib.sha256).digest()


def upgrade() -> None:
    op.execute("ALTER TABLE runs ADD COLUMN IF NOT EXISTS hash_version SMALLINT NOT NULL DEFAULT 1")  # existing rows are version 1; kept on a downgrade, so it may already be there
    bind = op.get_bind()
    secret = os.environ.get("SECRET_KEY", "")
    projects = [r[0] for r in bind.execute(sa.text("SELECT DISTINCT project_id FROM runs"))]
    for project_id in projects:
        key = _key(project_id, secret)
        while True:
            rows = bind.execute(sa.text(
                "SELECT run_id, prompt_hash FROM runs WHERE project_id = :p AND hash_version = 1 ORDER BY run_id LIMIT :n"),
                {"p": project_id, "n": BATCH}).all()
            if not rows:
                break
            ids = [r[0] for r in rows]
            new = [hmac.new(key, r[1].encode(), hashlib.sha256).hexdigest() for r in rows]
            bind.execute(sa.text(
                "UPDATE runs SET prompt_hash = v.h, hash_version = 2 FROM "
                "(SELECT unnest(CAST(:ids AS uuid[])) AS id, unnest(CAST(:hs AS text[])) AS h) v WHERE runs.run_id = v.id"),
                {"ids": ids, "hs": new})
    op.execute("ALTER TABLE runs ALTER COLUMN hash_version SET DEFAULT 2")  # every row made from now on is keyed


def downgrade() -> None:
    # One-way on purpose (see the docstring): the keyed hashes stay, and so does the marker column.
    pass
