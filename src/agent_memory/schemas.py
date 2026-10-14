"""Request and response models: the API contract the web app is generated from.

FastAPI publishes these as the OpenAPI file (contract/openapi.json) and the frontend generates its
TypeScript types from it, so a change here that breaks a screen fails the frontend build.
Money is returned as a JSON number in US dollars; timestamps are ISO 8601 in UTC.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

CheckKind = Literal["ANSWER_KEY", "TEST_COMMAND", "SCHEMA", "LATE_LABEL"]
Outcome = Literal["PASS", "FAIL", "UNKNOWN"]
RunKind = Literal["PRODUCTION", "SHADOW", "RETEST"]
RunState = Literal["CAPTURED", "CHECKED", "INDEXED", "CONSOLIDATED", "ARCHIVED", "INGESTION_FAILED"]


class Model(BaseModel):
    model_config = ConfigDict(from_attributes=True, protected_namespaces=())


class Health(Model):
    status: Literal["ok"]


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


class RunOut(Model):
    """One recorded run, as a table row. Full prompt and output come from the run detail."""

    run_id: uuid.UUID
    job_id: uuid.UUID
    job: str = Field(description="The job's name")
    model: str
    model_version: str
    prompt_version: str | None
    tokens_in: int
    tokens_out: int
    cache_read_tokens: int
    cache_write_tokens: int
    cost_usd: float
    latency_ms: int | None
    outcome: Outcome
    outcome_reason: str | None
    run_kind: RunKind
    state: RunState
    created_at: datetime
    prompt_preview: str = Field(description="First 200 characters of the prompt")
    output_preview: str | None = Field(description="First 200 characters of the output")


class RunPage(Model):
    items: list[RunOut]
    next_cursor: str | None = Field(
        description="Pass as ?cursor= to get the next page; null on the last page"
    )
