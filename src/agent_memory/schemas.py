"""Request and response models: the API contract the web app is generated from.

FastAPI publishes these as the OpenAPI file (contract/openapi.json) and the frontend generates its
TypeScript types from it, so a change here that breaks a screen fails the frontend build.
Money is returned as a JSON number in US dollars; timestamps are ISO 8601 in UTC.
"""

from __future__ import annotations

import json
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
    span_id: str | None = Field(default=None, description="This call's own id within its task, if the app sent one")
    parent_span_id: str | None = Field(default=None, description="The span_id of the call that started this one, if the app sent one")
    tools_tokens: int | None = Field(default=None, description="Estimated tokens of the tool definitions sent")
    tool_call_count: int | None = Field(default=None, description="Tool calls the response made")
    tokens_in: int
    tokens_out: int
    cache_read_tokens: int
    cache_write_tokens: int
    usage_shape: str | None = Field(default=None, description="Provider usage layout the SDK read; 'none' = no usage block, counts unknown")
    reasoning_tokens: int | None = Field(default=None, description="Reasoning tokens when reported separately; null = not reported")
    tool_use_input_tokens: int | None = Field(default=None, description="Gemini tool-result input tokens, not priced; null = not reported")
    price_status: str | None = Field(
        default=None,
        description="Why the run is or is not priced: PRICED, PARTLY_PRICED (a price-changing label such as a "
                    "priority tier was reported that is not modelled), CALLER_COST (the cost came from the "
                    "caller), NO_USAGE, or UNPRICED_* (unknown model, price not yet in force, price expired). "
                    "Null = recorded before price versions existed. List prices, not an invoice",
    )
    cost_usd: float | None = Field(description="Null when the model has no catalog price and none was sent, or no usage was reported")
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
    span_id: str | None = Field(default=None, max_length=200, description="This call's own id within its task (optional)")
    parent_span_id: str | None = Field(default=None, max_length=200,
                                       description="The span_id of the call that started this one (optional)")
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
    usage_shape: Literal["anthropic_messages", "openai_responses", "openai_chat", "deepseek_chat", "gemini",
                         "none"] | None = Field(
        default=None,
        description="Which provider usage layout the SDK read. 'none' means the response carried no usage "
                    "block: the token counts are then unknown, not zero. Absent for older SDKs and for counts "
                    "given by hand",
    )
    usage_raw: dict | None = Field(
        default=None,
        description="The provider's usage block reduced to numbers (and the service tier, region and speed "
                    "labels), kept so a figure can be audited later. No prompt or answer text",
    )
    reasoning_tokens: int | None = Field(
        default=None, ge=0, le=MAX_TOKENS,
        description="Reasoning/thinking tokens when the provider reports them separately. Already inside "
                    "tokens_out for OpenAI and DeepSeek, and added into tokens_out for Gemini. Null = not reported",
    )
    tool_use_input_tokens: int | None = Field(
        default=None, ge=0, le=MAX_TOKENS,
        description="Gemini only: tokens of tool results handed back to the model. How they are billed is not "
                    "documented, so they are NOT in tokens_in and NOT priced. Null = not reported",
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

    @field_validator("usage_raw")
    @classmethod
    def _usage_raw_is_small(cls, value: dict | None) -> dict | None:
        if value is not None and len(json.dumps(value, default=str)) > 4096:
            raise ValueError("usage_raw must be at most 4 KB")
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


class ModelReferenceOut(Model):
    """Where a model's price and links come from. Reference information only: no ranking, no benchmark, no claim about how
    the model performs on anyone's work. Unknown is shown as unknown, never guessed."""

    kind: Literal["api_model"] = Field(
        description="Only API models you can call are listed. Coding tools and subscription apps such as Cursor or Copilot "
                    "are not API endpoints, so they are never listed or ranked here")
    maker: str | None = Field(description="Whose own pages the links go to; null when we read none for this model")
    docs_url: str | None = Field(description="The maker's own page about its models")
    pricing_url: str | None = Field(description="The maker's own pricing page")
    deprecations_url: str | None = Field(description="The maker's own deprecation page")
    price_check: Literal["confirmed", "differs", "not_readable", "not_listed", "other_host", "not_checked"] = Field(
        description="The catalog price compared with what the maker's own pricing page states")
    price_check_note: str
    price_checked_at: datetime | None = Field(description="When the maker's pricing page was last read successfully")
    price_check_stale: bool = Field(description="True when that reading is more than 7 days old")
    official_input_per_mtok: float | None = Field(description="What the maker's page states, when it states one number")
    official_output_per_mtok: float | None
    price_basis: str = Field(description="What the price is and is not")
    catalog_source: str = Field(description="Where the catalog's own number comes from")
    catalog_synced_at: datetime | None = Field(description="When the catalog last confirmed this price from its source")


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
    reference: ModelReferenceOut


class PriceSourceOut(Model):
    source_id: str
    name: str
    provider: str
    url: str
    status: Literal["NEVER", "OK", "UNREADABLE", "FETCH_FAILED"]
    last_checked_at: datetime | None
    last_ok_at: datetime | None
    detail: str | None
    model_count: int
    stale: bool = Field(description="Last good reading is more than 7 days old")


class CatalogInfoOut(Model):
    source: str
    last_synced_at: datetime | None = Field(description="When the catalog last confirmed any price from its source")
    note: str


class ModelPage(Model):
    catalog: CatalogInfoOut
    official_sources: list[PriceSourceOut]
    kind_note: str
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


class DifferenceOut(Model):
    """This model's pass rate minus the model in use, with the engine's own Newcombe interval and verdict on it.
    The compare chart draws exactly these numbers; it never recomputes them."""

    against: str = Field(description="The model in use that it is compared with")
    gap_points: float = Field(description="This model minus the model in use, in percentage points")
    low_points: float
    high_points: float
    confidence: float = Field(description="Confidence of the interval: the level a move needs (switch_confidence)")
    margin_points: float = Field(description="How much worse it may be and still qualify, in points")
    status: Literal["GOOD_ENOUGH", "UNSURE", "CLEARLY_WORSE"] = Field(
        description="The tolerance rule applied to this interval: at most margin worse / not yet sure / clearly worse")
    method: Literal["unpaired"] = Field(default="unpaired", description="The models answered different requests")


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
    vs_current: DifferenceOut | None = Field(
        default=None, description="Null for the model in use itself, when there is no model in use, or with no checked answers")
    priced_runs: int | None = Field(default=None, description="Checked runs with a known cost; null when not measured")
    unpriced_runs: int | None = Field(default=None, description="Checked runs whose cost is unknown: not in the cost figures")
    retest_runs: int | None = Field(default=None, description="Checked runs that were re-tests (your own past prompts replayed)")
    cost_p50_usd: float | None = Field(default=None, description="Typical call cost (median), last 60 days, most-used version")
    cost_p90_usd: float | None = Field(default=None, description="Expensive tail: 1 call in 10 costs at least this")


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


class CheckBasisOut(Model):
    """Where pass/fail came from. An LLM judge is not a check: a model-graded label is an opinion, not ground truth."""

    kind: Literal["deterministic", "human_label"] = Field(
        description="deterministic: a fixed rule decided (answer key, format, test command). human_label: reported by the app")
    label: str
    text: str


class PairedOut(Model):
    """The same prompts answered by both models (re-tests replay real prompts), compared as pairs (Newcombe 1998, method 10)."""

    candidate: str
    current: str
    n_prompts: int
    both_passed: int
    only_candidate_passed: int
    only_current_passed: int
    neither_passed: int
    gap_points: float = Field(description="Candidate minus model in use, in percentage points")
    low_points: float
    high_points: float


class RecommendationEvidence(Model):
    n_runs: int = Field(description="Checked runs counted across every model")
    evidence_weight: float
    floor: float
    failing_runs: list[FailingRunOut] = Field(
        description="The most recent failures of the recommended and the current model: the receipt"
    )
    state: Literal["enough", "not_enough", "not_comparable", "no_recommendation"] = Field(
        default="enough", description="Whether the evidence supports an answer. Never a verdict, never a saving")
    state_note: str = Field(default="", description="One plain sentence for the state")
    check: CheckBasisOut | None = Field(default=None, description="What decided pass or fail for this task")
    window_from: datetime | None = Field(default=None, description="First checked answer counted")
    window_to: datetime | None = Field(default=None, description="Last checked answer counted")
    comparison: Literal["unpaired", "paired"] = Field(
        default="unpaired",
        description="unpaired: the models answered different requests (Newcombe two-sample interval, used for the verdict). "
                    "paired: also available for prompts both models answered")
    paired: PairedOut | None = Field(default=None, description="Informational; the verdict uses the unpaired rule")
    limitations: list[str] = Field(default_factory=list, description="What this evidence cannot tell you")


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


AlertKind = Literal["VERSION_REGRESSION", "SILENT_DROP", "MODEL_DEPRECATED", "TOKEN_BURST", "BUDGET", "TRIAL_BUDGET", "MODEL_RETIRING", "MODEL_NOTICE"]


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


class RetestPreviewRequest(Model):
    """Ask what a replay would send, where, and cost, before any paid call. Makes no provider call and changes nothing."""

    candidate_model: str = Field(min_length=1, max_length=200, description="The model name to call")
    budget_usd: float = Field(gt=0, le=1000, description="The replay stops before going over it")
    sample_size: int | None = Field(default=None, ge=1, le=500, description="Prompts to replay (default 50)")


class RetestCreate(RetestPreviewRequest):
    """Replay past runs of this job on a candidate model, spending at most `budget_usd`, after you confirmed a preview."""

    confirmation: str = Field(min_length=20, max_length=2000,
                              description="The single-use confirmation a preview of exactly these values returned")


class PreviewDataRow(Model):
    what: str
    where: str
    kind: Literal["sent", "stays", "never", "received"]


class PreviewCost(Model):
    low_usd: float
    high_usd: float
    worst_case_usd: float
    budget_usd: float
    monthly_cap_remaining_usd: float
    note: str
    estimated_from: str


class PreviewExamples(Model):
    available: int
    planned: int
    left_out_for_tool_use: int = Field(description="Distinct prompts left out because their runs used tools (not replayed in v1)")


class RetestPreviewOut(Model):
    job: str
    candidate_model: str
    budget_usd: float
    sample_size_requested: int
    can_start: bool
    blocked: dict[str, str] | None = Field(description="Why it cannot start: code and message")
    statements: list[str] = Field(description="What will not change: live traffic, source code, your project")
    evaluator_kind: str
    evaluator: str
    provider: str | None = None
    destination_host: str | None = None
    examples: PreviewExamples | None = None
    data: list[PreviewDataRow] = Field(default_factory=list)
    retention_note: str | None = None
    cost: PreviewCost | None = None
    price_basis: dict | None = None
    confirmation: str | None = Field(description="Single use, bound to exactly these values; returned only when it can start")
    expires_at: datetime | None
    confirm_minutes: int


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
    confirmed_at: datetime | None = Field(default=None, description="When a person confirmed the preview. Null for an automatic, opt-in replay")
    provider_host: str | None = None
    evaluator: str | None = Field(default=None, description="ANSWER_KEY or SCHEMA: the task's own check")
    price_basis: dict | None = Field(default=None, description="The list price the cost was worked out from. Not an invoice")
    sample_size: int | None = Field(default=None, description="How many past runs were replayed (their ids are kept, never their text)")
    evidence: Literal["enough", "inconclusive"] | None = Field(default=None)
    evidence_note: str | None = None
    pass_rate_low: float | None = Field(default=None, description="Lower end of the 95% range for the pass rate")
    pass_rate_high: float | None = None


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
    """Only these three true/false flags can be saved; anything else is refused."""

    model_config = ConfigDict(extra="forbid")

    tour_seen: StrictBool | None = None
    first_results_seen: StrictBool | None = None
    welcome_seen: StrictBool | None = None


class AuthConfig(Model):
    google: bool = Field(description="Google sign-in is configured on this server")
    dev_login: bool = Field(description="Development-only sign-in by email; never on in production")
    demo_project_id: str | None = Field(description="A project anyone may read without signing in")


class DevLogin(Model):
    email: str = Field(min_length=3, max_length=200, pattern=r"^[^@\s]+@[^@\s]+$")
    name: str | None = Field(default=None, max_length=100)


BillingMode = Literal["per_use", "subscription", "both"]


CompanyRole = Literal["owner", "admin", "member", "viewer"]


class ProjectOut(Model):
    project_id: str
    organisation_id: uuid.UUID | None = Field(default=None, description="Null for a personal project; the company's id otherwise")
    role: CompanyRole | None = Field(default=None, description="The caller's role here. Below admin, webhook and key details are left out")
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
    budget_timezone: str = Field(
        default="UTC", description="The timezone (an IANA name such as Europe/Berlin) the budget month and its days "
                                   "are counted in")
    budget_alert_levels: list[int] = Field(
        default_factory=lambda: [85, 95], description="Percentages of the monthly budget that raise an in-app alert")
    budget_alert_projected: bool = Field(
        default=True, description="Raise a warning when the low end of the forecast is above the budget")
    budget_alert_webhook: bool = Field(
        default=False, description="Also send budget alerts to the webhook. Off unless the owner turns it on")
    notice_alert_webhook: bool = Field(
        default=False, description="Also send model notices (deprecation and shutdown notices from the providers' own "
                                   "pages) to the webhook. Off unless the owner turns it on")
    auto_retests: bool | None = Field(default=None, description="Automatic paid replays (a new model, an unsure engine, a first key) are on. Off unless an admin turned them on")
    ai_summary_consent: bool = Field(
        default=False, description="The computed figures (never prompts or answers) of recommendations may be sent to an "
                                   "outside AI to write a two-sentence summary. Off unless the owner turns it on")
    ai_summary_host: str | None = Field(
        default=None, description="The service the figures would go to, or null when this server has no summary service")
    created_at: datetime


class ProjectCreate(Model):
    name: str = Field(min_length=1, max_length=100)
    billing_mode: BillingMode | None = Field(default=None, description="Optional; defaults to per_use")
    organisation_id: uuid.UUID | None = Field(
        default=None, description="Create it in this company instead of your personal workspace (needs the member role or higher)")


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
    budget_timezone: str | None = Field(
        default=None, max_length=64, description="An IANA timezone name, for example Europe/Berlin. The budget month "
                                                 "and its days are counted in it")
    budget_alert_levels: list[int] | None = Field(
        default=None, max_length=6, description="Percentages (1 to 100, at most 6) of the budget that raise an in-app alert")
    budget_alert_projected: bool | None = Field(
        default=None, description="Raise a warning when even the low end of the forecast is above the budget")
    budget_alert_webhook: bool | None = Field(
        default=None, description="Also send budget alerts to your webhook (needs a webhook address). Off by default")
    notice_alert_webhook: bool | None = Field(
        default=None, description="Also send model notices to your webhook (needs a webhook address). Off by default")
    auto_retests: bool | None = Field(default=None, description="Turn automatic paid replays on or off. They are off unless an admin turns them on")
    ai_summary_consent: bool | None = Field(
        default=None, description="Allow the computed figures of recommendations to be sent to an outside AI for a summary. Off by default")

    @field_validator("budget_alert_levels")
    @classmethod
    def _levels_in_range(cls, value: list[int] | None) -> list[int] | None:
        if value is None:
            return None
        if any(not 1 <= v <= 100 for v in value) or len(set(value)) != len(value):
            raise ValueError("levels must be different whole numbers from 1 to 100")
        return sorted(value)


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


class TokenPartOut(Model):
    key: str = Field(description="input, cached_input, cache_write, output, reasoning or tool_use_input")
    label: str
    tokens: int | None = Field(description="Null when not known: see state. Never a silent zero")
    state: Literal["measured", "not_reported", "unknown"] = Field(
        description="measured: the provider reported it. not_reported: no provider layout seen in this group can "
                    "report it. unknown: calls recorded before the usage ledger, or whose usage block was missing")
    calls: int | None = Field(description="How many calls reported it, where that is known")
    note: str | None = None


class PromptGroupOut(Model):
    label: str = Field(default="", description="What this row is: a task and version, a task, an agent or a version")
    group_by: Literal["task_version", "task", "agent", "prompt_version", "template"] = "task_version"
    job: str = Field(description="The task's name; empty when the grouping spans tasks")
    prompt_version: str | None = Field(description="Null groups all unversioned calls of the job")
    agent: str | None = Field(default=None, description="The agent name your code sent, when grouped by agent")
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
    breakdown: list[TokenPartOut] = Field(
        default_factory=list, description="What the total is made of, each part measured, not reported, or unknown")
    ledger_calls: int = Field(default=0, description="Calls whose provider usage layout was recorded")
    no_usage_calls: int = Field(default=0, description="Calls whose response carried no usage block (tokens unknown)")
    legacy_calls: int = Field(default=0, description="Calls recorded before the usage ledger existed")
    text_calls: int = Field(default=0, description="Calls in the period whose prompt text is still stored")
    text_samples: int = Field(description="Newest calls with stored prompt text that were compared (at most 50). An estimate")
    text_note: str | None = Field(default=None, description="Why the repeated-text split is missing, when it is")
    spend_usd: float | None = Field(
        default=None, description="List-price cost of the priced calls in this row. Null when none is priced: an unknown, never 0. Not an invoice")
    priced_calls: int = Field(default=0, description="Calls in this row with a known cost")
    unpriced_calls: int = Field(default=0, description="Calls in this row with no known cost: in no sum")
    cost_share: float | None = Field(default=None, description="Of the project's priced cost in the period, 0..1; null when that is 0")
    grouping_basis: Literal["named_by_your_code", "untagged"] = Field(
        default="named_by_your_code",
        description="untagged: the calls carry no version or agent label, so this grouping is an estimate. "
                    "No prompt text and no fingerprint of it is used to group")
    repeated_start_share: float | None = Field(description="Estimated share of the prompt that starts identically in every sampled call")
    repeated_end_share: float | None = Field(description="Estimated share of the prompt that ends identically in every sampled call")
    repeated_start_preview: str | None = Field(
        description="Masked first 120 characters of the repeated start. Only returned when show_text=true; null otherwise")


class PromptsOut(Model):
    days: int
    total_tokens: int = Field(description="Billed tokens of every production call in the period (not a sample)")
    groups: list[PromptGroupOut]
    period_start: datetime | None = None
    period_end: datetime | None = None
    timezone: str = "UTC"
    total_calls: int = Field(default=0, description="Production calls in the period, all groups")
    group_by: Literal["task_version", "task", "agent", "prompt_version", "template"] = "task_version"
    grouping_note: str = ""


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


class CostPerSuccessOut(Model):
    value_usd: float | None = Field(description="Cost of one correct answer; null when it cannot be worked out (see reason)")
    formula: str
    spend_usd: float = Field(description="Cost of the priced, checked calls: the top of the division")
    passed: int = Field(description="Passes among those same calls: the bottom of the division")
    checked_priced_runs: int
    checked_unpriced_runs: int = Field(description="Checked calls left out because their cost is unknown")
    unchecked_runs: int = Field(description="Calls left out because they have no pass/fail result yet")
    reason: str | None
    success_definition: str = Field(description="What a correct answer means for this task, from how it is checked")


class PriceVersionUsedOut(Model):
    version_id: str
    model: str
    provider: str
    input_per_mtok: float
    output_per_mtok: float
    effective_from: datetime
    effective_to: datetime | None
    source_kind: str = Field(description="SYNC, MANUAL (entered by hand) or BACKFILL (the price when versions began)")
    source_url: str | None
    checked_at: datetime | None = Field(description="When the price was last looked at; null for a hand-entered price")
    applicability: str | None
    runs: int
    spend_usd: float


class CostBasisOut(Model):
    status: str
    label: str
    runs: int
    spend_usd: float | None = Field(description="Null for runs with no known cost: an unknown, never zero")


class JobReceiptOut(Model):
    job: str
    runs: int
    passed: int
    failed: int
    unchecked: int
    excluded: int
    spend_usd: float
    unpriced_runs: int
    cost_per_success: CostPerSuccessOut


class CostReceiptOut(Model):
    """How a spend figure was worked out: currency, period, which calls were counted and which were left out,
    the dated list prices used, and a cost per correct answer with its formula. List prices, not an invoice."""

    currency: str
    timezone: str
    period_start: datetime
    period_end: datetime
    period_days: int
    runs: int
    passed: int
    failed: int
    unchecked: int = Field(description="Calls with no pass/fail result yet")
    excluded: int = Field(description="Calls left out of the checks (archived, or the answer was invalidated)")
    spend_usd: float = Field(description="Priced calls only; see unpriced_runs")
    spend_on_failed_checks_usd: float = Field(description="Cost of calls whose check failed; a check can be a deliberate test")
    unpriced_runs: int
    unpriced_note: str | None
    partly_priced_runs: int
    basis: list[CostBasisOut]
    price_versions: list[PriceVersionUsedOut]
    price_versions_checked_at: datetime | None
    price_versions_oldest_effective: datetime | None
    cost_per_success: CostPerSuccessOut | None
    jobs: list[JobReceiptOut]
    notes: list[str]


class ProjectionDayOut(Model):
    day: date
    spend_usd: float = Field(description="Priced spend on that full local day")


class ProjectionOut(Model):
    """The month's spend so far (a fact about recorded calls) and a forecast for the month's end (an estimate), kept
    apart. Alert-only: nothing is ever blocked. List prices in US dollars, not an invoice."""

    state: Literal["ok", "not_enough_history", "paused", "no_spend"]
    reason: Literal["too_new", "sparse", "no_recent_calls"] | None = Field(
        description="Why there is no forecast: too_new (under 7 full days of history), sparse (priced spend on fewer "
                    "than 5 of the last 7 days) or no_recent_calls (nothing recorded for 48 hours)")
    currency: str
    timezone: str = Field(description="The timezone the month and its days are counted in")
    month: str = Field(description="The calendar month, for example 2028-02")
    period_start: datetime = Field(description="First moment of the month, as UTC")
    period_end: datetime = Field(description="First moment of the next month, as UTC")
    first_day: date
    last_day: date
    days_in_month: int
    day_of_month: int
    days_left: float = Field(description="Days still to come, the rest of today included as a fraction")
    actual_usd: float = Field(description="Spent so far this month on calls with a known price. A fact, not a forecast")
    unpriced_runs: int = Field(description="Calls this month with no known price: in no figure here, never counted as free")
    projected_low_usd: float | None = Field(description="Forecast, low end. Null when there is no forecast")
    projected_likely_usd: float | None
    projected_high_usd: float | None
    history_days: int = Field(description="Full days since the first priced call")
    active_days: int = Field(description="Of the last 7 full days, how many had priced spend")
    recent_days: list[ProjectionDayOut]
    data_through: datetime | None = Field(description="When the newest call was recorded")
    budget_usd: float | None
    used_share: float | None = Field(description="actual_usd divided by the budget")
    vs_budget: Literal["over", "may_go_over", "under"] | None = Field(
        description="over: even the low end of the forecast is above the budget (this is what the warning needs). "
                    "may_go_over: only the high end is. under: the whole range is below")
    rule: str = Field(description="The forecast rule in plain words")
    data_note: str = Field(description="What the figures count and what can be missing or late")


class NoticeOut(Model):
    """What a provider's own page says about a model this project uses. Information only: nothing is changed."""

    notice_id: uuid.UUID
    provider: str
    provider_name: str
    model: str = Field(description="The provider's own model id: matched exactly, never by family")
    status: str = Field(description="The provider's own word for it: Active, Deprecated, Retired, Scheduled or Shutdown")
    listed_date: date | None = Field(description="The date the page lists, as the provider wrote it; null when it lists none")
    date_wording: Literal["not_sooner_than", "tentative", "earliest_possible", "scheduled"] = Field(
        description="How the provider words that date: a notice with 'earliest possible' or 'not sooner than' is "
                    "never a promised date")
    deprecated_on: date | None
    replacement: str | None = Field(description="What the provider lists as a replacement. Informational: we never switch anything")
    section: str | None
    notice_url: str = Field(description="The exact section of the provider's page that holds the notice")
    source_name: str
    checked_at: datetime = Field(description="When our reading of that page last succeeded")
    text: str = Field(description="The notice in the provider's own terms, as one sentence")
    served_by_known: bool = Field(description="True when the project's calls name this provider; false when they name none, so a partner platform cannot be ruled out")
    stale_note: str | None = Field(description="Set when the reading is more than 7 days old")
    informational: bool = True


class NoticeElsewhereOut(Model):
    model: str
    provider_name: str
    notice_url: str


class NoticeSourceOut(Model):
    source_id: str
    name: str
    provider: str
    url: str
    status: Literal["NEVER", "OK", "UNREADABLE", "FETCH_FAILED"] = Field(
        description="NEVER: not read yet. UNREADABLE: fetched but nothing could be read (its layout may have changed). "
                    "FETCH_FAILED: the page could not be fetched. Notices from a source never read are not shown")
    last_checked_at: datetime | None
    last_ok_at: datetime | None = Field(description="When it was last read successfully: the checked-at date of its notices")
    detail: str | None
    notice_count: int
    stale: bool = Field(description="True when the last good reading is more than 7 days old")
    covers: str = Field(description="What the page says about other platforms, such as cloud partners, whose dates can differ")


class NoticesOut(Model):
    notices: list[NoticeOut]
    hosted_elsewhere: list[NoticeElsewhereOut] = Field(
        description="Notices about models this project runs, not applied because its calls name another host, which sets its own dates")
    sources: list[NoticeSourceOut]
    note: str



class ChangePeriodOut(Model):
    start: date = Field(description="First whole UTC day of the period")
    end: date = Field(description="The day after the last whole day (exclusive); today is never included")
    days: int
    calls: int
    tokens_in: int
    tokens_out: int
    cache_read_tokens: int
    priced_calls: int
    spend_usd: float | None = Field(description="Spend on priced calls; null on a subscription project, which has no dollar figures")
    calls_with_usage: int = Field(description="Calls that report token counts; the rest are left out of the token figures")
    calls_with_task_id: int = Field(description="Calls that carry a task id; only these can show a repeated call")
    days_with_calls: int


class ObservationOut(Model):
    """A measured difference. It says what changed, never why."""

    key: str
    label: str
    unit: Literal["count", "tokens", "share", "usd"]
    before: float | None = Field(description="Null when not measurable in the earlier period")
    after: float | None
    change: float | None = Field(description="after minus before; for a share, in percentage points")
    change_pct: float | None = Field(description="Null for a share, and when the earlier period is too small for a percentage")
    size: Literal["notable", "small", "unknown"] = Field(
        description="notable: at least 20% (5 points for a share) with enough calls. unknown: too few calls to say")
    note: str | None = None


class MixRowOut(Model):
    name: str
    before_share: float | None = Field(description="Share of calls, percent")
    after_share: float | None
    change_points: float | None
    calls_before: int
    calls_after: int


class SplitOut(Model):
    """A total change split exactly into parts that add up to it."""

    what: Literal["spend_usd", "tokens"]
    total_change: float
    from_calls: float = Field(description="More or fewer calls, at the earlier average per call")
    from_mix: float = Field(description="Calls moving between models, plus models that are new in this period")
    from_per_call: float = Field(description="A call costing or weighing more or less on a model that ran in both periods")


class ContextEventOut(Model):
    """Something the product recorded in the window. It is never a cause."""

    kind: Literal["prompt_version", "new_model", "price_change"]
    on: date
    label: str
    link: Literal["same_time", "concentrated"] = Field(
        description="same_time: it happened in the same period. concentrated: the calls on it differ in the same direction "
                    "as the overall change. Neither shows it caused the change")
    evidence: str | None
    relates_to: list[str] = Field(description="Which observations it coincides with")


class ChangesOut(Model):
    days: int
    mode: Literal["per_use", "subscription", "both"]
    comparable: bool = Field(description="False when either period has too few calls for a percentage change")
    current: ChangePeriodOut
    previous: ChangePeriodOut
    observations: list[ObservationOut]
    model_mix: list[MixRowOut]
    task_mix: list[MixRowOut]
    splits: list[SplitOut]
    events: list[ContextEventOut]
    notes: list[str] = Field(description="Coverage and missing data, in plain words")
    not_recorded: list[str] = Field(description="Kinds of change this cannot see")
    basis: str = Field(description="What these figures are and are not")


class McpToolOut(Model):
    name: str
    calls: int


class McpServerOut(Model):
    """One tool server. Counts are exact; usage is the whole request's, shared with everything in it, never the tool's own."""

    server: str
    certainty: Literal["provider_reported", "likely", "mixed"] = Field(
        description="provider_reported: the provider's own response named the server. likely: only a tool name looks like "
                    "mcp__server__tool (a hint, not proof). mixed: both")
    calls: int
    failed_calls: int = Field(description="Calls the provider said failed; only calls whose result told us are included")
    failure_known_calls: int = Field(description="Calls whose result said whether they failed")
    requests: int = Field(description="Distinct requests that made at least one call to this server")
    task_runs: int = Field(description="Distinct task runs (trace ids) among those requests")
    first_seen: datetime
    last_seen: datetime
    request_time_ms: float | None = Field(description="Median time of those requests. A tool call's own duration is not reported")
    request_tokens_in: int = Field(description="Input tokens of those whole requests, not of the tool")
    request_tokens_out: int
    request_cache_read_tokens: int
    request_cost_usd: float | None = Field(description="Recorded cost of those whole requests (priced ones); null on a subscription project")
    unpriced_requests: int
    tools: list[McpToolOut]
    tasks: list[McpToolOut] = Field(description="AI tasks the calls came from, with their call counts")
    providers: list[str]


class McpTotalsOut(Model):
    requests: int = Field(description="Distinct requests that called any MCP server: each counted once")
    requests_with_several_servers: int = Field(description="Requests shared between servers, so the rows add up to more than this")
    tokens_in: int
    tokens_out: int
    cache_read_tokens: int
    cost_usd: float | None
    unpriced_requests: int


class McpOwnToolsOut(Model):
    calls: int
    requests: int
    tools: list[McpToolOut]


class McpSupportOut(Model):
    """What a provider tells us about MCP calls, and what stays unsupported or unknown."""

    key: str
    label: str
    native: Literal["supported", "partly", "unknown"]
    seen_as: str
    we_read: list[str]
    we_do_not_read: list[str]
    not_reported_by_provider: list[str]
    limits: list[str]
    sources: list[str]
    checked_on: str


class ToolServersOut(Model):
    days: int
    since: datetime
    until: datetime
    job: str | None
    mode: Literal["per_use", "subscription", "both"]
    servers: list[McpServerOut]
    own_tools: McpOwnToolsOut = Field(description="Tool calls that are not from an MCP server we can recognise")
    totals: McpTotalsOut
    support: list[McpSupportOut]
    unreadable_calls: int
    truncated: bool
    notes: list[str]
    method: list[str] = Field(description="How each figure is worked out, and what is not attributed")
    tool_list_size: Literal["unknown"] = Field(
        default="unknown", description="The share of a request's input spent on one server's tool definitions is not measurable: "
                                       "providers load the tool list and report one usage total")


class TaskTotalsOut(Model):
    calls: int
    tokens: int
    cost_usd: float | None = Field(description="Priced calls only; null when none is priced and on a subscription project")
    unpriced_calls: int


class TaskNodeOut(Model):
    """One recorded call in a task, in display order. Totals count each call once: `own` is this call, `subtree` adds its children."""

    run_id: uuid.UUID
    parent_run_id: uuid.UUID | None = Field(description="The recorded call this one sits under; null for a root, an unlinked or an unstructured call")
    depth: int
    section: Literal["tree", "unlinked", "no_structure"]
    link: Literal["root", "child", "unlinked", "no_structure"]
    reason: str | None = Field(description="Why a call is unlinked")
    missing_parent: str | None = Field(description="The parent span id that matched no recorded call")
    duplicate_span: bool = Field(description="Another call in this task has the same span id")
    child_count: int
    agent: str | None
    model: str
    job: str
    span_id: str | None
    parent_span_id: str | None
    started_at: datetime
    latency_ms: int | None
    tools: list[str]
    own: TaskTotalsOut
    subtree: TaskTotalsOut


class RepeatedCallItemOut(Model):
    run_id: uuid.UUID
    at: datetime
    gap_seconds: float | None = Field(description="Seconds since the previous call of the same kind")
    cost_usd: float | None
    tokens: int
    agent: str | None
    model: str
    failed: bool | None = Field(description="Recorded as failed; null when not recorded")
    in_window: bool = Field(description="Inside the stretch that reached the threshold")


class RepeatedCallOut(Model):
    """A possible repeated call. Never a verdict: polling and retries repeat on purpose."""

    label: Literal["possible_repeated_call"] = "possible_repeated_call"
    step: str
    basis: Literal["arguments", "prompt"] = Field(description="What 'the same' was compared on")
    repeats: int = Field(description="Times in the whole task")
    in_window: int = Field(description="Times in the stretch that reached the threshold")
    threshold: int
    window: int
    calls: list[RepeatedCallItemOut]
    median_gap_seconds: float | None
    results_stored: bool
    distinct_results: int | None
    failed_calls: int
    cost_usd: float | None = Field(description="Recorded cost of these calls; not a claim that it was wasted")
    hints: list[str]


class TaskStructureOut(Model):
    roots: int
    linked_children: int
    unlinked: int = Field(description="Calls whose parent was not recorded, is themselves, or forms a cycle")
    no_structure: int = Field(description="Calls that sent no span ids")


class AgentTaskOut(Model):
    trace_id: str
    jobs: list[str]
    agents: list[str]
    models: list[str]
    first_at: datetime
    last_at: datetime
    totals: TaskTotalsOut
    structure: TaskStructureOut
    nodes: list[TaskNodeOut]
    repeated: RepeatedCallOut | None
    notes: list[str]
    truncated: bool
    method: list[str]


class AgentTaskSummaryOut(Model):
    trace_id: str
    jobs: list[str]
    agents: list[str]
    models: list[str]
    first_at: datetime
    last_at: datetime
    totals: TaskTotalsOut
    structure: TaskStructureOut
    repeated_step: str | None = Field(description="What possibly repeated, when a possible repeated call was found at the chosen threshold")
    repeated_times: int | None
    notes: list[str]


class SpreadOut(Model):
    tasks: int
    median: float
    p25: float
    p75: float


class CohortSideOut(Model):
    tokens: SpreadOut
    cost_usd: SpreadOut | None


class CohortOut(Model):
    """Equivalent tasks only: the same AI task and the same models. Measured medians in this project, never a multiplier."""

    job: str
    models: list[str]
    single_agent: CohortSideOut
    multi_agent: CohortSideOut


class AgentTasksOut(Model):
    days: int
    repeats: int
    window: int
    mode: Literal["per_use", "subscription", "both"]
    repeat_choices: list[int]
    window_choices: list[int]
    min_cohort: int
    tasks: list[AgentTaskSummaryOut]
    cohorts: list[CohortOut]
    notes: list[str]
    method: list[str]


_EMAIL = r"^[^@\s]+@[^@\s]+\.[^@\s]+$"


class WorkspaceOut(Model):
    kind: Literal["personal", "company"]
    org_id: uuid.UUID | None = Field(description="Null for the personal workspace")
    name: str
    role: CompanyRole = Field(description="Always owner in your own personal workspace")
    project_count: int
    member_count: int


class OrgCreate(Model):
    name: str = Field(min_length=1, max_length=80)


class OrgOut(Model):
    org_id: uuid.UUID
    name: str
    role: CompanyRole


class EventOut(Model):
    event_id: uuid.UUID
    action: str
    actor: str | None
    target: str | None
    detail: dict
    at: datetime


class MemberOut(Model):
    user_id: uuid.UUID
    email: str | None = Field(description="Only admins and owners see addresses")
    name: str | None
    role: CompanyRole
    joined_at: datetime


class MemberRolePatch(Model):
    role: CompanyRole


class InviteCreate(Model):
    email: str = Field(max_length=254, pattern=_EMAIL)
    role: Literal["admin", "member", "viewer"] = "member"


class InviteOut(Model):
    invite_id: uuid.UUID
    email: str
    role: Literal["admin", "member", "viewer"]
    state: Literal["pending", "used", "expired", "withdrawn"]
    created_at: datetime
    expires_at: datetime


class InviteCreated(Model):
    invite: InviteOut
    token: str = Field(description="Shown once; only a hash is stored")
    link: str = Field(description="Path to send the person to. No email is sent for you")


class InviteAccept(Model):
    token: str = Field(min_length=20, max_length=200)


class CompanyProjectRow(Model):
    project_id: str
    slug: str
    name: str
    pay_mode: Literal["per_use", "subscription", "both"]
    calls: int
    tokens: int
    cost_usd: float | None = Field(description="List-price calculation, not an invoice. Null for flat-plan projects")
    cost_kind: Literal["billable_list_price", "list_price_may_include_flat_plan", "none_flat_plan"]
    unpriced_calls: int = Field(description="Calls with no known price: their cost is unknown, never counted as free")
    calls_reporting_tokens: int


class CompanyTaskRow(Model):
    project: str | None
    project_id: str | None
    task: str = Field(description="Chosen by the calling app: a caller-supplied label, not a verified identity")
    calls: int
    tokens: int
    cost_usd: float | None
    unpriced_calls: int
    pay_mode: Literal["per_use", "subscription", "both"] | None
    label_source: Literal["caller_supplied"]
    folded_groups: int | None = Field(default=None, description="How many small groups an 'Other' row stands for")


class CompanyModelRow(Model):
    model: str
    calls: int
    tokens: int
    cost_usd: float
    unpriced_calls: int
    flat_plan_calls: int
    label_source: Literal["caller_supplied"]


class CompanyDay(Model):
    day: date
    calls: int
    tokens: int
    billable_usd: float = Field(description="Pay-per-use projects only")


class AttributionRow(Model):
    dimension: Literal["project", "task", "model", "agent", "task_trace", "person"]
    source: Literal["verified", "caller_supplied", "not_recorded"]
    detail: str
    coverage_share: float | None


class CompanyModeRow(Model):
    projects: int
    calls: int
    tokens: int
    usd: float | None
    unpriced_calls: int


class CompanyTotals(Model):
    calls: int = Field(description="Counted")
    tokens: int = Field(description="Counted, from calls that report token counts")
    billable_usd: float = Field(description="Pay-per-use projects only. Calculated at list price, not an invoice")
    billable_basis: str
    mixed_mode_usd: float = Field(description="List-price dollars of mixed-mode projects, kept apart from the billable total")
    unpriced_calls: int = Field(description="Calls whose price is unknown: their cost is not counted, not treated as free")
    has_data: bool


class CompanyCoverage(Model):
    calls: int
    calls_reporting_tokens: int
    calls_without_token_counts: int
    token_report_share: float | None
    calls_in_money_projects: int
    calls_priced: int
    calls_with_task_id: int
    calls_with_agent_label: int
    task_id_share: float | None
    agent_label_share: float | None


class CompanyOverviewOut(Model):
    org_id: uuid.UUID
    name: str
    days: int
    since: datetime
    until: datetime
    your_role: CompanyRole
    projects_shown: int = Field(description="Projects your role may open. Others are not counted or hinted at")
    members: int = Field(description="A count only. No person is listed and no per-person figure exists")
    totals: CompanyTotals
    by_mode: dict[str, CompanyModeRow]
    coverage: CompanyCoverage
    projects: list[CompanyProjectRow]
    trend: list[CompanyDay]
    tasks: list[CompanyTaskRow]
    models: list[CompanyModelRow]
    attribution: list[AttributionRow]
    chargeback_grade: Literal[False] = False
    notes: list[str]


JobRole = Literal["engineering", "product", "data_science", "operations", "support", "finance", "legal", "other"]


class NoticeSection(Model):
    heading: str
    body: list[str]


class CompanyNoticeOut(Model):
    version: str
    sections: list[NoticeSection]
    min_group_size: int = Field(description="Smallest group any rollup shows. Our design choice, not a standard")
    acknowledged: bool = Field(description="Whether you were shown this version and recorded it. Not a consent")
    acknowledged_at: datetime | None
    required_for_access: Literal[False] = Field(default=False, description="Access never depends on acknowledging")
    status_counts: dict[str, int] | None = Field(description="Admins only: how many acknowledged, as counts")


class NoticeAck(Model):
    version: str = Field(max_length=100)


class YouInCompany(Model):
    role: CompanyRole
    job_role: JobRole | None
    job_roles: dict[str, str] = Field(description="The fixed list you can choose from")
    notice_version: str
    notice_acknowledged: bool


class JobRolePut(Model):
    job_role: JobRole | None = Field(description="Your own optional job role from the fixed list, or null to clear it")


class RollupGroup(Model):
    job_role: JobRole
    label: str
    members: int


class RollupOut(Model):
    min_group_size: int
    members: int
    shown: bool
    groups: list[RollupGroup]
    not_shown: int = Field(description="Members in groups too small to show, or who chose no role, together")
    reason: str
    declared_share: float | None = None
    usage_by_role: None = Field(description="Always null: usage or cost by role is not available")
    usage_by_role_note: str


SavingsStatus = Literal["waiting", "not_enough_data", "saving", "no_clear_change", "cost_up", "less_correct"]


class SavingsRealized(Model):
    """The observed change in cost per correct answer since a model change. Can be negative. Not an estimate of anything else."""

    metric: str
    unit: Literal["usd", "tokens"]
    unit_words: str
    before: float | None
    after: float | None
    change: float | None = Field(description="Before minus after, per correct answer. Positive = cheaper now; negative = it went up")
    range_low: float | None
    range_high: float | None
    range_note: str
    pass_rate_before: float
    pass_rate_after: float
    pass_rate_change_low: float
    pass_rate_change_high: float
    checked_before: int
    checked_after: int
    correct_before: int
    correct_after: int
    price_basis: str
    mix_compared: str


class SavingsEstimated(Model):
    """A counterfactual. Never added to anything, never shown without its assumptions."""

    label: str
    unit: Literal["usd", "tokens"]
    correct_answers: int
    point: float | None
    low: float | None
    high: float | None
    what: str
    assumptions: list[str]


class SavingsEntry(Model):
    job: str
    from_model: str
    to_model: str
    switch_date: date
    status: SavingsStatus
    reason: str | None
    reasons: list[str]
    window: dict | None = Field(description="The equal periods compared: days and the before and after date ranges")
    realized: SavingsRealized | None
    estimated_avoided: SavingsEstimated | None
    data_notes: list[str]
    progress: dict[str, int] | None
    coverage: dict[str, int] | None


class SavingsTotal(Model):
    label: str
    unit: Literal["usd", "tokens"]
    point: float
    low: float
    high: float
    entries: int


class SavingsOut(Model):
    mode: Literal["per_use", "subscription", "both"]
    unit: Literal["usd", "tokens"]
    as_of: date = Field(description="Only completed days are used, so the answer does not change as today fills up")
    jobs_checked: int
    entries: list[SavingsEntry]
    counts: dict[str, int]
    estimated_avoided_total: SavingsTotal | None = Field(description="The estimated counterfactuals added up. Separate from everything realized")
    notes: list[str]
    method: list[str]

