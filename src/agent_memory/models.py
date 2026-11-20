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
    # Which first-visit guides this person has seen: only tour_seen and first_results_seen, as booleans.
    ui_flags: Mapped[dict[str, bool]] = mapped_column(JSONB, server_default=text("'{}'::jsonb"))
    # Carried in the sign-in cookie; logout raises it, so a cookie copied earlier stops working (0034).
    session_epoch: Mapped[int] = mapped_column(Integer, server_default=text("0"))


class Project(Base):
    __tablename__ = "projects"
    __table_args__ = (
        Index("idx_projects_owner", "owner_user_id"),
        Index("idx_projects_key_hash", "api_key_hash"),
        Index("uq_projects_owner_slug", "owner_user_id", "slug", unique=True,
              postgresql_where=text("owner_user_id IS NOT NULL AND organisation_id IS NULL")),
        Index("uq_projects_ownerless_slug", "slug", unique=True,
              postgresql_where=text("owner_user_id IS NULL AND organisation_id IS NULL")),
        Index("uq_projects_org_slug", "organisation_id", "slug", unique=True, postgresql_where=text("organisation_id IS NOT NULL")),
        Index("idx_projects_org", "organisation_id", postgresql_where=text("organisation_id IS NOT NULL")),
        CheckConstraint("slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) BETWEEN 1 AND 40",
                        name="projects_slug_check"),
        CheckConstraint("content_retention_days BETWEEN 1 AND 3650", name="projects_retention_check"),
        CheckConstraint("billing_mode IN ('per_use','subscription','both')", name="projects_billing_mode_check"),
        CheckConstraint("cardinality(budget_alert_levels) <= 6 AND 0 < ALL (budget_alert_levels) AND 100 >= ALL (budget_alert_levels)",
                        name="projects_budget_levels_check"),
        CheckConstraint("monthly_budget_usd IS NULL OR monthly_budget_usd > 0", name="projects_budget_check"),
    )

    project_id: Mapped[str] = mapped_column(Text, primary_key=True)
    # The short readable name in the web address (/p/production). Stable; the API keeps using project_id.
    # Unique per owner (0022). Rows built without one (tests, the operator script) take their own id.
    slug: Mapped[str] = mapped_column(Text, default=lambda ctx: ctx.get_current_parameters()["project_id"])
    api_key_hash: Mapped[str] = mapped_column(Text)  # the key itself is shown once, never stored
    webhook_url: Mapped[str | None] = mapped_column(Text)
    billing_mode: Mapped[str] = mapped_column(Text, server_default=text("'per_use'"))  # (0021)
    # Off unless an admin turns it on: automatic paid replays (a new model appears, the engine is unsure, a key is first added) (0032)
    auto_retests: Mapped[bool] = mapped_column(Boolean, server_default=text("false"))
    # Budget alerts (0025). Always shown in the app; sent to the webhook only when budget_alert_webhook is on.
    budget_timezone: Mapped[str] = mapped_column(Text, server_default=text("'UTC'"))
    budget_alert_levels: Mapped[list[int]] = mapped_column(ARRAY(Integer), server_default=text("'{85,95}'"))
    budget_alert_projected: Mapped[bool] = mapped_column(Boolean, server_default=text("true"))
    budget_alert_webhook: Mapped[bool] = mapped_column(Boolean, server_default=text("false"))
    notice_alert_webhook: Mapped[bool] = mapped_column(Boolean, server_default=text("false"))  # model notices to the webhook (0026): opt in
    # Opt-in (0027): may the computed figures of a recommendation be sent to an outside AI to write its summary.
    ai_summary_consent: Mapped[bool] = mapped_column(Boolean, server_default=text("false"))
    store_tool_arguments: Mapped[bool] = mapped_column(Boolean, server_default=text("false"))  # opt-in
    retest_monthly_cap_usd: Mapped[Decimal] = mapped_column(
        Numeric(8, 2), server_default=text("10")
    )
    webhook_secret: Mapped[str | None] = mapped_column(Text)  # signs webhook payloads (HMAC-SHA256)
    retest_allowed: Mapped[bool] = mapped_column(Boolean, server_default=text("true"))  # project-wide switch
    created_at: Mapped[datetime] = mapped_column(Timestamp, server_default=NOW)
    # The person who made a personal project (organisation_id NULL), or who created a company project: for a company
    # project this is history only and grants nothing; membership decides access (0030).
    owner_user_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("users.user_id"))
    organisation_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("organisations.org_id"))
    name: Mapped[str | None] = mapped_column(Text)  # display name chosen in the web app
    key_prefix: Mapped[str | None] = mapped_column(Text)  # first characters of the live key, for display
    # Days a run keeps its prompt, answer, tool calls and answer key (retention.py; 0015).
    content_retention_days: Mapped[int] = mapped_column(Integer, server_default=text("90"))
    # Opt-in: may a few sample prompts be sent to an outside AI service to write a task summary (0019).
    task_summary_consent: Mapped[bool] = mapped_column(Boolean, server_default=text("false"))
    monthly_budget_usd: Mapped[Decimal | None] = mapped_column(Numeric(12, 2))  # optional soft budget (0018)


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
        CheckConstraint("run_kind IN ('PRODUCTION','RETEST')", name="runs_run_kind_check"),
        CheckConstraint(
            "price_status IS NULL OR price_status IN ('PRICED','PARTLY_PRICED','CALLER_COST','NO_USAGE',"
            "'UNPRICED_UNKNOWN_MODEL','UNPRICED_NOT_YET_EFFECTIVE','UNPRICED_EXPIRED')",
            name="runs_price_status_check"),
        CheckConstraint(
            "usage_shape IS NULL OR usage_shape IN ('anthropic_messages','openai_responses','openai_chat',"
            "'deepseek_chat','gemini','none')", name="runs_usage_shape_check"),
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
        Index("idx_runs_project_trace", "project_id", "trace_id", postgresql_where=text("trace_id IS NOT NULL")),
        Index("idx_runs_span", "project_id", "trace_id", "span_id", postgresql_where=text("span_id IS NOT NULL")),
        Index("idx_runs_content_kept", "created_at", postgresql_where=text("content_removed_at IS NULL")),
    )

    # Supplied by the SDK, so a retried send hits the same row (INSERT ... ON CONFLICT DO NOTHING).
    run_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    job_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("jobs.job_id"))
    project_id: Mapped[str] = mapped_column(Text, ForeignKey("projects.project_id"))
    prompt: Mapped[str | None] = mapped_column(Text)  # NULL once cleared by retention (content_removed_at)
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
    agent: Mapped[str | None] = mapped_column(Text)  # which agent or role made the call (0017)
    trace_id: Mapped[str | None] = mapped_column(Text)  # shared by every call serving one user task (0017)
    span_id: Mapped[str | None] = mapped_column(Text)  # this call's own id, chosen by the app (0029)
    parent_span_id: Mapped[str | None] = mapped_column(Text)  # the span_id of the call that started this one (0029)
    tools_tokens: Mapped[int | None] = mapped_column(Integer)  # estimate: size of the tool definitions sent (0017)
    tool_call_count: Mapped[int | None] = mapped_column(Integer)  # tool calls in the response (0017)
    # The canonical token ledger (0023). NULL = not reported / unknown, which is different from 0.
    usage_shape: Mapped[str | None] = mapped_column(Text)  # which provider layout was read; 'none' = no usage block
    usage_raw: Mapped[dict[str, Any] | None] = mapped_column(JSONB)  # the usage block as numbers only
    reasoning_tokens: Mapped[int | None] = mapped_column(Integer)
    tool_use_input_tokens: Mapped[int | None] = mapped_column(Integer)  # Gemini; not priced
    # Which price priced this run (0024). NULL = recorded before price versions existed.
    price_version_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("price_versions.version_id"))
    price_status: Mapped[str | None] = mapped_column(Text)
    price_factor: Mapped[Decimal | None] = mapped_column(Numeric(6, 4))  # verified modifier, e.g. 0.5 for batch
    cache_write_1h_tokens: Mapped[int | None] = mapped_column(Integer)  # part of cache_write_tokens kept 1 hour
    # When retention cleared prompt, output, tool_calls, expected and embedding (retention.py; 0015).
    content_removed_at: Mapped[datetime | None] = mapped_column(Timestamp)


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
    # What the person confirmed and what was recorded (0032). Never prompt text.
    confirmation_hash: Mapped[str | None] = mapped_column(Text, unique=True)
    confirmed_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("users.user_id", ondelete="SET NULL"))
    confirmed_at: Mapped[datetime | None] = mapped_column(Timestamp)
    preview: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    price_basis: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    evaluator: Mapped[str | None] = mapped_column(Text)
    provider_host: Mapped[str | None] = mapped_column(Text)
    sample_run_ids: Mapped[list[str] | None] = mapped_column(JSONB)
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
            "kind IN ('VERSION_REGRESSION','SILENT_DROP','MODEL_DEPRECATED','TOKEN_BURST','BUDGET',"
            "'TRIAL_BUDGET','MODEL_RETIRING','MODEL_NOTICE')", name="alerts_kind_check"
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
    delivery_failed_at: Mapped[datetime | None] = mapped_column(Timestamp)  # gave up after MAX_ATTEMPTS (0014)


class RecommendationSummary(Base):
    """The optional two-sentence summary, written once per verdict (0014). `summary_key` identifies the
    verdict (the job, the summary model and prompt, and what the verdict says), not its exact figures,
    so new runs that leave the verdict unchanged do not pay for another call."""

    __tablename__ = "recommendation_summaries"
    __table_args__ = (Index("idx_summaries_attempted", "attempted_at"),)

    summary_key: Mapped[str] = mapped_column(Text, primary_key=True)
    job_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("jobs.job_id", ondelete="CASCADE"))
    summary: Mapped[str | None] = mapped_column(Text)  # null while being written, or after a failed call
    prompt_version: Mapped[str] = mapped_column(Text)
    attempts: Mapped[int] = mapped_column(Integer, server_default=text("1"))
    attempted_at: Mapped[datetime] = mapped_column(Timestamp, server_default=NOW)


class TaskSummary(Base):
    """The optional AI summary of what a task does, one per job (0019). `fingerprint` identifies the sample
    calls it was written from, so it is written again only when they change."""

    __tablename__ = "task_summaries"
    __table_args__ = (Index("idx_task_summaries_attempted", "attempted_at"),)

    job_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("jobs.job_id", ondelete="CASCADE"),
                                              primary_key=True)
    fingerprint: Mapped[str] = mapped_column(Text)
    summary: Mapped[str | None] = mapped_column(Text)
    prompt_version: Mapped[str] = mapped_column(Text)
    attempts: Mapped[int] = mapped_column(Integer, server_default=text("1"))
    attempted_at: Mapped[datetime] = mapped_column(Timestamp, server_default=NOW)


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


class SchedulerHeartbeat(Base):
    """When each scheduled job last succeeded or failed (heartbeat.py; 0015). The row named 'scheduler'
    records when the running scheduler took the lead."""

    __tablename__ = "scheduler_heartbeats"

    job: Mapped[str] = mapped_column(Text, primary_key=True)
    last_ok_at: Mapped[datetime | None] = mapped_column(Timestamp)
    last_error: Mapped[str | None] = mapped_column(Text)
    last_error_at: Mapped[datetime | None] = mapped_column(Timestamp)


class NewsItem(Base):
    """One headline from a public AI news feed (news/feeds.py; 0016). Shared by every project."""

    __tablename__ = "news_items"
    __table_args__ = (Index("idx_news_published", text("published_at DESC")),)

    item_id: Mapped[str] = mapped_column(Text, primary_key=True)  # hash of the link
    source: Mapped[str] = mapped_column(Text)
    kind: Mapped[str] = mapped_column(Text)  # lab, press or community
    title: Mapped[str] = mapped_column(Text)
    link: Mapped[str] = mapped_column(Text)
    summary: Mapped[str] = mapped_column(Text, server_default=text("''"))  # plain text, never HTML
    published_at: Mapped[datetime] = mapped_column(Timestamp)
    fetched_at: Mapped[datetime] = mapped_column(Timestamp, server_default=NOW)


class PriceVersion(Base):
    """One price a model had for a period. Written by a database trigger, never edited by the app.

    A run keeps the version that priced it (runs.price_version_id), so its cost can be recomputed exactly later
    even after the catalog moves on. These are public list prices, not anyone's negotiated or invoice price."""

    __tablename__ = "price_versions"
    __table_args__ = (
        CheckConstraint("scope IN ('catalog','provider')", name="price_versions_scope_check"),
        CheckConstraint("cache_basis IN ('FAMILY_FACTOR','EXPLICIT')", name="price_versions_cache_basis_check"),
        CheckConstraint("source_kind IN ('SYNC','MANUAL','BACKFILL')", name="price_versions_source_kind_check"),
        Index("uq_price_versions_open", "scope", "model", "model_version", "provider", unique=True,
              postgresql_where=text("effective_to IS NULL")),
    )

    version_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, server_default=NEW_UUID)
    scope: Mapped[str] = mapped_column(Text)
    model: Mapped[str] = mapped_column(Text)
    model_version: Mapped[str] = mapped_column(Text, server_default=text("''"))
    provider: Mapped[str] = mapped_column(Text)
    input_per_mtok: Mapped[Decimal] = mapped_column(Numeric(12, 6))
    output_per_mtok: Mapped[Decimal] = mapped_column(Numeric(12, 6))
    cache_read_per_mtok: Mapped[Decimal | None] = mapped_column(Numeric(12, 6))
    cache_write_5m_per_mtok: Mapped[Decimal | None] = mapped_column(Numeric(12, 6))
    cache_write_1h_per_mtok: Mapped[Decimal | None] = mapped_column(Numeric(12, 6))
    cache_basis: Mapped[str] = mapped_column(Text, server_default=text("'FAMILY_FACTOR'"))
    modifiers: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    effective_from: Mapped[datetime] = mapped_column(Timestamp, server_default=NOW)
    effective_to: Mapped[datetime | None] = mapped_column(Timestamp)
    source_kind: Mapped[str] = mapped_column(Text)
    source_url: Mapped[str | None] = mapped_column(Text)
    checked_at: Mapped[datetime | None] = mapped_column(Timestamp)
    applicability: Mapped[str | None] = mapped_column(Text)


class NoticeSource(Base):
    """One provider page we read for deprecation and shutdown notices, and how the last reading went."""

    __tablename__ = "notice_sources"
    __table_args__ = (
        CheckConstraint("status IN ('NEVER','OK','UNREADABLE','FETCH_FAILED')", name="notice_sources_status_check"),
    )

    source_id: Mapped[str] = mapped_column(Text, primary_key=True)
    name: Mapped[str] = mapped_column(Text)
    provider: Mapped[str] = mapped_column(Text)
    url: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(Text, server_default=text("'NEVER'"))
    last_checked_at: Mapped[datetime | None] = mapped_column(Timestamp)
    last_ok_at: Mapped[datetime | None] = mapped_column(Timestamp)
    detail: Mapped[str | None] = mapped_column(Text)
    notice_count: Mapped[int] = mapped_column(Integer, server_default=text("0"))


class ModelNotice(Base):
    """What a provider's own page says about one model: its status, the date it lists and how it words that date.
    Informational: nothing is ever changed because of a notice."""

    __tablename__ = "model_notices"
    __table_args__ = (
        CheckConstraint("wording IN ('not_sooner_than','tentative','earliest_possible','scheduled')",
                        name="model_notices_wording_check"),
        Index("idx_model_notices_model", "model", postgresql_where=text("listed")),
    )

    notice_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, server_default=NEW_UUID)
    source_id: Mapped[str] = mapped_column(Text, ForeignKey("notice_sources.source_id", ondelete="CASCADE"))
    provider: Mapped[str] = mapped_column(Text)
    model: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(Text)
    notice_date: Mapped[date | None] = mapped_column(Date)
    wording: Mapped[str] = mapped_column(Text)
    deprecated_on: Mapped[date | None] = mapped_column(Date)
    replacement: Mapped[str | None] = mapped_column(Text)
    section: Mapped[str | None] = mapped_column(Text)
    notice_url: Mapped[str] = mapped_column(Text)
    listed: Mapped[bool] = mapped_column(Boolean, server_default=text("true"))
    first_seen_at: Mapped[datetime] = mapped_column(Timestamp, server_default=NOW)
    last_seen_at: Mapped[datetime] = mapped_column(Timestamp, server_default=NOW)
    checked_at: Mapped[datetime] = mapped_column(Timestamp)


class PriceSource(Base):
    """One maker's own pricing page we read: when, and whether it could be read (0028)."""

    __tablename__ = "price_sources"
    __table_args__ = (
        CheckConstraint("status IN ('NEVER','OK','UNREADABLE','FETCH_FAILED')", name="price_sources_status_check"),
    )

    source_id: Mapped[str] = mapped_column(Text, primary_key=True)
    name: Mapped[str] = mapped_column(Text)
    provider: Mapped[str] = mapped_column(Text)
    url: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(Text, server_default=text("'NEVER'"))
    last_checked_at: Mapped[datetime | None] = mapped_column(Timestamp)
    last_ok_at: Mapped[datetime | None] = mapped_column(Timestamp)
    detail: Mapped[str | None] = mapped_column(Text)
    model_count: Mapped[int] = mapped_column(Integer, server_default=text("0"))


class OfficialPrice(Base):
    """The standard price a maker's own page states for a model, as last read. NULL = the page does not state one number."""

    __tablename__ = "official_prices"

    provider: Mapped[str] = mapped_column(Text, primary_key=True)
    model: Mapped[str] = mapped_column(Text, primary_key=True)
    input_per_mtok: Mapped[Decimal | None] = mapped_column(Numeric(12, 6))
    output_per_mtok: Mapped[Decimal | None] = mapped_column(Numeric(12, 6))
    note: Mapped[str | None] = mapped_column(Text)
    read_at: Mapped[datetime] = mapped_column(Timestamp)


class Organisation(Base):
    """A company workspace. A person's personal workspace is implicit: their projects with no organisation (0030)."""

    __tablename__ = "organisations"

    org_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, server_default=NEW_UUID)
    name: Mapped[str] = mapped_column(Text)
    created_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("users.user_id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(Timestamp, server_default=NOW)
    deleted_at: Mapped[datetime | None] = mapped_column(Timestamp)


class Membership(Base):
    """A person in a company, with a role. Leaving or removal ends the row (status 'ended'); it is never reused silently."""

    __tablename__ = "memberships"
    __table_args__ = (
        CheckConstraint("role IN ('owner','admin','member','viewer')", name="memberships_role_check"),
        CheckConstraint("status IN ('active','ended')", name="memberships_status_check"),
        CheckConstraint("ended_reason IN ('left','removed')", name="memberships_ended_reason_check"),
        CheckConstraint("job_role IN ('engineering','product','data_science','operations','support','finance','legal','other')",
                        name="memberships_job_role_check"),
    )

    org_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("organisations.org_id"), primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.user_id", ondelete="CASCADE"), primary_key=True)
    role: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(Text, server_default=text("'active'"))
    ended_reason: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(Timestamp, server_default=NOW)
    joined_at: Mapped[datetime] = mapped_column(Timestamp, server_default=NOW)
    ended_at: Mapped[datetime | None] = mapped_column(Timestamp)
    # Optional, chosen by the person themselves from a fixed list (0031). Never inferred; never used for access.
    job_role: Mapped[str | None] = mapped_column(Text)


class OrgNoticeAck(Base):
    """A person was shown a version of a company's privacy notice. Proof of showing, not a legal consent."""

    __tablename__ = "org_notice_acks"

    org_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("organisations.org_id"), primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.user_id", ondelete="CASCADE"), primary_key=True)
    version: Mapped[str] = mapped_column(Text, primary_key=True)
    acknowledged_at: Mapped[datetime] = mapped_column(Timestamp, server_default=NOW)


class OrgInvite(Base):
    """A single-use, expiring invite for one email address. Only a hash of the token is stored."""

    __tablename__ = "org_invites"
    __table_args__ = (CheckConstraint("role IN ('admin','member','viewer')", name="org_invites_role_check"),)

    invite_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, server_default=NEW_UUID)
    org_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("organisations.org_id"))
    email: Mapped[str] = mapped_column(Text)
    role: Mapped[str] = mapped_column(Text)
    token_hash: Mapped[str] = mapped_column(Text, unique=True)
    created_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("users.user_id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(Timestamp, server_default=NOW)
    expires_at: Mapped[datetime] = mapped_column(Timestamp)
    used_at: Mapped[datetime | None] = mapped_column(Timestamp)
    used_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("users.user_id", ondelete="SET NULL"))
    revoked_at: Mapped[datetime | None] = mapped_column(Timestamp)


class OrgEvent(Base):
    """Who did what in a company. Labels and ids only: never prompt or run text."""

    __tablename__ = "org_events"

    event_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, server_default=NEW_UUID)
    org_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("organisations.org_id"))
    actor_user_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("users.user_id", ondelete="SET NULL"))
    action: Mapped[str] = mapped_column(Text)
    target_user_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("users.user_id", ondelete="SET NULL"))
    detail: Mapped[dict[str, Any]] = mapped_column(JSONB, server_default=text("'{}'::jsonb"))
    at: Mapped[datetime] = mapped_column(Timestamp, server_default=NOW)
