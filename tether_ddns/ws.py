"""WebSocket connection management and broadcasting."""
from __future__ import annotations

import asyncio
from typing import Any

from tether_ddns.logging_setup import get_logger

_log = get_logger()


class ConnectionManager:
    """Tracks active WebSocket connections and broadcasts messages."""

    def __init__(self) -> None:
        """Create an empty connection manager."""
        self.connections: list[Any] = []

    async def connect(self, ws: Any) -> None:
        """Accept a WebSocket connection without registering it."""
        await ws.accept()

    def register(self, ws: Any) -> None:
        """Register an accepted socket to receive broadcasts."""
        self.connections.append(ws)

    def disconnect(self, ws: Any) -> None:
        """Deregister a WebSocket connection."""
        if ws in self.connections:
            self.connections.remove(ws)

    async def broadcast(self, kind: str, payload: object) -> None:
        """Send an envelope to every connected socket, dropping failures."""
        await self._broadcast_to(list(self.connections), kind, payload)

    async def _broadcast_to(
        self, recipients: list[Any], kind: str, payload: object,
    ) -> None:
        """Send an envelope to the given sockets, dropping failures."""
        message = {'kind': kind, 'payload': payload}
        for ws in recipients:
            try:
                await ws.send_json(message)
            except Exception:  # noqa: BLE001 - drop broken sockets
                self.disconnect(ws)

    def sync_broadcast(self, kind: str, payload: object) -> None:
        """Schedule a broadcast to the sockets connected at call time."""
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        recipients = list(self.connections)
        loop.create_task(self._broadcast_to(recipients, kind, payload))
