"""Domain models: Project, Job, Run, Recommendation, OutboxRow, CatalogEntry, Alert.

Mirrors the tables in db/schema.sql (and the Alembic baseline migration). A test fails if the
two ever drift apart. SQLAlchemy 2.x typed declarative style.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import Any

from pgvector.sqlalchemy import Vector
from sqlalchemy import (
    ARRAY,
    BigInteger,
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

EMBEDDING_DIM = 384  # all-MiniLM-L6-v2
NOW = text("now()")
NEW_UUID = text("gen_random_uuid()")
Timestamp = TIMESTAMP(timezone=True)


class Base(DeclarativeBase):
    pass


class User(Base):
    """One Google account. No passwords are stored."""

    __tablename__ = "users"

    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, server_default=NEW_UUID)
    google_sub: Mapped[str] = mapped_column(Text, unique=True)  # Google's stable account id
    email: Mapped[str] = mapped_column(Text)
    name: Mapped[str | None] = mapped_column(Text)
    picture_url: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(Timestamp, server_default=NOW)


class Project(Base):
    __tablename__ = "projects"
    __table_args__ = (Index("idx_projects_owner", "owner_user_id"),)

    project_id: Mapped[str] = mapped_column(Text, primary_key=True)
    api_key_hash: Mapped[str] = mapped_column(Text)  # the key itself is shown once, never stored
    webhook_url: Mapped[str | None] = mapped_column(Text)
    store_tool_arguments: Mapped[bool] = mapped_column(Boolean, server_default=text("false"))  # opt-in
    retest_monthly_cap_usd: Mapped[Decimal] = mapped_column(
        Numeric(8, 2), server_default=text("10")
    )
    webhook_secret: Mapped[str | None] = mapped_column(Text)  # signs webhook payloads (HMAC-SHA256)
    retest_allowed: Mapped[bool] = mapped_column(Boolean, server_default=text("true"))  # project-wide switch
    created_at: Mapped[datetime] = mapped_column(Timestamp, server_default=NOW)
    owner_user_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("users.user_id"))
    name: Mapped[str | None] = mapped_column(Text)  # display name chosen in the web app
    key_prefix: Mapped[str | None] = mapped_column(Text)  # first characters of the live key, for display


class ProviderKey(Base):
    """The customer's key for re-tests, asked for when a re-test is first needed. Encrypted."""

    __tablename__ = "provider_keys"

    project_id: Mapped[str] = mapped_column(Text, ForeignKey("projects.project_id"), primary_key=True)
    provider: Mapped[str] = mapped_column(Text)  # matches model_catalog.provider
    base_url: Mapped[str] = mapped_column(Text)  # an OpenAI-compatible endpoint
    key_encrypted: Mapped[str] = mapped_column(Text)
    key_hint: Mapped[str] = mapped_column(Text)  # last four characters
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
        Index("idx_runs_retest", "retest_id", postgresql_where=text("retest_id IS NOT NULL")),
        Index("idx_runs_job_created", "job_id", text("created_at DESC")),
        Index("idx_runs_prompt_hash", "prompt_hash"),
        Index(
            "idx_runs_embedding", "embedding", postgresql_using="hnsw",
            postgresql_ops={"embedding": "vector_cosine_ops"},
        ),
        Index(
            "idx_runs_embedding_cache", "project_id", "prompt_hash", "embedding_model",
            postgresql_where=text("embedding IS NOT NULL"),
        ),
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
    effort: Mapped[str | None] = mapped_column(Text)  # reasoning effort the call asked for, e.g. "low" (0013)
    tokens_in: Mapped[int] = mapped_column(Integer, server_default=text("0"))
    tokens_out: Mapped[int] = mapped_column(Integer, server_default=text("0"))
    cache_read_tokens: Mapped[int] = mapped_column(Integer, server_default=text("0"))
    cache_write_tokens: Mapped[int] = mapped_column(Integer, server_default=text("0"))
    cost_usd: Mapped[Decimal | None] = mapped_column(Numeric(12, 6))  # NULL = price unknown, never "free"
    latency_ms: Mapped[int | None] = mapped_column(Integer)
    output: Mapped[str | None] = mapped_column(Text)
    tool_calls: Mapped[Any | None] = mapped_column(JSONB)
    outcome: Mapped[str] = mapped_column(Text, server_default=text("'UNKNOWN'"))
    outcome_reason: Mapped[str | None] = mapped_column(Text)
    run_kind: Mapped[str] = mapped_column(Text, server_default=text("'PRODUCTION'"))
    memory_type: Mapped[str] = mapped_column(Text, server_default=text("'EPISODIC'"))
    importance_score: Mapped[float] = mapped_column(REAL, server_default=text("1.0"))
    stability: Mapped[float] = mapped_column(REAL, server_default=text("1.0"))  # days
    embedding: Mapped[list[float] | None] = mapped_column(Vector(EMBEDDING_DIM))  # set by the sync worker
    embedding_model: Mapped[str | None] = mapped_column(Text)  # which embedder wrote it
    state: Mapped[str] = mapped_column(Text, server_default=text("'CAPTURED'"))
    created_at: Mapped[datetime] = mapped_column(Timestamp, server_default=NOW)
    invalid_at: Mapped[datetime | None] = mapped_column(Timestamp)
    retest_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("retests.retest_id"))
    expected: Mapped[dict[str, Any] | None] = mapped_column(JSONB)  # kept only for jobs with re-test consent
    provider: Mapped[str | None] = mapped_column(Text)  # who served the call; picks the price


class Retest(Base):
    """Replaying sampled past runs on a candidate model, under a budget."""

    __tablename__ = "retests"
    __table_args__ = (
        CheckConstraint("trigger IN ('MANUAL','NEW_MODEL','UNSURE','FIRST_KEY')", name="retests_trigger_check"),
        CheckConstraint(
            "status IN ('QUEUED','RUNNING','DONE','STOPPED_BUDGET','STOPPED_CAP','FAILED')",
            name="retests_status_check",
        ),
        CheckConstraint("budget_usd > 0", name="retests_budget_usd_check"),
        Index("idx_retests_queued", "created_at", postgresql_where=text("status = 'QUEUED'")),
        Index("idx_retests_job", "job_id", text("created_at DESC")),
    )

    retest_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, server_default=NEW_UUID)
    job_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("jobs.job_id"))
    project_id: Mapped[str] = mapped_column(Text, ForeignKey("projects.project_id"))
    candidate_model: Mapped[str] = mapped_column(Text)
    trigger: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(Text, server_default=text("'QUEUED'"))
    budget_usd: Mapped[Decimal] = mapped_column(Numeric(10, 4))
    spent_usd: Mapped[Decimal] = mapped_column(Numeric(12, 6), server_default=text("0"))
    runs_planned: Mapped[int] = mapped_column(Integer, server_default=text("0"))
    runs_done: Mapped[int] = mapped_column(Integer, server_default=text("0"))
    passed: Mapped[int] = mapped_column(Integer, server_default=text("0"))
    failed: Mapped[int] = mapped_column(Integer, server_default=text("0"))
    message: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(Timestamp, server_default=NOW)
    started_at: Mapped[datetime | None] = mapped_column(Timestamp)
    finished_at: Mapped[datetime | None] = mapped_column(Timestamp)


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
    # NEW_EVIDENCE | MODEL_UPGRADE | EVIDENCE_DECAYED | REGRESSION | MODEL_RETIRED
    supersession_reason: Mapped[str | None] = mapped_column(Text)
    current_model: Mapped[str | None] = mapped_column(Text)  # what production used when this was decided
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


class ProviderPrice(Base):
    """One provider's price for a model. The catalog has one row per name; this has one per seller."""

    __tablename__ = "model_prices"

    model: Mapped[str] = mapped_column(Text, primary_key=True)
    provider: Mapped[str] = mapped_column(Text, primary_key=True)
    price_in_per_mtok: Mapped[Decimal | None] = mapped_column(Numeric(10, 4))
    price_out_per_mtok: Mapped[Decimal | None] = mapped_column(Numeric(10, 4))
    shutdown_date: Mapped[date | None] = mapped_column(Date)  # this provider's own date (0011)
    first_seen_at: Mapped[datetime] = mapped_column(Timestamp, server_default=NOW)


class Alert(Base):
    __tablename__ = "alerts"
    __table_args__ = (
        CheckConstraint(
            "kind IN ('VERSION_REGRESSION','SILENT_DROP','MODEL_DEPRECATED')", name="alerts_kind_check"
        ),
        Index("idx_alerts_open", "job_id", "dedupe_key", unique=True, postgresql_where=text("resolved_at IS NULL")),
        Index("idx_alerts_undelivered", "next_attempt_at", postgresql_where=text("delivered_at IS NULL")),
    )

    alert_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, server_default=NEW_UUID)
    job_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("jobs.job_id"))
    kind: Mapped[str] = mapped_column(Text)
    detail: Mapped[dict[str, Any]] = mapped_column(JSONB)  # rates before/after, p-value, run ids
    delivered_at: Mapped[datetime | None] = mapped_column(Timestamp)  # null until the webhook accepts it
    resolved_at: Mapped[datetime | None] = mapped_column(Timestamp)
    created_at: Mapped[datetime] = mapped_column(Timestamp, server_default=NOW)
    dedupe_key: Mapped[str] = mapped_column(Text, server_default=text("''"))  # one open alert per finding
    delivery_attempts: Mapped[int] = mapped_column(Integer, server_default=text("0"))
    next_attempt_at: Mapped[datetime | None] = mapped_column(Timestamp)  # webhook retry with backoff
    last_error: Mapped[str | None] = mapped_column(Text)


class FlowEvent(Base):
    """One step of a run through the pipeline, for the live data-flow view. Deleted after a day."""

    __tablename__ = "flow_events"
    __table_args__ = (
        CheckConstraint("stage IN ('sdk','api','check','index','consolidate')", name="flow_events_stage_check"),
        Index("idx_flow_events_project", "project_id", "event_id"),
        Index("idx_flow_events_ts", "ts"),
    )

    event_id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    project_id: Mapped[str] = mapped_column(Text, ForeignKey("projects.project_id"))
    run_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    stage: Mapped[str] = mapped_column(Text)
    message: Mapped[str] = mapped_column(Text)
    data: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    ts: Mapped[datetime] = mapped_column(Timestamp, server_default=NOW)


class UsageLimit(Base):
    """A usage limit the project works under: a window that resets (a 5-hour session, a 7-day week, a day's
    quota), how its use is measured, and optionally the one model it applies to (0013)."""

    __tablename__ = "usage_limits"
    __table_args__ = (
        CheckConstraint("measure IN ('USD','TOKENS','REQUESTS','PERCENT')", name="usage_limits_measure_check"),
        CheckConstraint("window_hours > 0", name="usage_limits_window_check"),
        CheckConstraint("measure = 'PERCENT' OR size > 0", name="usage_limits_size_check"),
        CheckConstraint("reported_used IS NULL OR (reported_used >= 0 AND reported_used <= 1)",
                        name="usage_limits_reported_check"),
        Index("idx_usage_limits_project", "project_id"),
    )

    limit_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, server_default=NEW_UUID)
    project_id: Mapped[str] = mapped_column(Text, ForeignKey("projects.project_id"))
    name: Mapped[str] = mapped_column(Text)
    window_hours: Mapped[int] = mapped_column(Integer)
    resets_at: Mapped[datetime] = mapped_column(Timestamp)  # the end of a window; later ones follow every window_hours
    measure: Mapped[str] = mapped_column(Text)
    size: Mapped[Decimal | None] = mapped_column(Numeric(16, 4))  # in the measure's unit; none for PERCENT
    model: Mapped[str | None] = mapped_column(Text)  # only this model family counts, e.g. a per-model limit
    reported_used: Mapped[Decimal | None] = mapped_column(Numeric(5, 4))  # PERCENT: the share the user last saw
    reported_at: Mapped[datetime | None] = mapped_column(Timestamp)
    created_at: Mapped[datetime] = mapped_column(Timestamp, server_default=NOW)
