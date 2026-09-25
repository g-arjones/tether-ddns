"""Heartbeat pings to a push monitor as a context-owning service."""
from __future__ import annotations

import time

import aiohttp

from tether_ddns.context import AppContext
from tether_ddns.logging_setup import describe_exception, get_logger
from tether_ddns.runtime import HeartbeatStatus

_log = get_logger()
_TIMEOUT = aiohttp.ClientTimeout(total=10)


class HeartbeatService:
    """Sends the configured heartbeat GET and records its outcome."""

    def __init__(self, ctx: AppContext) -> None:
        """Create a heartbeat service bound to a context."""
        self._ctx = ctx

    async def run(self, *, force: bool = False) -> HeartbeatStatus | None:
        """Ping the heartbeat URL; skip while offline unless forced."""
        url = self._ctx.config.settings.heartbeat_url
        if url is None:
            return None
        runtime = self._ctx.runtime
        if not force and not runtime.online:
            status = HeartbeatStatus(at=time.time(), ok=False, skipped=True)
        else:
            try:
                await self._ping(str(url))
            except Exception as exc:  # noqa: BLE001 - heartbeat errors must be contained
                _log.exception('Heartbeat to %s failed', url)
                status = HeartbeatStatus(
                    at=time.time(), ok=False, skipped=False,
                    error=describe_exception(exc))
            else:
                status = HeartbeatStatus(at=time.time(), ok=True, skipped=False)
        runtime.set_heartbeat(status)
        return status

    async def _ping(self, url: str) -> None:
        """GET the URL, raising on transport errors and non-2xx responses."""
        async with aiohttp.ClientSession(timeout=_TIMEOUT) as session:
            async with session.get(url) as resp:
                resp.raise_for_status()
