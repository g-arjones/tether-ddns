"""A hook that logs each event it receives."""
from __future__ import annotations

from pydantic import BaseModel

from tether_ddns.hooks.base import (
    DomainUpdateErrorEvent,
    DomainUpdatePendingEvent,
    DomainUpdateSuccessEvent,
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

    async def on_domain_update_pending(
            self, event: DomainUpdatePendingEvent,
            config: BaseModel) -> None:
        """Log a domain update pending."""
        _log.info(
            'Hook event domain_update_pending: %s %s/%s (%s) current_ip=%s',
            event.domain_id, event.hostname, event.record_type, event.family,
            event.current_ip)

    async def on_domain_update_success(
            self, event: DomainUpdateSuccessEvent,
            config: BaseModel) -> None:
        """Log a successful domain update."""
        _log.info(
            'Hook event domain_update_success: %s %s/%s (%s) -> %s',
            event.domain_id, event.hostname, event.record_type, event.family,
            event.ip)

    async def on_domain_update_error(
            self, event: DomainUpdateErrorEvent,
            config: BaseModel) -> None:
        """Log a failed domain update."""
        _log.info(
            'Hook event domain_update_error: %s %s/%s (%s) ip=%s message=%s',
            event.domain_id, event.hostname, event.record_type, event.family,
            event.ip, event.message)
