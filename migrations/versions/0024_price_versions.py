"""Price versions: every price a model has had, with dates and a source, and which one each run used.

Revision ID: 0024
Revises: 0023

`price_versions` is append-only history. A database trigger on `model_catalog` and `model_prices` writes a new
version whenever a price is inserted or changed (daily sync, hand override, anything else) and closes the
previous one, so no write path can skip it. A price that is not yet in force (effective_from in the future)
or no longer in force (effective_to in the past) is never used for a new run, and stays readable.

`runs` gets price_version_id (the version that priced it), price_status (why a run is or is not priced) and
price_factor (a verified modifier such as the Anthropic batch discount). Old runs keep NULL: they were priced
before versions existed, their stored cost is unchanged, and nothing here recomputes it.

Existing catalog and provider prices get one baseline version each, effective from when the row was first seen.
Cache prices are NOT stored here yet: they follow verified per-family factors in code (cache_basis
'FAMILY_FACTOR'); explicit columns exist for the day an official page gives an exact per-model figure.
"""

from alembic import op

revision = "0024"
down_revision = "0023"
branch_labels = None
depends_on = None

LIST_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json"
LIMITS = "Public list price from the source above; not a negotiated, discounted or invoice price"

CREATE_TABLE = """
CREATE TABLE price_versions (
    version_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scope             TEXT NOT NULL CHECK (scope IN ('catalog','provider')),
    model             TEXT NOT NULL,
    model_version     TEXT NOT NULL DEFAULT '',
    provider          TEXT NOT NULL,
    input_per_mtok    NUMERIC(12,6) NOT NULL,
    output_per_mtok   NUMERIC(12,6) NOT NULL,
    cache_read_per_mtok      NUMERIC(12,6),
    cache_write_5m_per_mtok  NUMERIC(12,6),
    cache_write_1h_per_mtok  NUMERIC(12,6),
    cache_basis       TEXT NOT NULL DEFAULT 'FAMILY_FACTOR' CHECK (cache_basis IN ('FAMILY_FACTOR','EXPLICIT')),
    modifiers         JSONB,
    effective_from    TIMESTAMPTZ NOT NULL DEFAULT now(),
    effective_to      TIMESTAMPTZ,
    source_kind       TEXT NOT NULL CHECK (source_kind IN ('SYNC','MANUAL','BACKFILL')),
    source_url        TEXT,
    checked_at        TIMESTAMPTZ,
    applicability     TEXT,
    CHECK (effective_to IS NULL OR effective_to >= effective_from)
)
"""

INDEXES = [
    "CREATE UNIQUE INDEX uq_price_versions_open ON price_versions (scope, model, model_version, provider) "
    "WHERE effective_to IS NULL",
    "CREATE INDEX idx_price_versions_lookup ON price_versions (model, effective_from DESC)",
]

TRIGGER_FUNCTION = f"""
CREATE OR REPLACE FUNCTION mcm_record_price_version() RETURNS trigger AS $fn$
DECLARE
    v_scope   TEXT := TG_ARGV[0];
    v_model   TEXT;
    v_version TEXT := '';
    v_kind    TEXT := 'SYNC';
    v_same    BOOLEAN := TRUE;
BEGIN
    -- clock_timestamp(), not now(): now() is when the TRANSACTION began, which can be long before this change and
    -- would date it before calls that were already priced. Each table's own columns are read only inside its own branch: model_prices has no model_version or source.
    IF TG_OP = 'DELETE' THEN
        v_model := OLD.model;
        IF v_scope = 'catalog' THEN v_version := OLD.model_version; END IF;
        -- A deleted row ends the version in force: a removed price must stop pricing runs.
        UPDATE price_versions SET effective_to = clock_timestamp()
         WHERE scope = v_scope AND model = v_model AND model_version = v_version AND effective_to IS NULL;
        RETURN OLD;
    END IF;
    v_model := NEW.model;
    IF v_scope = 'catalog' THEN
        v_version := NEW.model_version;
        v_kind := NEW.source;
        IF TG_OP = 'UPDATE' THEN v_same := OLD.source IS NOT DISTINCT FROM NEW.source; END IF;
    END IF;
    IF NEW.price_in_per_mtok IS NULL OR NEW.price_out_per_mtok IS NULL THEN
        -- A price taken away ends the version in force too.
        UPDATE price_versions SET effective_to = clock_timestamp()
         WHERE scope = v_scope AND model = v_model AND model_version = v_version AND effective_to IS NULL;
        RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE'
       AND OLD.price_in_per_mtok IS NOT DISTINCT FROM NEW.price_in_per_mtok
       AND OLD.price_out_per_mtok IS NOT DISTINCT FROM NEW.price_out_per_mtok
       AND OLD.provider IS NOT DISTINCT FROM NEW.provider
       AND v_same THEN
        RETURN NEW;
    END IF;
    UPDATE price_versions SET effective_to = clock_timestamp()
     WHERE scope = v_scope AND model = v_model AND model_version = v_version AND effective_to IS NULL;
    INSERT INTO price_versions (scope, model, model_version, provider, input_per_mtok, output_per_mtok,
                                source_kind, source_url, checked_at, effective_from, applicability)
    VALUES (v_scope, v_model, v_version, NEW.provider, NEW.price_in_per_mtok, NEW.price_out_per_mtok, v_kind,
            CASE WHEN v_kind = 'MANUAL' THEN NULL ELSE '{LIST_URL}' END, clock_timestamp(), clock_timestamp(),
            CASE WHEN v_kind = 'MANUAL' THEN 'Entered by hand; not checked against a provider page'
                 ELSE '{LIMITS}' END);
    RETURN NEW;
END
$fn$ LANGUAGE plpgsql
"""

TRIGGERS = [
    "CREATE TRIGGER trg_catalog_price_version AFTER INSERT OR UPDATE ON model_catalog "
    "FOR EACH ROW EXECUTE FUNCTION mcm_record_price_version('catalog')",
    "CREATE TRIGGER trg_provider_price_version AFTER INSERT OR UPDATE ON model_prices "
    "FOR EACH ROW EXECUTE FUNCTION mcm_record_price_version('provider')",
    "CREATE TRIGGER trg_catalog_price_closed AFTER DELETE ON model_catalog "
    "FOR EACH ROW EXECUTE FUNCTION mcm_record_price_version('catalog')",
    "CREATE TRIGGER trg_provider_price_closed AFTER DELETE ON model_prices "
    "FOR EACH ROW EXECUTE FUNCTION mcm_record_price_version('provider')",
]

BACKFILL = [
    f"""INSERT INTO price_versions (scope, model, model_version, provider, input_per_mtok, output_per_mtok,
                                  source_kind, source_url, effective_from, applicability)
        SELECT 'catalog', model, model_version, provider, price_in_per_mtok, price_out_per_mtok,
               CASE WHEN source = 'MANUAL' THEN 'MANUAL' ELSE 'BACKFILL' END,
               CASE WHEN source = 'MANUAL' THEN NULL ELSE '{LIST_URL}' END, first_seen_at,
               'Price as it stood when versions were introduced; not checked again then'
          FROM model_catalog WHERE price_in_per_mtok IS NOT NULL AND price_out_per_mtok IS NOT NULL""",
    f"""INSERT INTO price_versions (scope, model, model_version, provider, input_per_mtok, output_per_mtok,
                                  source_kind, source_url, effective_from, applicability)
        SELECT 'provider', model, '', provider, price_in_per_mtok, price_out_per_mtok, 'BACKFILL',
               '{LIST_URL}', first_seen_at,
               'Price as it stood when versions were introduced; not checked again then'
          FROM model_prices WHERE price_in_per_mtok IS NOT NULL AND price_out_per_mtok IS NOT NULL""",
]

RUN_COLUMNS = [
    "ALTER TABLE runs ADD COLUMN price_version_id UUID REFERENCES price_versions(version_id)",
    "ALTER TABLE runs ADD COLUMN price_status TEXT",
    "ALTER TABLE runs ADD COLUMN price_factor NUMERIC(6,4)",
    "ALTER TABLE runs ADD COLUMN cache_write_1h_tokens INTEGER",
    "ALTER TABLE runs ADD CONSTRAINT runs_price_status_check CHECK (price_status IS NULL OR price_status IN "
    "('PRICED','PARTLY_PRICED','CALLER_COST','NO_USAGE','UNPRICED_UNKNOWN_MODEL','UNPRICED_NOT_YET_EFFECTIVE',"
    "'UNPRICED_EXPIRED')) NOT VALID",
    "CREATE INDEX idx_runs_price_version ON runs (price_version_id) WHERE price_version_id IS NOT NULL",
]


def upgrade() -> None:
    op.execute(CREATE_TABLE)
    for statement in INDEXES:
        op.execute(statement)
    op.execute(TRIGGER_FUNCTION)
    for statement in BACKFILL:  # before the triggers exist, so the baseline is not written twice
        op.execute(statement)
    for statement in TRIGGERS:
        op.execute(statement)
    for statement in RUN_COLUMNS:
        op.execute(statement)


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_runs_price_version")
    op.execute("ALTER TABLE runs DROP CONSTRAINT IF EXISTS runs_price_status_check")
    for column in ("cache_write_1h_tokens", "price_factor", "price_status", "price_version_id"):
        op.execute(f"ALTER TABLE runs DROP COLUMN {column}")
    op.execute("DROP TRIGGER IF EXISTS trg_provider_price_closed ON model_prices")
    op.execute("DROP TRIGGER IF EXISTS trg_catalog_price_closed ON model_catalog")
    op.execute("DROP TRIGGER IF EXISTS trg_provider_price_version ON model_prices")
    op.execute("DROP TRIGGER IF EXISTS trg_catalog_price_version ON model_catalog")
    op.execute("DROP FUNCTION IF EXISTS mcm_record_price_version()")
    op.execute("DROP TABLE price_versions")
