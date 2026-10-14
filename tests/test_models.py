"""The ORM describes the seven tables from the technical plan (no database needed)."""

from agent_memory.models import Base


def test_the_seven_tables_exist():
    assert set(Base.metadata.tables) == {
        "projects", "jobs", "runs", "recommendations", "outbox", "model_catalog", "alerts",
    }


def test_run_id_is_supplied_by_the_sdk_not_the_database():
    col = Base.metadata.tables["runs"].c.run_id
    assert col.primary_key
    assert col.server_default is None  # a retried send must hit the same row


def test_runs_belong_to_a_project_through_a_foreign_key():
    fks = {fk.target_fullname for fk in Base.metadata.tables["runs"].c.project_id.foreign_keys}
    assert fks == {"projects.project_id"}


def test_outbox_has_claim_columns_for_crashed_workers():
    cols = set(Base.metadata.tables["outbox"].c.keys())
    assert {"claimed_at", "updated_at", "retry_count", "last_error"} <= cols


def test_the_ui_columns_are_present():
    assert "outcome_reason" in Base.metadata.tables["runs"].c
    assert "description" in Base.metadata.tables["jobs"].c
