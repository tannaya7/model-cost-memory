"""Request and response models: the API contract the web app is generated from.

FastAPI publishes these as the OpenAPI file (contract/openapi.json) and the frontend generates its
TypeScript types from it, so a change here that breaks a screen fails the frontend build.
Money is returned as a JSON number in US dollars; timestamps are ISO 8601 in UTC.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime
from typing import Literal

from jsonschema import Draft202012Validator
from jsonschema.exceptions import SchemaError
from pydantic import BaseModel, ConfigDict, Field, StrictBool, field_validator, model_validator

CheckKind = Literal["ANSWER_KEY", "TEST_COMMAND", "SCHEMA", "LATE_LABEL"]
Outcome = Literal["PASS", "FAIL", "UNKNOWN"]
RunKind = Literal["PRODUCTION", "SHADOW", "RETEST"]
RunState = Literal["CAPTURED", "CHECKED", "INDEXED", "CONSOLIDATED", "ARCHIVED", "INGESTION_FAILED"]


class Model(BaseModel):
    model_config = ConfigDict(from_attributes=True, protected_namespaces=())


class Health(Model):
    status: Literal["ok"]


class SchedulerHealth(Model):
    status: Literal["ok", "overdue"]
    overdue: dict[str, float | None] = Field(
        description="Jobs with no success within their allowance: minutes since the last success, null if never")


ModelStatus = Literal["ACTIVE", "DEPRECATED", "RETIRED"]


class JobCreate(Model):
    """Define a job and how a correct answer is recognised."""

    name: str = Field(min_length=1, max_length=100, pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]*$",
                      examples=["invoice-extract"])
    description: str | None = Field(default=None, max_length=500)
    check_kind: CheckKind
    check_config: dict = Field(
        default_factory=dict,
        description="ANSWER_KEY: {'fields': [...]}. SCHEMA: {'schema': <JSON Schema>}.",
    )
    retest_consent: bool = Field(
        default=False, description="May this job's prompts be replayed on another provider?"
    )

    @model_validator(mode="after")
    def _config_matches_kind(self) -> JobCreate:
        cfg = self.check_config
        if self.check_kind == "ANSWER_KEY":
            fields = cfg.get("fields")
            if not (isinstance(fields, list) and fields and all(isinstance(f, str) and f for f in fields)):
                raise ValueError("ANSWER_KEY needs check_config.fields: a non-empty list of field names")
        elif self.check_kind == "SCHEMA":
            schema = cfg.get("schema")
            if not isinstance(schema, dict):
                raise ValueError("SCHEMA needs check_config.schema: a JSON Schema object")
            try:
                Draft202012Validator.check_schema(schema)
            except SchemaError as exc:
                raise ValueError(f"check_config.schema is not a valid JSON Schema: {exc.message}") from exc
        elif self.check_kind == "TEST_COMMAND":
            raise ValueError("TEST_COMMAND jobs are not available in this version")
        return self


class JobPatch(Model):
    """Change a job's description. Name and check settings cannot be changed."""

    description: str | None = Field(default=None, max_length=500,
                                    description="Null or an empty string clears it")

    @field_validator("description")
    @classmethod
    def _trim(cls, v: str | None) -> str | None:
        v = v.strip() if v is not None else None
        return v or None


class JobOut(Model):
    job_id: uuid.UUID
    name: str
    description: str | None
    check_kind: CheckKind
    check_config: dict
    retest_consent: bool
    run_count: int = Field(description="All runs recorded for this job")
    runs_by_state: dict[str, int] = Field(
        default_factory=dict, description="Run counts per state, for example {'INDEXED': 40}"
    )


class TaskSummaryOut(Model):
    state: str = Field(description="'ready', 'pending', 'off' (not switched on), 'unavailable' (no AI service "
                                   "configured, or a limit or failure), 'no_samples' (too little stored text) "
                                   "or 'deleted'")
    text: str | None = Field(default=None, description="Two sentences written by an AI; may be wrong")
    consent: bool = Field(description="Whether this project switched the AI summary on")
    service: str = Field(description="The outside AI service sample prompts are sent to when it is on")


class TaskProfileOut(Model):
    """What the recorded calls prove about a task (measured; no AI). Fewer than 25 calls: only `calls`."""

    calls: int = Field(description="Production calls in the window")
    window_days: int
    enough_data: bool
    models: list[str]
    uses_tools: bool
    works_like_agent: str | None = Field(description="'yes', 'probably' or null")
    tool_source: str | None
    multi_agent: bool
    typical_tokens_in: int | None = Field(description="Median input tokens per call, as billed")
    typical_tokens_out: int | None = Field(description="Median output tokens per call, as billed")
    summary: TaskSummaryOut


class TaskSummaryConsentIn(Model):
    enabled: bool


class RunOut(Model):
    """One recorded run, as a table row. Full prompt and output come from the run detail."""

    run_id: uuid.UUID
    job_id: uuid.UUID
    job: str = Field(description="The job's name")
    model: str
    model_version: str
    prompt_version: str | None
    effort: str | None = None
    agent: str | None = Field(default=None, description="Which agent or role made the call, if the SDK said")
    trace_id: str | None = Field(default=None, description="Shared by every call serving the same user task")
    tools_tokens: int | None = Field(default=None, description="Estimated tokens of the tool definitions sent")
    tool_call_count: int | None = Field(default=None, description="Tool calls the response made")
    tokens_in: int
    tokens_out: int
    cache_read_tokens: int
    cache_write_tokens: int
    cost_usd: float | None = Field(description="Null when the model has no catalog price and none was sent")
    latency_ms: int | None
    outcome: Outcome
    outcome_reason: str | None
    run_kind: RunKind
    state: RunState
    created_at: datetime
    prompt_preview: str | None = Field(description="First 240 characters of the prompt, whitespace "
                                                                   "collapsed, ending in an ellipsis when cut; "
                                                                   "null once retention cleared it")
    output_preview: str | None = Field(description="Same for the output")
    content_removed_at: datetime | None = Field(
        default=None, description="When the prompt, output, tool calls and answer key were cleared under the "
                                  "project's retention; the figures are kept")
    importance_score: float = Field(default=1.0, description="How much the run matters (failures and costly runs "
                                                             "more): what decides archiving and re-test sampling")
    weight: float | None = Field(default=None, description="How much it counts in the recommendation now: "
                                                          "e^(-age/S), S shorter once its version is replaced")


class RunPage(Model):
    items: list[RunOut]
    next_cursor: str | None = Field(
        description="Pass as ?cursor= to get the next page; null on the last page"
    )


MAX_TEXT_BYTES = 256 * 1024  # prompts and outputs
MAX_TOKENS = 10_000_000  # one call; larger almost always means a unit error


class RunCreate(Model):
    """One model call, sent by the SDK (or any client) after the production call has finished.

    `run_id` is generated by the sender, so a retried send is recognised as the same run and never
    counted twice. The outcome (pass or fail) is never accepted from the client: it is resolved here.
    """

    run_id: uuid.UUID
    job: str = Field(description="Name of an existing job in this project")
    prompt: str = Field(min_length=1)
    model: str = Field(min_length=1, max_length=200, description="The model the call asked for")
    model_version: str = Field(
        min_length=1, max_length=200, description="The provider-resolved version from the response"
    )
    provider: str | None = Field(
        default=None, max_length=40,
        description="Who served the call, as the price list names it (e.g. openai, gemini, groq, together_ai). "
                    "The same model can cost different amounts on different providers; without it the catalog's "
                    "default price for the model is used",
    )
    prompt_version: str | None = Field(default=None, max_length=64)
    effort: str | None = Field(
        default=None, max_length=20,
        description="The reasoning effort the call asked for (e.g. low, medium, high). The same model at different "
                    "efforts is compared as separate options",
    )
    agent: str | None = Field(default=None, max_length=100, description="Which agent or role made the call")
    trace_id: str | None = Field(default=None, max_length=200,
                                 description="One id shared by every call that serves the same user task")
    tools_tokens: int | None = Field(default=None, ge=0, le=MAX_TOKENS,
                                     description="Estimated tokens of the tool definitions sent with the call")
    tokens_in: int = Field(default=0, ge=0, le=MAX_TOKENS, description="Uncached input tokens")
    tokens_out: int = Field(default=0, ge=0, le=MAX_TOKENS, description="Output tokens, thinking included")
    cache_read_tokens: int = Field(default=0, ge=0, le=MAX_TOKENS)
    cache_write_tokens: int = Field(default=0, ge=0, le=MAX_TOKENS)
    cache_write_1h_tokens: int = Field(
        default=0, ge=0, le=MAX_TOKENS,
        description="The part of cache_write_tokens written to the 1-hour cache (priced higher than the "
                    "5-minute cache). Used for the cost only; not stored",
    )
    cost_usd: float | None = Field(
        default=None, ge=0, le=10_000,
        description="Used only when the model catalog has no price; otherwise the server computes it",
    )
    latency_ms: int | None = Field(default=None, ge=0, le=3_600_000)
    output: str | None = None
    tool_calls: list[dict] | None = Field(
        default=None, max_length=100,
        description="Only each tool's name and call id are kept. Arguments are dropped unless the project has "
                    "opted in to storing them, because they can hold sensitive data.",
    )
    expected: dict | None = Field(
        default=None,
        description="The correct values for an ANSWER_KEY job, used to check this run. Stored only when the job "
                    "has re-test consent, so a re-test can check the replayed run against the same answers",
    )

    @field_validator("prompt", "output")
    @classmethod
    def _within_size_limit(cls, value: str | None) -> str | None:
        if value is not None and len(value.encode("utf8")) > MAX_TEXT_BYTES:
            raise ValueError("must be at most 256 KB")
        return value


class RunDetail(RunOut):
    """One run in full, for the detail panel."""

    prompt: str | None
    output: str | None
    tool_calls: list[dict] | None


class LabelCreate(Model):
    """A late outcome for a run that was stored UNKNOWN."""

    outcome: Literal["PASS", "FAIL"]
    reason: str | None = Field(default=None, max_length=500)


class ModelOut(Model):
    """One model in the catalog."""

    model: str
    model_version: str
    provider: str
    status: ModelStatus = Field(description="RETIRED models are never recommended")
    shutdown_date: date | None = Field(description="Announced shutdown, set while DEPRECATED")
    price_in_per_mtok: float | None = Field(description="US dollars per million input tokens")
    price_out_per_mtok: float | None = Field(description="US dollars per million output tokens")
    source: Literal["SYNC", "MANUAL"] = Field(description="MANUAL rows are overrides the daily sync never changes")
    first_seen_at: datetime
    used_by_project: bool = Field(description="This project has recorded runs on this model")


class ModelPage(Model):
    items: list[ModelOut]
    next_cursor: str | None = Field(description="Pass as ?cursor= for the next page; null on the last page")


class RunAccepted(Model):
    run_id: uuid.UUID
    status: Literal["accepted", "duplicate"] = Field(
        description="'duplicate' means this run_id was already recorded; nothing changed"
    )


Verdict = Literal["HOLD", "DOWNGRADE", "SWITCH", "INSUFFICIENT_EVIDENCE"]
CatalogStatus = Literal["ACTIVE", "DEPRECATED", "RETIRED", "UNKNOWN"]


class ModelRef(Model):
    model: str = Field(description="The model family, without its date suffix")
    model_version: str = Field(description="The version in use now")


class ModelEvidenceOut(ModelRef):
    """What the runs say about one model in this job, and how the tolerance rule judged it."""

    catalog_status: CatalogStatus = Field(description="UNKNOWN when the model is not in the catalog")
    shutdown_date: date | None
    n_runs: int = Field(description="Checked runs counted (PASS or FAIL, not archived)")
    failures: int
    evidence_weight: float = Field(description="Sum of freshness weights; judged once it reaches the floor")
    effective_n: float | None = Field(description="Kish effective sample size of the weighted runs")
    weighted_pass_rate: float | None
    pass_rate_low: float | None = Field(description="Lower end of the pass-rate interval")
    pass_rate_high: float | None = Field(description="Upper end of the pass-rate interval")
    mean_cost_usd: float | None = Field(description="Freshness-weighted mean cost per run; null when unpriced")
    cost_per_success_usd: float | None = Field(description="Mean cost divided by pass rate")
    status: Literal["GOOD_ENOUGH", "UNSURE", "CLEARLY_WORSE", "BELOW_FLOOR", "RETIRED"]
    eligible: bool = Field(description="Good enough, priced and not retired: it can be recommended")
    why: str


class RecommendationRules(Model):
    confidence: float = Field(description="Confidence of the intervals, e.g. 0.95")
    margin: float = Field(description="How much worse (0.03 = 3 points) a cheaper model may be and still qualify")
    evidence_floor: float
    switch_confidence: float = Field(
        description="Confidence needed to advise moving to a cheaper model not advised before, e.g. 0.99")


class FailingRunOut(Model):
    run_id: uuid.UUID
    model: str
    model_version: str
    outcome_reason: str | None
    created_at: datetime


class RecommendationEvidence(Model):
    n_runs: int = Field(description="Checked runs counted across every model")
    evidence_weight: float
    floor: float
    failing_runs: list[FailingRunOut] = Field(
        description="The most recent failures of the recommended and the current model: the receipt"
    )


class PromisingOut(Model):
    """'Worth a trial': a cheaper model that looks close to the model in use but is not proven. Never advice."""

    model: str
    current: str = Field(description="The model in use that it was compared with")
    gap_points: float = Field(description="Observed candidate minus model in use, in percentage points")
    low_points: float = Field(description="Lower end of the range of that gap, in points (one-sided 95% bound)")
    high_points: float = Field(description="Upper end of the range of that gap, in points")
    more_needed: int | None = Field(
        description="About this many more checked answers on the candidate before a switch could be recommended")


class SureEnoughOut(Model):
    """Stage 2 of the progress bar: checked answers per model before a switch could be recommended."""

    needed: int | None = Field(
        description="About this many per model, if today's observed rates held; null when it cannot be told")
    have: float | None = Field(description="What the thinner of the two compared models has now")


class RecommendationOut(Model):
    """The cheapest model that does this job properly, with the evidence behind it."""

    job: str
    verdict: Verdict
    current: ModelRef | None = Field(description="The model production used most recently")
    recommended: ModelRef | None
    reference: str | None = Field(description="The model every other one was compared with")
    rules: RecommendationRules
    models: list[ModelEvidenceOut]
    evidence: RecommendationEvidence
    progress: float = Field(description="Progress toward the evidence floor, 0..1; below 1 only when insufficient")
    retest_candidates: list[str] = Field(
        description="Models a re-test would settle: cheaper ones that could qualify, or the best model when "
                    "the current one measures worse but that is not proven yet")
    forecast: ForecastOut | None = Field(description="Set for DOWNGRADE and SWITCH when both costs are known")
    summary: str | None = Field(
        default=None, description="Optional two sentences written from the figures above; never decides anything")
    summary_prompt_version: str | None = Field(default=None, description="Git blob hash of the prompt file used")
    warnings: list[str]
    next_step: str | None
    computed_at: datetime
    promising: PromisingOut | None = Field(
        default=None, description="Set only for HOLD, never together with a proven model; never counted as a saving")
    sure_enough: SureEnoughOut | None = Field(
        default=None, description="Set for INSUFFICIENT_EVIDENCE when two models can be compared")


class SpendOut(Model):
    job: str
    runs: int = Field(description="Production runs in the window")
    spend_usd: float = Field(description="Priced runs only; see unpriced_runs")
    share: float = Field(description="Share of the project's spend in the window, 0..1")
    unpriced_runs: int = Field(default=0, description="Runs on models with no known price, not in spend_usd")


class ForecastOut(Model):
    """What switching would change per month, if next month looks like the last 30 days."""

    runs_per_month: int = Field(description="Production runs in the last 30 days on the model in use (not the candidate), the volume the saving is priced on")
    monthly_saving_usd: float = Field(description="Change of the monthly bill at the same call volume: runs_per_month x (average cost per call now - on the recommended model). Negative means switching costs more")
    extra_failures_per_month: float = Field(description="Negative means fewer failures")
    extra_failures_low: float = Field(description="Lower end of the interval, in failures per month")
    extra_failures_high: float


SupersessionReason = Literal["NEW_EVIDENCE", "MODEL_UPGRADE", "EVIDENCE_DECAYED", "REGRESSION", "MODEL_RETIRED"]


class HistoryEntryOut(Model):
    """One stored recommendation: what was decided, on how much evidence, and what replaced it."""

    recommendation_id: uuid.UUID
    verdict: Verdict
    model: str = Field(description="The recommended model (the current one for HOLD); empty if none")
    model_version: str
    current_model: str | None = Field(description="What production used when this was decided")
    weighted_pass_rate: float | None
    mean_cost_usd: float | None
    cost_per_success_usd: float | None
    n_runs: int = Field(description="Runs it rests on; GET /v1/runs?recommendation= lists them")
    evidence_weight: float
    valid_at: datetime
    invalid_at: datetime | None = Field(description="Null while it is the current recommendation")
    superseded_by_id: uuid.UUID | None
    supersession_reason: SupersessionReason | None


class ModelVersionSeen(Model):
    model: str
    model_version: str
    runs: int
    first_seen: datetime
    last_seen: datetime


class HistoryOut(Model):
    job: str
    entries: list[HistoryEntryOut] = Field(description="Newest first; the first is current unless invalidated")
    versions: list[ModelVersionSeen] = Field(description="Every model version this job has run on")


AlertKind = Literal["VERSION_REGRESSION", "SILENT_DROP", "MODEL_DEPRECATED", "TOKEN_BURST", "BUDGET", "TRIAL_BUDGET", "MODEL_RETIRING"]


class AlertOut(Model):
    """A regression, silent drop or deprecation that needs a person's attention."""

    alert_id: uuid.UUID
    job: str
    kind: AlertKind
    summary: str = Field(description="One sentence; the figures are in `detail`")
    detail: dict = Field(
        description="VERSION_REGRESSION: model, old_version, new_version, old_pass_rate, new_pass_rate, n_old, "
                    "n_new, drop, p_value, failing_run_ids. SILENT_DROP: model, model_version, before_pass_rate, "
                    "after_pass_rate, n_before, n_after, drop, p_value. MODEL_DEPRECATED: model, model_version, "
                    "status. TOKEN_BURST: tokens_last_hour, usual_tokens_per_hour, top_job, top_job_tokens. BUDGET: "
                    "level (85, 95 or PROJECTED), month, budget_usd, spent_usd, projected_usd. TRIAL_BUDGET: level (85 or 95), month, cap_usd, spent_usd. MODEL_RETIRING: model, "
                    "status, shutdown_date (the earliest possible date: check your provider's notice)."
    )
    created_at: datetime
    delivered_at: datetime | None = Field(description="When the webhook accepted it; null if not (yet)")
    delivery_attempts: int
    delivery_failed_at: datetime | None = Field(
        default=None, description="When webhook delivery gave up after its last retry; saving a new webhook URL "
                                  "tries again. Null while it is delivered or still being tried")
    resolved_at: datetime | None


RetestStatus = Literal["QUEUED", "RUNNING", "DONE", "STOPPED_BUDGET", "STOPPED_CAP", "FAILED"]


class RetestCreate(Model):
    """Replay past runs of this job on a candidate model, spending at most `budget_usd`."""

    candidate_model: str = Field(min_length=1, max_length=200, description="The model name to call")
    budget_usd: float = Field(gt=0, le=1000, description="Required: the re-test stops before going over it")
    sample_size: int | None = Field(default=None, ge=1, le=500, description="Prompts to replay (default 50)")


class RetestOut(Model):
    retest_id: uuid.UUID
    job: str
    candidate_model: str
    trigger: Literal["MANUAL", "NEW_MODEL", "UNSURE", "FIRST_KEY"]
    status: RetestStatus
    budget_usd: float
    spent_usd: float
    runs_planned: int
    runs_done: int
    passed: int
    failed: int
    pass_rate: float | None
    monthly_cap_usd: float
    cap_remaining_usd: float
    message: str | None
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None


class ProviderKeyIn(Model):
    """The key re-tests use. Encrypted at rest; only its last four characters are shown again."""

    provider: str = Field(min_length=2, max_length=40, description="e.g. openai, gemini, groq")
    api_key: str = Field(min_length=8, max_length=500)
    base_url: str | None = Field(default=None, max_length=300, pattern=r"^https?://",
                                 description="An OpenAI-compatible endpoint; known providers fill it in")


class ProviderKeyOut(Model):
    provider: str
    base_url: str
    key_hint: str = Field(description="The key's last four characters")
    created_at: datetime


class RetestLimits(Model):
    monthly_cap_usd: float
    spent_this_month_usd: float = Field(description="At catalog list price, so it counts free keys too")
    cap_remaining_usd: float
    retest_allowed: bool
    provider_key: ProviderKeyOut | None = Field(description="Null until the key is given")


class UserOut(Model):
    user_id: uuid.UUID
    email: str
    name: str | None
    picture_url: str | None
    ui_flags: dict[str, bool] = Field(default_factory=dict, description="First-visit guides this person has seen")


class UiFlagsPatch(Model):
    """Only these two true/false flags can be saved; anything else is refused."""

    model_config = ConfigDict(extra="forbid")

    tour_seen: StrictBool | None = None
    first_results_seen: StrictBool | None = None


class AuthConfig(Model):
    google: bool = Field(description="Google sign-in is configured on this server")
    dev_login: bool = Field(description="Development-only sign-in by email; never on in production")
    demo_project_id: str | None = Field(description="A project anyone may read without signing in")


class DevLogin(Model):
    email: str = Field(min_length=3, max_length=200, pattern=r"^[^@\s]+@[^@\s]+$")
    name: str | None = Field(default=None, max_length=100)


BillingMode = Literal["per_use", "subscription", "both"]


class ProjectOut(Model):
    project_id: str
    slug: str = Field(description="Short readable name used in the web address (/p/production). "
                                  "Stable and unique per owner; the API still takes project_id")
    name: str
    webhook_url: str | None
    webhook_secret: str | None = Field(description="Verify X-MCM-Signature on webhook payloads with it")
    retest_monthly_cap_usd: float
    retest_allowed: bool
    key_prefix: str | None = Field(description="The first characters of the live project key")
    content_retention_days: int = Field(
        default=90, description="Days a run keeps its prompt, output, tool calls and answer key; the figures stay")
    monthly_budget_usd: float | None = Field(
        default=None, description="Optional monthly AI spend budget in USD. Soft: alerts at 85% and 95% of actual "
                                  "spend and when the month is projected to go over; nothing is ever blocked")
    store_tool_arguments: bool = Field(
        default=False, description="Whether this project keeps the inputs of tool calls (off by default; they can "
                                   "hold private data). Used only to notice an agent repeating the same step")
    billing_mode: BillingMode = Field(
        default="per_use", description="How this project pays for AI: per_use (each call costs money), "
                                       "subscription (a flat fee with a usage allowance) or both")
    created_at: datetime


class ProjectCreate(Model):
    name: str = Field(min_length=1, max_length=100)
    billing_mode: BillingMode | None = Field(default=None, description="Optional; defaults to per_use")


class ProjectCreated(Model):
    project: ProjectOut
    api_key: str = Field(description="Shown once. Put it in the SDK as MCM_API_KEY")


class ProjectPatch(Model):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    webhook_url: str | None = Field(default=None, max_length=500, pattern=r"^https://",
                                    description="Must be https; send null to remove")
    retest_monthly_cap_usd: float | None = Field(default=None, ge=0, le=10_000)
    retest_allowed: bool | None = None
    monthly_budget_usd: float | None = Field(
        default=None, gt=0, le=10_000_000, description="Monthly AI spend budget in USD (above 0, up to 10,000,000); "
                                                       "send null to clear")
    content_retention_days: int | None = Field(
        default=None, ge=1, le=3650,
        description="Days a run keeps its prompt, output, tool calls and answer key (1 to 3650)")
    billing_mode: BillingMode | None = Field(
        default=None, description="How you pay for AI: per_use, subscription or both. Changes wording and which "
                                  "alerts fire; no stored figure changes")
    store_tool_arguments: bool | None = Field(
        default=None, description="Keep the inputs of tool calls from now on (true) or stop storing new ones (false). "
                                  "Already-stored inputs stay until deleted or the retention period ends")


class ToolInputsDeleted(Model):
    runs_cleared: int = Field(description="Runs whose stored tool-call inputs were removed")


class ProjectKey(Model):
    api_key: str = Field(description="Shown once; the previous key stops working immediately")


class BreakdownOut(Model):
    model: str
    group: str = Field(description="'all', an input-size band ('under 8k', '8k to 32k', 'over 32k') or a prompt version")
    runs: int
    passed: int
    pass_rate: float
    pass_rate_low: float
    pass_rate_high: float
    mean_cost_usd: float | None = Field(description="Over the group's priced runs; null when none is priced")
    cost_per_success_usd: float | None


class JobInsightsOut(Model):
    """Where a job's money goes and where each model is weak. Groupings and statistics only."""

    job: str
    days: int
    overall: list[BreakdownOut] = Field(description="Cost per success per model")
    by_input_size: list[BreakdownOut]
    by_prompt_version: list[BreakdownOut]


class FlowEventOut(Model):
    """One step of a run through the pipeline, for the live data-flow view."""

    event_id: int = Field(description="Increasing; resume with ?after= or the SSE Last-Event-ID")
    ts: datetime
    run_id: uuid.UUID | None
    stage: Literal["sdk", "api", "check", "index", "consolidate"]
    message: str
    data: dict | None


RecommendationOut.model_rebuild()  # it refers to ForecastOut, defined after it


class UsageLimitIn(Model):
    """A usage limit the project works under. A plan that shows only a percentage is entered as PERCENT
    and kept current with PUT /v1/limits/{limit_id}/used."""

    name: str = Field(min_length=1, max_length=60, description="e.g. Weekly, Session (5h), or one model's limit")
    window_hours: int = Field(gt=0, le=24 * 31, description="5 for a 5-hour session, 168 for a 7-day week")
    resets_at: datetime = Field(description="When the current window ends; later ones follow every window_hours")
    measure: Literal["USD", "TOKENS", "REQUESTS", "PERCENT"] = Field(
        description="USD at list price, TOKENS (all kinds), REQUESTS (calls), or PERCENT for a plan that shows "
                    "only the share used")
    size: float | None = Field(default=None, gt=0, description="The limit in its measure's unit; not for PERCENT")
    model: str | None = Field(default=None, max_length=200, description="Only this model family counts")
    used_percent: float | None = Field(default=None, ge=0, le=100,
                                       description="PERCENT: the share used now, as the plan shows it")

    @model_validator(mode="after")
    def _size_matches_measure(self) -> UsageLimitIn:
        if self.measure != "PERCENT" and self.size is None:
            raise ValueError("size is required unless the measure is PERCENT")
        if self.measure == "PERCENT" and self.size is not None:
            raise ValueError("a PERCENT limit has no size: enter the share used instead")
        return self


class UsedPercentIn(Model):
    used_percent: float = Field(ge=0, le=100, description="The share of the limit used now, as the plan shows it")


class LimitSuggestionOut(Model):
    job: str
    current: str = Field(description="The option the job uses now, e.g. opus-5-5@medium")
    suggested: str | None = Field(description="What to move it to; null when nothing is proven yet")
    share_of_use: float = Field(description="This job's share of the limit's recent use")
    reduction: float = Field(description="Share of the job's use of this limit the move saves (1 = all of it)")
    note: str


class UsageLimitOut(Model):
    limit_id: uuid.UUID
    name: str
    window_hours: int
    measure: Literal["USD", "TOKENS", "REQUESTS", "PERCENT"]
    size: float | None
    model: str | None
    window_start: datetime
    resets_at: datetime = Field(description="The end of the current window")
    used: float | None = Field(description="Used this window, in the measure's unit (list-price dollars for PERCENT)")
    share_used: float | None
    rate_per_hour: float
    hours_to_reset: float
    hours_to_full: float | None = Field(description="Hours until used up at this pace; null if it is not")
    state: Literal["OK", "AT_RISK", "EXHAUSTED", "UNKNOWN"]
    message: str
    suggestions: list[LimitSuggestionOut]
    hours_to_full_after: float | None = Field(description="Hours until used up if the suggestions are followed")
    lasts_after: bool | None = Field(description="Whether following the suggestions makes it last until the reset")


class NewsItemOut(Model):
    item_id: str
    source: str = Field(description="Who published it, e.g. 'OpenAI' or 'Hacker News'")
    kind: Literal["lab", "press", "community"] = Field(
        description="lab: a model maker's own announcement; press: AI reporting; community: blogs and forums")
    title: str
    link: str = Field(description="The story itself (http or https)")
    summary: str = Field(description="Plain text, at most about 400 characters; never HTML")
    published_at: datetime
    affects: list[str] = Field(description="This project's models the story names; empty if none")


class NewsSourceOut(Model):
    source: str
    kind: Literal["lab", "press", "community"]


class NewsOut(Model):
    """The latest AI news, newest first, with the stories that name this project's models marked."""

    items: list[NewsItemOut]
    sources: list[NewsSourceOut] = Field(description="Every feed the news comes from")
    your_models: list[str] = Field(
        description="The models the stories were matched against: the project's from the last 90 days, the "
                    "job's with `job`, or the one `model` asked about")
    updated_at: datetime | None = Field(description="When the feeds were last fetched; null if never")
    next_refresh_at: datetime | None = Field(description="The earliest a refresh fetches again")


class NewsRefreshOut(Model):
    refreshed: bool = Field(description="False when the last fetch was too recent, or every feed failed")
    added: int = Field(description="New stories stored by this refresh")
    failed_sources: list[str]
    updated_at: datetime | None
    next_refresh_at: datetime | None


class DayPointOut(Model):
    day: date
    job: str
    model: str
    runs: int = Field(description="Production runs that day")
    passed: int
    failed: int = Field(description="UNKNOWN runs count in runs but in neither passed nor failed")
    spend_usd: float = Field(description="Priced runs only")
    tokens_in: int = Field(default=0, description="Uncached input tokens, summed over the group's runs")
    tokens_out: int = Field(default=0, description="Output tokens, summed over the group's runs")
    cache_read_tokens: int = Field(default=0, description="Input tokens read from the prompt cache")
    cache_write_tokens: int = Field(default=0, description="Input tokens written to the prompt cache")
    unpriced_runs: int = Field(default=0, description="Runs with no known price (cost unknown): not in spend_usd")
    failed_spend_usd: float = Field(default=0.0, description="Actual cost of the priced runs whose check failed")



class ToolCountOut(Model):
    name: str
    calls: int


class LoopOut(Model):
    step: str = Field(description="What repeated, in words")
    repeats: int = Field(description="Times it repeated within a window of 7 steps")
    cost_usd: float = Field(description="Priced cost of the repeated steps")
    uses_arguments: bool = Field(description="False: matched on tool name and identical prompt, because "
                                             "arguments are not stored")


class AgentUsageOut(Model):
    agent: str = Field(description="The agent or role; runs that named none are 'unlabelled'")
    runs: int
    tokens_in: int
    tokens_out: int
    cache_read_tokens: int
    spend_usd: float = Field(description="Priced runs only")
    share: float = Field(description="Share of the project's total tokens in the window, 0..1")
    models: list[str] = Field(default_factory=list, description="Models this agent called")
    uses_tools: bool = Field(default=False, description="Tool definitions were sent or tool calls made (certain)")
    works_like_agent: str | None = Field(default=None, description="'yes' (calls share a trace id and tool use "
                                         "repeats), 'probably' (no trace id), or null")
    tool_source: str | None = Field(default=None, description="'mcp' only when tool names look like "
                                    "mcp__server__tool; 'tool_list' for other tools; null when none")
    tool_servers: list[str] = Field(default_factory=list, description="Server names read from mcp__server__tool names")
    top_tools: list[ToolCountOut] = Field(default_factory=list, description="Most used tools by name")
    steps_per_task: float | None = Field(default=None, description="Calls per trace id; null without trace ids")


class TraceUsageOut(Model):
    trace_id: str
    calls: int
    tokens: int = Field(description="Input, output and cache tokens over every call in the trace")
    spend_usd: float = Field(description="Priced runs only")
    agents: int = Field(description="Distinct agents in the trace")
    repeated_prompts: bool = Field(description="The same prompt appears 3 or more times in the trace: a likely "
                                               "retry loop or runaway agent")
    agent_names: list[str] = Field(default_factory=list, description="Named agents in the trace")
    multi_agent: bool = Field(default=False, description="More than one distinct named agent shares this trace")
    possible_loop: LoopOut | None = Field(default=None, description="Beta: the same step repeated 5 or more times "
                                          "within 7 steps with no sign of progress")


class ToolsUsageOut(Model):
    job: str
    runs: int = Field(description="Runs that sent tool definitions")
    avg_tools_tokens: int = Field(description="Estimated tokens the tool definitions add to every call")
    share_of_tokens_in: float = Field(description="Of those runs' input tokens (cache included), 0..1")


class UsageKindsOut(Model):
    calls: int = Field(description="Recent production calls the labels were worked out from (at most 5000)")
    uses_tools: bool
    works_like_agent: str | None = Field(description="'yes', 'probably' or null")
    tool_source: str | None = Field(description="'mcp' only for mcp__server__tool names; 'tool_list'; or null")
    tool_servers: list[str]
    multi_agent: bool


class AgentInsightsOut(Model):
    agents: list[AgentUsageOut]
    traces: list[TraceUsageOut] = Field(description="Top 10 traces by total tokens")
    tools: list[ToolsUsageOut]
    kinds: UsageKindsOut


class PromptGroupOut(Model):
    job: str
    prompt_version: str | None = Field(description="Null groups all unversioned calls of the job")
    calls: int
    tokens_in: int
    tokens_out: int
    cache_read_tokens: int
    cache_write_tokens: int
    total_tokens: int = Field(description="tokens_in + tokens_out + cache_read_tokens + cache_write_tokens")
    share: float = Field(description="Of the project's total tokens in the window, 0..1")
    avg_tokens_in: float
    avg_tokens_out: float
    cache_read_share: float | None = Field(description="cache_read / (cache_read + tokens_in); null when both are 0")
    text_samples: int = Field(description="Recent calls with stored prompt text that were compared (at most 50)")
    repeated_start_share: float | None = Field(description="Share of the prompt that starts identically in every call")
    repeated_end_share: float | None = Field(description="Share of the prompt that ends identically in every call")
    repeated_start_preview: str | None = Field(description="First 120 characters of the repeated start")


class PromptsOut(Model):
    days: int
    total_tokens: int
    groups: list[PromptGroupOut]


class PromptVersionOut(Model):
    label: str
    kind: Literal["tagged", "detected", "untagged"]
    first_seen: datetime
    last_seen: datetime
    calls: int
    typical_tokens_in: float = Field(description="Median input tokens per call")
    typical_tokens_out: float = Field(description="Median output tokens per call")
    cache_read_share: float | None = Field(description="cache_read / (cache_read + tokens_in); null when both are 0")
    priced_calls: int
    unpriced_calls: int
    cost_per_call: float | None = Field(description="List-price cost, priced calls only; null when none were priced")
    checked: int = Field(description="Calls whose answer was checked (correct or wrong)")
    correct_rate: float | None = Field(description="Null below 25 checked answers")
    rate_low: float | None
    rate_high: float | None
    start_preview: str | None = Field(description="Detected versions only: the start of the prompt (120 characters)")


class PromptComparisonOut(Model):
    older: str
    newer: str
    side_by_side: bool = Field(description="True when the two versions' time ranges overlap")
    summary: str = Field(description="Facts only; no verdict and no cause")


class PromptVersionsOut(Model):
    job: str
    days: int
    source: Literal["tagged", "detected", "none"]
    reason: Literal["no_calls", "text_not_kept", "no_change", "unstable"] | None
    versions: list[PromptVersionOut]
    comparison: PromptComparisonOut | None
