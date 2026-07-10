"""Tests for the WebSocket connection manager."""
from unittest.mock import AsyncMock, MagicMock

import pytest

from tether_ddns.ws import ConnectionManager


@pytest.mark.asyncio
async def test_broadcast_sends_to_all() -> None:
    """Broadcast delivers a kind/payload envelope to every socket."""
    mgr = ConnectionManager()
    ws = MagicMock()
    ws.accept = AsyncMock()
    ws.send_json = AsyncMock()
    await mgr.connect(ws)
    await mgr.broadcast('log', {'message': 'hi'})
    ws.send_json.assert_awaited_with({'kind': 'log', 'payload': {'message': 'hi'}})


@pytest.mark.asyncio
async def test_broadcast_drops_broken_sockets() -> None:
    """A socket that errors on send is removed, not raised."""
    mgr = ConnectionManager()
    ws = MagicMock()
    ws.accept = AsyncMock()
    ws.send_json = AsyncMock(side_effect=RuntimeError('closed'))
    await mgr.connect(ws)
    await mgr.broadcast('log', {'message': 'hi'})
    assert ws not in mgr.connections
