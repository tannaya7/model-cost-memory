"""VectorStoreClient: similar-run search behind an interface.

pgvector inside Postgres is the implementation (decided 14 Oct); Chroma or Qdrant could replace it
behind the same three methods without touching the callers. Every search is scoped to one project,
so one customer's runs can never appear in another's results.
"""

from __future__ import annotations

import uuid
from abc import ABC, abstractmethod
from dataclasses import dataclass

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import Run


@dataclass(frozen=True)
class SimilarRun:
    run_id: uuid.UUID
    similarity: float  # cosine similarity, 1.0 means identical direction


class VectorStoreClient(ABC):
    @abstractmethod
    async def upsert(self, run_id: uuid.UUID, vector: list[float]) -> bool:
        """Store the run's embedding. Idempotent: writing the same run again replaces the vector.
        Returns False when the run does not exist."""

    @abstractmethod
    async def search(
        self, vector: list[float], *, project_id: str, job_id: uuid.UUID | None = None, top_k: int = 10
    ) -> list[SimilarRun]:
        """The runs most similar to `vector` in this project, best first."""

    @abstractmethod
    async def delete(self, run_id: uuid.UUID) -> None:
        """Remove the run's embedding (the run itself is kept)."""


class PgVectorClient(VectorStoreClient):
    """Embeddings live in `runs.embedding`. Uses the caller's session; the caller commits."""

    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def upsert(self, run_id: uuid.UUID, vector: list[float]) -> bool:
        result = await self._session.execute(update(Run).where(Run.run_id == run_id).values(embedding=vector))
        return result.rowcount == 1

    async def search(
        self, vector: list[float], *, project_id: str, job_id: uuid.UUID | None = None, top_k: int = 10
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
        return [SimilarRun(run_id=r.run_id, similarity=1.0 - float(r.distance)) for r in await self._session.execute(query)]

    async def delete(self, run_id: uuid.UUID) -> None:
        await self._session.execute(update(Run).where(Run.run_id == run_id).values(embedding=None))
