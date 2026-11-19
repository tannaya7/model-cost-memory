"""What a verdict rests on, said plainly: where the pass/fail came from, over what window, whether the models could
fairly be compared, how the comparison was made, and what it cannot tell you.

Nothing here decides anything. `decide` (engine.py) and its golden regression are untouched; this module only
labels the evidence next to the verdict and, when the evidence cannot support a move, says so.

Evidence states (never a verdict, never counted as a saving):

    enough             the rule had what it needs (to move, or to stay)
    not_enough         a better or cheaper model may exist, but there is not enough evidence to say
    not_comparable     the two models were only ever tried on different prompt versions, so a difference could be
                       the prompt, not the model; no move is advised
    no_recommendation  there is nothing to recommend (the app picks the model, no production runs, or nothing passes)

Where a pass/fail comes from (the job's check):

    deterministic      a fixed rule decided it: an answer key, a format (schema) or a test command
    human_label        a label the app reports later (for example a person's review); we cannot see how it was made
    An LLM judge is not one of the checks. If an app reports a model-graded pass/fail as a late label, it is that
    judge's opinion: only as reliable as the judge, not ground truth, and we cannot tell it apart from a human label.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from .stats import Sample, difference, paired_difference

State = Literal["enough", "not_enough", "not_comparable", "no_recommendation"]
BasisKind = Literal["deterministic", "human_label"]
MIN_PAIRED_PROMPTS = 30  # fewer shared prompts than this and a paired interval says too little to show

BASIS: dict[str, tuple[BasisKind, str, str]] = {
    "ANSWER_KEY": ("deterministic", "A saved correct answer", "Each answer was compared with a saved correct answer by a fixed rule."),
    "SCHEMA": ("deterministic", "A fixed format", "Each answer was checked against a fixed format. That shows the answer is well formed, not that it is right."),
    "TEST_COMMAND": ("deterministic", "Your test command", "A test command you set up decided pass or fail, the same way every time."),
    "LATE_LABEL": ("human_label", "Labels your app reports", "Pass or fail comes from labels your app reports later, for example a person's review. We cannot see how a label was made: if a model graded it, it is that model's opinion, not proof."),
}
UNKNOWN_BASIS = ("human_label", "Reported by your app", "Pass or fail was reported by your app. We cannot see how it was decided.")


@dataclass(frozen=True)
class Basis:
    kind: BasisKind
    label: str
    text: str


def basis_for(check_kind: str) -> Basis:
    kind, label, text = BASIS.get(check_kind, UNKNOWN_BASIS)
    return Basis(kind, label, text)


@dataclass(frozen=True)
class PairedEvidence:
    """The same prompts answered by both models (re-tests replay real prompts): compared as pairs."""

    candidate: str
    current: str
    n_prompts: int
    both: int
    only_candidate: int
    only_current: int
    neither: int
    gap: float  # candidate minus model in use, as a fraction
    low: float
    high: float


def paired_evidence(candidate: str, current: str, outcomes: dict[str, dict[str, bool]], z: float) -> PairedEvidence | None:
    """`outcomes[option][prompt_hash]` is whether that option passed that prompt. None below MIN_PAIRED_PROMPTS."""
    c, r = outcomes.get(candidate, {}), outcomes.get(current, {})
    shared = c.keys() & r.keys()
    if len(shared) < MIN_PAIRED_PROMPTS:
        return None
    both = sum(1 for h in shared if c[h] and r[h])
    only_c = sum(1 for h in shared if c[h] and not r[h])
    only_r = sum(1 for h in shared if r[h] and not c[h])
    neither = len(shared) - both - only_c - only_r
    low, high = paired_difference(both, only_c, only_r, neither, z)
    return PairedEvidence(candidate, current, len(shared), both, only_c, only_r, neither,
                          (only_c - only_r) / len(shared), low, high)


def gap_words(low: float, high: float, margin: float) -> str:
    """The gap between two models in words that never call an unproven gap a tie."""
    if low > 0:
        return "better, and the range is above zero"
    if high < 0:
        return "worse, and the range is below zero"
    if low >= -margin:
        return "no clear difference yet; the range stays within the margin"
    return "no clear difference yet; the range is too wide to rule out a real gap"


def unpaired_gap(a: Sample, b: Sample, z: float) -> tuple[float, float, float]:
    """(gap, low, high) for a minus b, unpaired: different requests, so Newcombe's two-sample interval."""
    low, high = difference(a, b, z)
    return a.pass_rate - b.pass_rate, low, high


def not_comparable(prompt_versions: dict[str, set[str]], a: str | None, b: str | None) -> str | None:
    """A reason when the two options were only ever run on different prompt versions; None when they share one
    or when either has no version recorded (unknown is not a reason to refuse)."""
    if not a or not b or a == b:
        return None
    va, vb = prompt_versions.get(a), prompt_versions.get(b)
    if not va or not vb or va & vb:
        return None
    return (f"{a} and {b} were only tried on different prompt versions, so a difference could come from the "
            "prompt and not the model. No move is advised until both run on the same prompt version")


def limitations(*, unpaired: bool, effective_n: float | None, n_runs: int, window_days: float | None,
                basis: Basis) -> list[str]:
    out = []
    if unpaired:
        out.append("The models answered different requests, so they are compared as two separate groups "
                   "(a wider, safer range than comparing the same prompts).")
    if effective_n is not None and n_runs and effective_n < 0.8 * n_runs:
        out.append(f"Older answers count for less, so {n_runs} checked answers carry about {effective_n:.0f} answers' worth of weight.")
    if window_days is not None and window_days < 14:
        out.append(f"All of this comes from {window_days:.0f} days of calls, so it may not show a slow change or a busy period.")
    out.append("Ranges are statistical approximations at the stated confidence. They describe your past checked answers, not a promise about future ones.")
    if basis.kind == "deterministic" and basis.label == "A fixed format":
        out.append("A format check shows an answer is well formed, not that it is correct.")
    if basis.kind == "human_label":
        out.append("We cannot see how labels were made, and a model-graded label is an opinion, not ground truth.")
    return out


def classify(verdict: str, *, current_known: bool, app_chosen: bool, reference_passes_none: bool,
             open_questions: bool, not_comparable_reason: str | None) -> tuple[State, str]:
    """The evidence state and a one-line reason. `open_questions` is True when something cheaper or better is
    still unsure or below the evidence floor."""
    if app_chosen:
        return "no_recommendation", "Your app picks the model, so there is nothing to switch to."
    if not_comparable_reason:
        return "not_comparable", not_comparable_reason
    if not current_known:
        return "no_recommendation", "No production runs yet, so we do not know which model this task uses."
    if reference_passes_none:
        return "no_recommendation", "No model passed its checked answers, so a cost per correct answer cannot be worked out."
    if verdict == "INSUFFICIENT_EVIDENCE":
        return "not_enough", "Not enough checked answers yet to judge the models. This is a valid answer, not a failure."
    if verdict in ("DOWNGRADE", "SWITCH"):
        return "enough", "The rule's evidence requirements are met for this move."
    if open_questions:
        return "not_enough", "Keep the current model. Another model may be cheaper or better, but there is not enough evidence to say."
    return "enough", "Keep the current model. No other model is proven cheaper at the same quality."
