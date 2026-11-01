"""Async database engine and session factory (SQLAlchemy 2 + asyncpg)."""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker, create_async_engine

from .config import get_settings, normalize_database_url

_engine: AsyncEngine | None = None
_sessions: async_sessionmaker[AsyncSession] | None = None


def make_engine(url: str | None = None) -> AsyncEngine:
    """Create an engine. The URL defaults to DATABASE_URL and is normalised for asyncpg."""
    settings = get_settings()
    raw = url or settings.database_url
    if not raw:
        raise RuntimeError("DATABASE_URL is not set (see .env.example)")
    return create_async_engine(
        normalize_database_url(raw), pool_pre_ping=True, pool_size=settings.db_pool_size,
        max_overflow=settings.db_max_overflow, pool_recycle=1800,  # hosted Postgres drops idle connections
    )


def get_engine() -> AsyncEngine:
    global _engine, _sessions
    if _engine is None:
        _engine = make_engine()
        _sessions = async_sessionmaker(_engine, expire_on_commit=False)
    return _engine


def session_factory() -> async_sessionmaker[AsyncSession]:
    get_engine()
    assert _sessions is not None
    return _sessions


async def get_session() -> AsyncIterator[AsyncSession]:
    """FastAPI dependency: one session per request."""
    async with session_factory()() as session:
        yield session


@asynccontextmanager
async def session_scope() -> AsyncIterator[AsyncSession]:
    """For scripts and workers: a session that commits on success and rolls back on error."""
    async with session_factory()() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise


async def dispose_engine() -> None:
    global _engine, _sessions
    if _engine is not None:
        await _engine.dispose()
    _engine = None
    _sessions = None
