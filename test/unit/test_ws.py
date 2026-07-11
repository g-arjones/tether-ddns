"""Tests for the WebSocket connection manager."""
import asyncio
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
    mgr.register(ws)
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
    mgr.register(ws)
    await mgr.broadcast('log', {'message': 'hi'})
    assert ws not in mgr.connections


@pytest.mark.asyncio
async def test_connect_accepts_without_registering() -> None:
    """Connect accepts the socket but does not register it for broadcasts."""
    mgr = ConnectionManager()
    ws = MagicMock()
    ws.accept = AsyncMock()
    ws.send_json = AsyncMock()
    await mgr.connect(ws)
    ws.accept.assert_awaited_once()
    assert ws not in mgr.connections
    await mgr.broadcast('log', {'message': 'hi'})
    ws.send_json.assert_not_awaited()


@pytest.mark.asyncio
async def test_sync_broadcast_targets_schedule_time_sockets() -> None:
    """sync_broadcast delivers only to sockets present when it was scheduled."""
    mgr = ConnectionManager()
    ws1 = MagicMock()
    ws1.send_json = AsyncMock()
    mgr.register(ws1)
    mgr.sync_broadcast('log', {'m': 1})
    ws2 = MagicMock()
    ws2.send_json = AsyncMock()
    mgr.register(ws2)  # registered AFTER scheduling
    await asyncio.sleep(0)  # let the scheduled task run
    ws1.send_json.assert_awaited_once()
    ws2.send_json.assert_not_called()
