"""Turning prompt text into vectors for similar-run search.

Two embedders share one interface:

  MiniLMEmbedder     the real model (all-MiniLM-L6-v2, 384 dimensions, runs on CPU, costs nothing).
                     Needs the `embeddings` extra (sentence-transformers, about 2 GB with PyTorch),
                     so only the sync worker image installs it.
  HashingEmbedder    no dependencies and fully deterministic: words and word pairs are hashed into
                     384 buckets. Good enough to find near-duplicate prompts, and what tests and a
                     laptop without PyTorch use.

`CachedEmbedder` wraps either with an LRU cache keyed by the prompt's hash, so a prompt seen again
(very common: the same template with small changes, retries, re-tests) is never embedded twice.
"""

from __future__ import annotations

import hashlib
import logging
import math
import os
import re
import threading
from typing import Protocol

from cachetools import LRUCache

from .models import EMBEDDING_DIM

log = logging.getLogger("agent_memory.embeddings")

MODEL_NAME = "sentence-transformers/all-MiniLM-L6-v2"
_WORD = re.compile(r"[a-z0-9]+")


class Embedder(Protocol):
    name: str
    dim: int

    def embed(self, texts: list[str]) -> list[list[float]]: ...


class HashingEmbedder:
    name = "hashing"
    dim = EMBEDDING_DIM

    def embed(self, texts: list[str]) -> list[list[float]]:
        return [self._one(text) for text in texts]

    def _one(self, text: str) -> list[float]:
        vec = [0.0] * self.dim
        words = _WORD.findall(text.lower())
        for feature in words + [f"{a} {b}" for a, b in zip(words, words[1:], strict=False)]:
            digest = hashlib.blake2b(feature.encode("utf8"), digest_size=8).digest()
            bucket = int.from_bytes(digest[:4], "big") % self.dim
            vec[bucket] += 1.0 if digest[4] & 1 else -1.0  # a signed hash keeps unrelated words from piling up
        norm = math.sqrt(sum(v * v for v in vec)) or 1.0
        return [v / norm for v in vec]


class MiniLMEmbedder:
    name = "minilm"
    dim = EMBEDDING_DIM

    def __init__(self, batch_size: int = 32) -> None:
        from sentence_transformers import SentenceTransformer  # heavy; imported only when used

        self._model = SentenceTransformer(MODEL_NAME)
        self._batch_size = batch_size

    def embed(self, texts: list[str]) -> list[list[float]]:
        vectors = self._model.encode(
            texts, batch_size=self._batch_size, normalize_embeddings=True, show_progress_bar=False
        )
        return [list(map(float, v)) for v in vectors]


class CachedEmbedder:
    """An LRU cache in front of another embedder, keyed by a hash of the text."""

    def __init__(self, inner: Embedder, maxsize: int = 20_000) -> None:
        self.inner = inner
        self.name = inner.name
        self.dim = inner.dim
        self._cache: LRUCache = LRUCache(maxsize=maxsize)
        self._lock = threading.Lock()
        self.hits = 0
        self.misses = 0

    @staticmethod
    def _key(text: str) -> str:
        return hashlib.sha256(text.encode("utf8")).hexdigest()

    def embed(self, texts: list[str]) -> list[list[float]]:
        keys = [self._key(t) for t in texts]
        with self._lock:
            found = {k: self._cache[k] for k in keys if k in self._cache}
        missing = {k: t for k, t in zip(keys, texts, strict=True) if k not in found}
        if missing:
            fresh = self.inner.embed(list(missing.values()))
            with self._lock:
                for key, vector in zip(missing, fresh, strict=True):
                    self._cache[key] = vector
                    found[key] = vector
        self.hits += len(texts) - len(missing)
        self.misses += len(missing)
        return [list(found[k]) for k in keys]


def get_embedder(name: str | None = None) -> Embedder:
    """The embedder named by `name` or EMBEDDER (minilm, hashing or auto), wrapped in a cache.

    `auto` (the default) uses MiniLM when sentence-transformers is installed and otherwise falls back
    to the hashing embedder with a warning, so nothing breaks on a machine without PyTorch.
    """
    choice = (name or os.environ.get("EMBEDDER", "auto")).lower()
    if choice == "hashing":
        return CachedEmbedder(HashingEmbedder())
    if choice == "minilm":
        return CachedEmbedder(MiniLMEmbedder())
    if choice != "auto":
        raise ValueError(f"unknown embedder '{choice}' (use minilm, hashing or auto)")
    try:
        return CachedEmbedder(MiniLMEmbedder())
    except ImportError:
        log.warning("sentence-transformers is not installed; using the hashing embedder")
        return CachedEmbedder(HashingEmbedder())
