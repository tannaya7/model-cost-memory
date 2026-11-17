"""App-chosen models (Cursor, Copilot, ...) are never suggested and get no switch advice."""

import pytest

from agent_memory.recommend.app_chosen import APP_CHOSEN_REASON, is_app_chosen
from agent_memory.recommend.engine import ModelInput, decide
from agent_memory.recommend.stats import Sample

RULES = dict(floor=25.0, margin=0.03, confidence=0.95)


def model(name, p, n, cost):
    s = Sample(pass_rate=p, effective_n=n, evidence_weight=n)
    return ModelInput(model=name, model_version=f"{name}-v1", n_runs=n, failures=round(n * (1 - p)), sample=s,
                      mean_cost_usd=cost, catalog_status="ACTIVE", shutdown_date=None)


@pytest.mark.parametrize("name", ["cursor", "Cursor-Auto", "AUTO", "copilot", "github-copilot", "windsurf",
                                  "default", "cursor@high", "Cursor Auto"])
def test_app_labels_match(name):
    assert is_app_chosen(name)


@pytest.mark.parametrize("name", ["claude-sonnet-5", "gpt-5", "autoencoder-1", "cursorish", "", None])
def test_real_models_do_not_match(name):
    assert not is_app_chosen(name)


def test_current_app_model_gets_no_switch_verdict_and_a_plain_reason():
    d = decide([model("cursor-auto", 0.9, 400, 0.05), model("mini", 0.99, 400, 0.001)], "cursor-auto", **RULES)
    assert d.verdict == "HOLD"
    assert d.recommended is d.current and d.current.model == "cursor-auto"
    assert d.warnings == [APP_CHOSEN_REASON]
    assert d.next_step is None


def test_app_label_is_never_the_suggested_model():
    d = decide([model("big", 0.99, 400, 0.03), model("cursor", 0.99, 400, 0.0001)], "big", **RULES)
    assert d.recommended.model == "big"
    assert all(m.model != "cursor" for m in d.models)


def test_ordinary_models_behave_exactly_as_before():
    d = decide([model("big", 0.99, 400, 0.03), model("mini", 0.99, 400, 0.001)], "big", **RULES)
    assert (d.verdict, d.recommended.model, d.current.model) == ("DOWNGRADE", "mini", "big")
    assert d.warnings == []
    assert [m.model for m in d.models] == ["big", "mini"]
    assert d.models[1].cost_per_success_usd == 0.001 / 0.99
