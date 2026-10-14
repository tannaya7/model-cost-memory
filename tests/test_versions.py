"""Model name normalisation (no database needed). Model names here are made up."""

import pytest
from hypothesis import given
from hypothesis import strategies as st

from agent_memory.versions import family, normalize, same_family, version_label


@pytest.mark.parametrize(
    "name, expected",
    [
        ("model-a", "model-a"),
        ("model-a-2026-09-15", "model-a"),
        ("model-a-20260915", "model-a"),
        ("model-a@20260915", "model-a"),
        ("model-a-2026-09", "model-a"),
        ("model-a-latest", "model-a"),
        ("Acme/Model-A-2026-09-15", "model-a"),
        ("  MODEL-A  ", "model-a"),
        ("local-llm:3b", "local-llm:3b"),  # an Ollama-style size tag is part of the model
        ("model-a-2026-09-15-latest", "model-a"),
        ("model-4o", "model-4o"),  # digits that are not dates stay
    ],
)
def test_family_strips_dates_aliases_and_provider_prefixes(name, expected):
    assert family(name) == expected


def test_the_same_model_in_different_spellings_is_one_family():
    assert same_family("model-a", "acme/MODEL-A-2026-09-15")
    assert not same_family("model-a", "model-b")


@pytest.mark.parametrize(
    "name, label",
    [
        ("model-a-2026-09-15", "2026-09-15"),
        ("model-a-20260915", "2026-09-15"),
        ("model-a-2026-09", "2026-09"),
        ("model-a", "model-a"),  # no date: the whole name is the version
    ],
)
def test_version_label_is_the_date_when_there_is_one(name, label):
    assert version_label(name) == label


@given(st.text(alphabet="abcdefghij-_.0123456789/@: ", min_size=1, max_size=40))
def test_family_is_idempotent_and_never_longer(name):
    once = family(name)
    assert family(once) == once
    assert len(once) <= len(normalize(name))
