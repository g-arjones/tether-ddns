"""A hook that logs each event it receives."""
from __future__ import annotations

from pydantic import BaseModel

from tether_ddns.hooks.base import (
    Hook,
    IpChangedEvent,
    ReachabilityChangedEvent,
    register_hook,
)
from tether_ddns.logging_setup import get_logger

_log = get_logger()


@register_hook
class LogHook(Hook):
    """Logs event details at INFO level."""

    key = 'log'
    display_name = 'Log Event'

    async def on_ip_changed(
            self, event: IpChangedEvent, config: BaseModel) -> None:
        """Log the IP transition."""
        _log.info(
            'Hook event ip_changed (%s): %s -> %s',
            event.family, event.old_ip, event.new_ip)

    async def on_reachability_changed(
            self, event: ReachabilityChangedEvent, config: BaseModel) -> None:
        """Log the reachability transition."""
        _log.info(
            'Hook event reachability_changed: %s -> %s',
            event.was_online, event.online)
