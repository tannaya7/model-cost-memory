"""Preview and confirmation for a paid replay.

A replay sends real past prompts to the provider behind the customer's own key and spends the customer's own money, so it
never starts from one click. The person first asks for a **preview**, which makes no provider call and changes nothing, and
sees exactly what would be sent, where, what it could cost, and what is not touched. Starting needs the single-use
**confirmation** that preview returned. The confirmation is bound to the exact task, candidate model, budget and sample size
shown, to the project, and to the person, and expires after CONFIRM_MINUTES. Changing any of them needs a new preview.

What this does not know: how long the destination provider keeps prompts or whether it trains on them. That depends on the
provider and the customer's account with it, so the preview says so instead of guessing.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from urllib.parse import urlparse

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import Settings, get_settings
from ..costing import compute_cost
from ..ingest import find_price
from ..models import Job, Project, ProviderKey, Run
from ..options import split_option
from ..recommend.stats import wilson, z_for
from ..security import derive
from .runner import TOOL_FREE, RetestRefused, check_can_start, output_limit, sample_sources, spent_this_month

CONFIRM_MINUTES = 10
MIN_CONCLUSIVE = 25  # checked answers needed before a pass rate is shown as evidence (the same floor the rest of the product uses)
_PROCESS_SECRET = secrets.token_hex(32)  # used only when the server has no SECRET_KEY: confirmations then die with the process

EVALUATORS = {
    "ANSWER_KEY": "The task's own answer key: each replayed answer is compared with the saved correct answer, the same rule used for live calls.",
    "SCHEMA": "The task's own format check: each replayed answer must match the same required structure used for live calls.",
}

STATEMENTS = [
    "Your live traffic is not touched. Nothing is routed, switched or changed in your app or source code.",
    "The candidate model is not added to your project or its settings. Only the replay results are recorded, as test runs.",
    "This runs once, after you confirm, and is not repeated or scheduled. You can stop looking at it at any time; it stays within the budget.",
]


def _secret(settings: Settings) -> bytes:
    return derive(settings.secret_key or _PROCESS_SECRET, "mcm replay confirmation v1")


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def budget_text(budget: Decimal | float | str) -> str:
    return f"{Decimal(str(budget)):.4f}"


def make_token(*, project_id: str, job_id, candidate: str, budget, sample: int, user_id, settings: Settings | None = None,
               now: datetime | None = None) -> tuple[str, datetime]:
    settings = settings or get_settings()
    now = now or datetime.now(UTC)
    expires = now + timedelta(minutes=CONFIRM_MINUTES)
    payload = {"p": project_id, "j": str(job_id), "c": candidate, "b": budget_text(budget), "n": int(sample),
               "u": str(user_id) if user_id else None, "x": int(expires.timestamp()), "i": secrets.token_hex(16)}
    body = _b64(json.dumps(payload, separators=(",", ":"), sort_keys=True).encode())
    sig = _b64(hmac.new(_secret(settings), body.encode(), hashlib.sha256).digest())
    return f"{body}.{sig}", expires


def read_token(token: str, *, project_id: str, job_id, candidate: str, budget, sample: int, user_id,
               settings: Settings | None = None, now: datetime | None = None) -> str:
    """Check a confirmation against exactly what is being started. Returns its single-use id, or raises RetestRefused."""
    settings = settings or get_settings()
    now = now or datetime.now(UTC)
    try:
        body, sig = token.split(".", 1)
        good = hmac.compare_digest(_b64(hmac.new(_secret(settings), body.encode(), hashlib.sha256).digest()), sig)
        payload = json.loads(_unb64(body)) if good else None
    except (ValueError, TypeError):
        payload = None
    if not isinstance(payload, dict):
        raise RetestRefused("confirmation_invalid", "This confirmation is not valid. Ask for a new preview and confirm that one.")
    if payload.get("x", 0) < int(now.timestamp()):
        raise RetestRefused("confirmation_expired", f"This confirmation expired after {CONFIRM_MINUTES} minutes. Ask for a new preview.")
    wanted = {"p": project_id, "j": str(job_id), "c": candidate, "b": budget_text(budget), "n": int(sample),
              "u": str(user_id) if user_id else None}
    if any(payload.get(k) != v for k, v in wanted.items()):
        raise RetestRefused("confirmation_mismatch", "This confirmation was for something different (another task, model, budget, "
                            "sample size or person). Ask for a new preview of exactly what you want to run.")
    return str(payload["i"])


def single_use_hash(nonce: str) -> str:
    return hashlib.sha256(nonce.encode()).hexdigest()


def conclusion(passed: int, failed: int, planned: int, status: str) -> dict:
    """Whether a replay's result is evidence yet. Cut-off answers (UNKNOWN) are neither passed nor failed, so they
    shrink the checked count; a stopped or failed replay says so."""
    checked = passed + failed
    low, high = (wilson(passed / checked, checked, z_for(0.95)) if checked else (None, None))
    if checked >= MIN_CONCLUSIVE:
        evidence, note = "enough", f"{checked} answers were checked, enough to show a pass rate with its range."
    else:
        evidence = "inconclusive"
        note = (f"Only {checked} answers were checked; at least {MIN_CONCLUSIVE} are needed before this means anything. "
                "Treat the pass rate as a first look, not a result.")
    if status in ("STOPPED_BUDGET", "STOPPED_CAP", "STOPPED_USER", "FAILED") and checked:
        note += " The replay stopped early, so it covers fewer prompts than planned."
    return {"evidence": evidence, "evidence_note": note, "pass_rate_low": low, "pass_rate_high": high,
            "checked": checked}


async def build_preview(
    session: AsyncSession, project: Project, job: Job, candidate_model: str, budget_usd, sample_size: int | None, *,
    user_id, settings: Settings | None = None, now: datetime | None = None,
) -> dict:
    """Everything the person should see before any paid call. Makes no provider call and writes nothing."""
    settings = settings or get_settings()
    now = now or datetime.now(UTC)
    n = sample_size or settings.retest_default_sample
    out: dict = {
        "job": job.name, "candidate_model": candidate_model, "budget_usd": float(Decimal(str(budget_usd))),
        "sample_size_requested": n, "can_start": False, "blocked": None, "statements": STATEMENTS,
        "evaluator_kind": job.check_kind, "evaluator": EVALUATORS.get(job.check_kind, "Not available: this task has no automatic check."),
        "confirmation": None, "expires_at": None, "confirm_minutes": CONFIRM_MINUTES,
    }
    try:
        key = await check_can_start(session, project, job, candidate_model, budget_usd, now=now)
    except RetestRefused as exc:
        out["blocked"] = {"code": exc.code, "message": str(exc)}
        key = await session.get(ProviderKey, project.project_id)
        if key is None or exc.code in ("provider_key_required", "consent_off", "project_off", "not_checkable", "no_price"):
            return out
    host = urlparse(key.base_url).hostname or key.base_url
    model, _effort = split_option(candidate_model)
    price = await find_price(session, model, model, key.provider)
    sources = await sample_sources(session, job, candidate_model, n, seed=0)
    eligible_all = (await session.execute(
        select(func.count(func.distinct(Run.prompt_hash))).where(
            Run.job_id == job.job_id, Run.run_kind == "PRODUCTION", Run.outcome.in_(("PASS", "FAIL")), Run.invalid_at.is_(None),
            Run.prompt.is_not(None), *( [Run.expected.is_not(None)] if job.check_kind == "ANSWER_KEY" else [])))).scalar_one()
    eligible_tool_free = (await session.execute(
        select(func.count(func.distinct(Run.prompt_hash))).where(
            Run.job_id == job.job_id, Run.run_kind == "PRODUCTION", Run.outcome.in_(("PASS", "FAIL")), Run.invalid_at.is_(None),
            Run.prompt.is_not(None), TOOL_FREE, *([Run.expected.is_not(None)] if job.check_kind == "ANSWER_KEY" else [])))).scalar_one()
    planned = len(sources)
    out.update({
        "provider": key.provider, "destination_host": host,
        "examples": {"available": int(eligible_tool_free), "planned": planned,
                     "left_out_for_tool_use": int(eligible_all - eligible_tool_free)},
        "data": [
            {"what": f"The text of {planned} past prompts from this task, chosen at random, one per distinct prompt.",
             "where": f"Sent to {host}, the provider behind the key you stored.", "kind": "sent"},
            {"what": "The saved correct answers.", "where": "Used here to check each replayed answer. Not sent to the provider.", "kind": "stays"},
            {"what": "Other tasks, other projects, labels, tool definitions, tool calls and your project key.", "where": "Never sent.", "kind": "never"},
            {"what": "The candidate model's answers.", "where": f"Stored in this project as test runs, kept for the project's retention ({project.content_retention_days} days), then deleted.", "kind": "received"},
        ],
        "retention_note": (
            f"Your prompts are sent to {host}. How long it keeps them, and whether it uses them to train models, depends on that "
            "provider and on your own account settings with it. This product does not know and cannot check that. Read their terms "
            "before you confirm."),
    })
    if price is not None:
        low = sum((compute_cost(price, int(s.tokens_in or 0), int(s.tokens_out or 0)) for s in sources), Decimal(0))
        worst = sum((compute_cost(price, int(s.tokens_in or 0), output_limit(s.tokens_out)) for s in sources), Decimal(0))
        cap_left = Decimal(project.retest_monthly_cap_usd) - await spent_this_month(session, project.project_id, now)
        high = min(worst, Decimal(str(budget_usd)), max(cap_left, Decimal(0)))
        out["cost"] = {
            "low_usd": float(min(low, high)), "high_usd": float(high), "worst_case_usd": float(worst),
            "budget_usd": float(Decimal(str(budget_usd))), "monthly_cap_remaining_usd": float(max(cap_left, Decimal(0))),
            "note": ("Low assumes each answer is about as long as the original. High is the most the calls could cost at their output "
                     "limits, capped by your budget and this month's cap. The replay stops before it would pass the budget. "
                     "A model that thinks at length can cost more than the low figure."),
            "estimated_from": f"{planned} sampled prompts; the actual sample is drawn when it runs",
        }
        out["price_basis"] = {"source": "this product's catalog list price (not your invoice)", "provider": key.provider, "model": model,
                              "input_usd_per_mtok": float(price.input_per_mtok), "output_usd_per_mtok": float(price.output_per_mtok),
                              "looked_up_at": now.isoformat()}
    if out["blocked"] is None and planned == 0:
        out["blocked"] = {"code": "no_examples", "message": "No past runs can be replayed: each needs a check the runner can repeat, "
                          "must not have used tools, and must not have been replayed on this model already."}
    if out["blocked"] is None and price is not None:
        token, expires = make_token(project_id=project.project_id, job_id=job.job_id, candidate=candidate_model, budget=budget_usd,
                                    sample=n, user_id=user_id, settings=settings, now=now)
        out.update({"can_start": True, "confirmation": token, "expires_at": expires})
    return out
