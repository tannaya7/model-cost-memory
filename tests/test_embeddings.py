"""Embedders and their cache (no database, no PyTorch needed)."""

import math
import sys

import pytest

from agent_memory.embeddings import CachedEmbedder, HashingEmbedder, get_embedder
from agent_memory.models import EMBEDDING_DIM


def cosine(a, b):
    return sum(x * y for x, y in zip(a, b, strict=True))


def test_vectors_have_the_right_size_and_unit_length():
    (vec,) = HashingEmbedder().embed(["Extract the vendor and the total from this invoice."])
    assert len(vec) == EMBEDDING_DIM
    assert math.isclose(math.sqrt(sum(v * v for v in vec)), 1.0, rel_tol=1e-9)


def test_embedding_is_deterministic_across_calls():
    e = HashingEmbedder()
    assert e.embed(["same text"]) == e.embed(["same text"])


def test_similar_prompts_are_closer_than_unrelated_ones():
    e = HashingEmbedder()
    a, b, c = e.embed([
        "Extract the vendor, invoice number and total from this invoice: ShopCo INV-1042 total 1250",
        "Extract the vendor, invoice number and total from this invoice: Acme INV-2208 total 310",
        "Classify this support ticket as billing, bug or feature request: the app crashes on login",
    ])
    assert cosine(a, b) > cosine(a, c) + 0.2


def test_empty_text_does_not_crash():
    (vec,) = HashingEmbedder().embed([""])
    assert len(vec) == EMBEDDING_DIM


class Counting:
    name, dim = "counting", EMBEDDING_DIM

    def __init__(self):
        self.calls = []

    def embed(self, texts):
        self.calls.append(list(texts))
        return [[float(len(t))] + [0.0] * (EMBEDDING_DIM - 1) for t in texts]


def test_the_cache_embeds_each_distinct_prompt_once_and_keeps_order():
    inner = Counting()
    cached = CachedEmbedder(inner)
    first = cached.embed(["aa", "b", "aa"])
    assert [v[0] for v in first] == [2.0, 1.0, 2.0]
    assert inner.calls == [["aa", "b"]]  # the duplicate inside one batch is embedded once
    cached.embed(["aa", "b", "cccc"])
    assert inner.calls[-1] == ["cccc"]  # only the new prompt reaches the model
    assert (cached.hits, cached.misses) == (3, 3)


def test_cached_vectors_are_copies_so_callers_cannot_corrupt_the_cache():
    cached = CachedEmbedder(Counting())
    cached.embed(["x"])[0][0] = 999.0
    assert cached.embed(["x"])[0][0] == 1.0


def test_the_cache_evicts_the_least_recently_used_prompt():
    inner = Counting()
    cached = CachedEmbedder(inner, maxsize=2)
    cached.embed(["a", "b"])
    cached.embed(["c"])  # evicts "a"
    inner.calls.clear()
    cached.embed(["a"])
    assert inner.calls == [["a"]]


def test_get_embedder_by_name_and_unknown_names():
    assert get_embedder("hashing").name == "hashing"
    with pytest.raises(ValueError):
        get_embedder("nonsense")


def test_auto_falls_back_to_hashing_without_sentence_transformers(monkeypatch):
    monkeypatch.setitem(sys.modules, "sentence_transformers", None)  # makes the import fail
    assert get_embedder("auto").name == "hashing"
