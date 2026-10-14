"""VectorStoreClient: similar-run search behind an interface.

pgvector inside Postgres (decided 14 Oct); Chroma or Qdrant could replace it
behind the same methods without touching the callers. Every search is scoped to one project, so one
customer's runs can never appear in another's results.

Each stored vector remembers which embedder produced it. Vectors from different embedders live in
different spaces and cannot be compared, so search can be limited to one embedder, and an earlier
vector is reused only when the same embedder made it (the persistent embedding cache).
"""

from __future__ import annotations

import uuid
from abc import ABC, abstractmethod
from dataclasses import dataclass

from sqlalchemy import select, update
from sqlalchemy.dialects.postgresql import distinct_on
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import Run


@dataclass(frozen=True)
class SimilarRun:
    run_id: uuid.UUID
    similarity: float  # cosine similarity, 1.0 means identical direction


class VectorStoreClient(ABC):
    @abstractmethod
    async def upsert(self, run_id: uuid.UUID, vector: list[float], *, model: str | None = None) -> bool:
        """Store the run's embedding and the name of the embedder that made it. Idempotent: writing the
        same run again replaces the vector. Returns False when the run does not exist."""

    @abstractmethod
    async def search(
        self, vector: list[float], *, project_id: str, job_id: uuid.UUID | None = None, top_k: int = 10,
        model: str | None = None,
    ) -> list[SimilarRun]:
        """The runs most similar to `vector` in this project, best first. With `model`, only vectors made
        by that embedder are considered."""

    @abstractmethod
    async def cached_vectors(self, project_id: str, prompt_hashes: list[str], model: str) -> dict[str, list[float]]:
        """Vectors already stored for these prompts (by prompt hash) in this project by this embedder,
        so the same text is never embedded twice, even across restarts."""

    @abstractmethod
    async def delete(self, run_id: uuid.UUID) -> None:
        """Remove the run's embedding (the run itself is kept)."""


class PgVectorClient(VectorStoreClient):
    """Embeddings live in `runs.embedding`. Uses the caller's session; the caller commits."""

    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def upsert(self, run_id: uuid.UUID, vector: list[float], *, model: str | None = None) -> bool:
        result = await self._session.execute(
            update(Run).where(Run.run_id == run_id).values(embedding=vector, embedding_model=model)
        )
        return result.rowcount == 1

    async def cached_vectors(self, project_id: str, prompt_hashes: list[str], model: str) -> dict[str, list[float]]:
        if not prompt_hashes:
            return {}
        rows = (
            await self._session.execute(
                select(Run.prompt_hash, Run.embedding)
                .where(Run.project_id == project_id, Run.prompt_hash.in_(prompt_hashes),
                       Run.embedding_model == model, Run.embedding.is_not(None))
                .ext(distinct_on(Run.prompt_hash))
            )
        ).all()
        return {r.prompt_hash: list(map(float, r.embedding)) for r in rows}

    async def search(
        self, vector: list[float], *, project_id: str, job_id: uuid.UUID | None = None, top_k: int = 10,
        model: str | None = None,
    ) -> list[SimilarRun]:
        distance = Run.embedding.cosine_distance(vector)
        query = (
            select(Run.run_id, distance.label("distance"))
            .where(Run.project_id == project_id, Run.embedding.is_not(None), Run.invalid_at.is_(None))
            .order_by(distance)
            .limit(top_k)
        )
        if job_id is not None:
            query = query.where(Run.job_id == job_id)
        if model is not None:
            query = query.where(Run.embedding_model == model)
        return [SimilarRun(run_id=r.run_id, similarity=1.0 - float(r.distance)) for r in await self._session.execute(query)]

    async def delete(self, run_id: uuid.UUID) -> None:
        await self._session.execute(update(Run).where(Run.run_id == run_id).values(embedding=None, embedding_model=None))
