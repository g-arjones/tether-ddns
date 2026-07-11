"""A hook that logs each event it receives."""
from __future__ import annotations

from pydantic import BaseModel

from tether_ddns.hooks.base import (
    EmptyConfig,
    Hook,
    HookEvent,
    SUPPORTED_EVENTS,
    register_hook,
)
from tether_ddns.logging_setup import get_logger

_log = get_logger()


@register_hook
class LogHook(Hook):
    """Logs event details at INFO level."""

    key = 'log'
    display_name = 'Log Event'
    supported_events = SUPPORTED_EVENTS
    ConfigModel = EmptyConfig

    async def handle(self, event: HookEvent, config: BaseModel) -> None:
        """Log the event type and transition."""
        _log.info('Hook event %s: %s -> %s', event.type, event.old, event.new)
