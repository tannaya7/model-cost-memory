"""One poller per project for the live data-flow stream, shared by everyone watching it.

Each `/v1/flow/stream` viewer used to query the database once a second, so a hundred people watching
the public demo meant a hundred queries a second. Now a project being watched has one poller: it
reads new flow events once a second with a short-lived session of its own and hands them to every
viewer's queue. A viewer only reads the database once, to catch up from where it left off
(Last-Event-ID) when it connects. The poller stops when the last viewer leaves.

A viewer too slow to keep up (its queue full) is disconnected; the browser reconnects by itself and
catches up from its Last-Event-ID, so nothing is lost.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from ..models import FlowEvent

log = logging.getLogger("agent_memory.flow")

POLL_SECONDS = 1.0
QUEUE_SIZE = 1000
BATCH = 500


class Overflowed(Exception):
    """The viewer fell behind; it should reconnect."""


@dataclass(eq=False)  # each viewer is its own, hashable by identity
class Viewer:
    queue: asyncio.Queue = field(default_factory=lambda: asyncio.Queue(QUEUE_SIZE))
    overflowed: bool = False


@dataclass
class _Topic:
    cursor: int
    viewers: set = field(default_factory=set)
    task: asyncio.Task | None = None


class FlowHub:
    def __init__(self, poll_seconds: float = POLL_SECONDS):
        self.poll_seconds = poll_seconds
        self._topics: dict[str, _Topic] = {}
        self._lock = asyncio.Lock()

    def watching(self, project_id: str) -> int:
        topic = self._topics.get(project_id)
        return len(topic.viewers) if topic else 0

    async def subscribe(self, project_id: str, sessions: async_sessionmaker[AsyncSession]) -> Viewer:
        viewer = Viewer()
        async with self._lock:
            topic = self._topics.get(project_id)
            if topic is None:
                async with sessions() as s:
                    newest = (await s.execute(select(func.coalesce(func.max(FlowEvent.event_id), 0))
                                              .where(FlowEvent.project_id == project_id))).scalar_one()
                topic = _Topic(cursor=int(newest))
                self._topics[project_id] = topic
                topic.task = asyncio.create_task(self._poll(project_id, topic, sessions))
            topic.viewers.add(viewer)
        return viewer

    async def unsubscribe(self, project_id: str, viewer: Viewer) -> None:
        async with self._lock:
            topic = self._topics.get(project_id)
            if topic is None:
                return
            topic.viewers.discard(viewer)
            if not topic.viewers:
                del self._topics[project_id]
                if topic.task is not None:
                    topic.task.cancel()
                    try:
                        await topic.task
                    except (asyncio.CancelledError, Exception):
                        pass

    async def _poll(self, project_id: str, topic: _Topic, sessions: async_sessionmaker[AsyncSession]) -> None:
        while True:
            try:
                async with sessions() as s:
                    fresh = (await s.execute(
                        select(FlowEvent).where(FlowEvent.project_id == project_id, FlowEvent.event_id > topic.cursor)
                        .order_by(FlowEvent.event_id).limit(BATCH))).scalars().all()
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("flow poll failed", extra={"project_id": project_id})
                fresh = []
            for event in fresh:
                topic.cursor = max(topic.cursor, event.event_id)
                for viewer in list(topic.viewers):
                    if viewer.overflowed:
                        continue
                    try:
                        viewer.queue.put_nowait(event)
                    except asyncio.QueueFull:
                        viewer.overflowed = True
            await asyncio.sleep(self.poll_seconds)


HUB = FlowHub()
