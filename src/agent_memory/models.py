"""Domain models: Project, Job, Run, Recommendation, OutboxRow, CatalogEntry, Alert.

Mirrors the tables in db/schema.sql (and the Alembic baseline migration). A test fails if the
two ever drift apart. SQLAlchemy 2.x typed declarative style.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import (
    ARRAY,
    Boolean,
    CheckConstraint,
    Date,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    REAL,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, TIMESTAMP, UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

NOW = text("now()")
NEW_UUID = text("gen_random_uuid()")
Timestamp = TIMESTAMP(timezone=True)


class Base(DeclarativeBase):
    pass


class Project(Base):
    __tablename__ = "projects"

    project_id: Mapped[str] = mapped_column(Text, primary_key=True)
    api_key_hash: Mapped[str] = mapped_column(Text)  # the key itself is shown once, never stored
    webhook_url: Mapped[str | None] = mapped_column(Text)
    retest_monthly_cap_usd: Mapped[Decimal] = mapped_column(
        Numeric(8, 2), server_default=text("10")
    )
    created_at: Mapped[datetime] = mapped_column(Timestamp, server_default=NOW)


class Job(Base):
    __tablename__ = "jobs"
    __table_args__ = (
        UniqueConstraint("project_id", "name"),
        CheckConstraint(
            "check_kind IN ('ANSWER_KEY','TEST_COMMAND','SCHEMA','LATE_LABEL')",
            name="jobs_check_kind_check",
        ),
    )

    job_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, server_default=NEW_UUID)
    project_id: Mapped[str] = mapped_column(Text, ForeignKey("projects.project_id"))
    name: Mapped[str] = mapped_column(Text)
    description: Mapped[str | None] = mapped_column(Text)
    check_kind: Mapped[str] = mapped_column(Text)
    check_config: Mapped[dict[str, Any]] = mapped_column(JSONB)
    retest_consent: Mapped[bool] = mapped_column(Boolean, server_default=text("false"))


class Run(Base):
    __tablename__ = "runs"
    __table_args__ = (
        CheckConstraint("outcome IN ('PASS','FAIL','UNKNOWN')", name="runs_outcome_check"),
        CheckConstraint("run_kind IN ('PRODUCTION','SHADOW','RETEST')", name="runs_run_kind_check"),
        CheckConstraint("memory_type IN ('EPISODIC','SEMANTIC')", name="runs_memory_type_check"),
        CheckConstraint(
            "state IN ('CAPTURED','CHECKED','INDEXED','CONSOLIDATED','ARCHIVED','INGESTION_FAILED')",
            name="runs_state_check",
        ),
        Index("idx_runs_job_model", "job_id", "model", "model_version"),
        Index("idx_runs_job_created", "job_id", text("created_at DESC")),
        Index("idx_runs_prompt_hash", "prompt_hash"),
    )

    # Supplied by the SDK, so a retried send hits the same row (INSERT ... ON CONFLICT DO NOTHING).
    run_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    job_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("jobs.job_id"))
    project_id: Mapped[str] = mapped_column(Text, ForeignKey("projects.project_id"))
    prompt: Mapped[str] = mapped_column(Text)
    prompt_hash: Mapped[str] = mapped_column(Text)
    model: Mapped[str] = mapped_column(Text)
    model_version: Mapped[str] = mapped_column(Text)
    prompt_version: Mapped[str | None] = mapped_column(Text)
    tokens_in: Mapped[int] = mapped_column(Integer, server_default=text("0"))
    tokens_out: Mapped[int] = mapped_column(Integer, server_default=text("0"))
    cache_read_tokens: Mapped[int] = mapped_column(Integer, server_default=text("0"))
    cache_write_tokens: Mapped[int] = mapped_column(Integer, server_default=text("0"))
    cost_usd: Mapped[Decimal] = mapped_column(Numeric(12, 6), server_default=text("0"))
    latency_ms: Mapped[int | None] = mapped_column(Integer)
    output: Mapped[str | None] = mapped_column(Text)
    tool_calls: Mapped[Any | None] = mapped_column(JSONB)
    outcome: Mapped[str] = mapped_column(Text, server_default=text("'UNKNOWN'"))
    outcome_reason: Mapped[str | None] = mapped_column(Text)
    run_kind: Mapped[str] = mapped_column(Text, server_default=text("'PRODUCTION'"))
    memory_type: Mapped[str] = mapped_column(Text, server_default=text("'EPISODIC'"))
    importance_score: Mapped[float] = mapped_column(REAL, server_default=text("1.0"))
    stability: Mapped[float] = mapped_column(REAL, server_default=text("1.0"))  # days
    state: Mapped[str] = mapped_column(Text, server_default=text("'CAPTURED'"))
    created_at: Mapped[datetime] = mapped_column(Timestamp, server_default=NOW)
    invalid_at: Mapped[datetime | None] = mapped_column(Timestamp)


class Recommendation(Base):
    __tablename__ = "recommendations"
    __table_args__ = (
        CheckConstraint(
            "verdict IN ('SWITCH','HOLD','DOWNGRADE','INSUFFICIENT_EVIDENCE')",
            name="recommendations_verdict_check",
        ),
        Index("idx_rec_current", "job_id", postgresql_where=text("invalid_at IS NULL")),
    )

    recommendation_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=NEW_UUID
    )
    job_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("jobs.job_id"))
    model: Mapped[str] = mapped_column(Text)
    model_version: Mapped[str] = mapped_column(Text)
    verdict: Mapped[str] = mapped_column(Text)
    weighted_pass_rate: Mapped[float | None] = mapped_column(REAL)
    mean_cost_usd: Mapped[Decimal | None] = mapped_column(Numeric(12, 6))
    n_runs: Mapped[int] = mapped_column(Integer)
    evidence_weight: Mapped[float] = mapped_column(REAL)  # sum of R(t)
    consolidated_from: Mapped[list[uuid.UUID]] = mapped_column(
        ARRAY(UUID(as_uuid=True)), server_default=text("'{}'")
    )  # the proof
    superseded_by_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("recommendations.recommendation_id")
    )
    supersession_reason: Mapped[str | None] = mapped_column(Text)  # MODEL_UPGRADE | EVIDENCE_DECAYED | REGRESSION
    memory_type: Mapped[str] = mapped_column(Text, server_default=text("'SEMANTIC'"))
    valid_at: Mapped[datetime] = mapped_column(Timestamp, server_default=NOW)
    invalid_at: Mapped[datetime | None] = mapped_column(Timestamp)


class OutboxRow(Base):
    __tablename__ = "outbox"
    __table_args__ = (
        CheckConstraint("op IN ('UPSERT','INVALIDATE','RETEST')", name="outbox_op_check"),
        CheckConstraint(
            "status IN ('PENDING','PROCESSING','DONE','FAILED')", name="outbox_status_check"
        ),
        Index("idx_outbox_pending", "status", "created_at", postgresql_where=text("status = 'PENDING'")),
        Index("idx_outbox_stuck", "claimed_at", postgresql_where=text("status = 'PROCESSING'")),
        Index("idx_outbox_done", "updated_at", postgresql_where=text("status = 'DONE'")),
    )

    outbox_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, server_default=NEW_UUID)
    run_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("runs.run_id"))
    op: Mapped[str] = mapped_column(Text)
    payload: Mapped[dict[str, Any]] = mapped_column(JSONB)
    status: Mapped[str] = mapped_column(Text, server_default=text("'PENDING'"))
    retry_count: Mapped[int] = mapped_column(Integer, server_default=text("0"))
    last_error: Mapped[str | None] = mapped_column(Text)
    claimed_at: Mapped[datetime | None] = mapped_column(Timestamp)
    created_at: Mapped[datetime] = mapped_column(Timestamp, server_default=NOW)
    updated_at: Mapped[datetime] = mapped_column(Timestamp, server_default=NOW)


class CatalogEntry(Base):
    __tablename__ = "model_catalog"
    __table_args__ = (
        CheckConstraint("status IN ('ACTIVE','DEPRECATED','RETIRED')", name="model_catalog_status_check"),
        CheckConstraint("source IN ('SYNC','MANUAL')", name="model_catalog_source_check"),
    )

    model: Mapped[str] = mapped_column(Text, primary_key=True)
    model_version: Mapped[str] = mapped_column(Text, primary_key=True)
    provider: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(Text, server_default=text("'ACTIVE'"))
    shutdown_date: Mapped[date | None] = mapped_column(Date)  # set when DEPRECATED
    price_in_per_mtok: Mapped[Decimal | None] = mapped_column(Numeric(10, 4))
    price_out_per_mtok: Mapped[Decimal | None] = mapped_column(Numeric(10, 4))
    source: Mapped[str] = mapped_column(Text, server_default=text("'SYNC'"))
    first_seen_at: Mapped[datetime] = mapped_column(Timestamp, server_default=NOW)


class Alert(Base):
    __tablename__ = "alerts"
    __table_args__ = (
        CheckConstraint(
            "kind IN ('VERSION_REGRESSION','SILENT_DROP','MODEL_DEPRECATED')", name="alerts_kind_check"
        ),
    )

    alert_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, server_default=NEW_UUID)
    job_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("jobs.job_id"))
    kind: Mapped[str] = mapped_column(Text)
    detail: Mapped[dict[str, Any]] = mapped_column(JSONB)  # rates before/after, p-value, run ids
    delivered_at: Mapped[datetime | None] = mapped_column(Timestamp)  # null until the webhook accepts it
    resolved_at: Mapped[datetime | None] = mapped_column(Timestamp)
    created_at: Mapped[datetime] = mapped_column(Timestamp, server_default=NOW)
