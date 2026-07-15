"""IP detection and domain-sync orchestration as a context-owning service."""
from __future__ import annotations

from tether_ddns.config import DomainConfig
from tether_ddns.context import AppContext
from tether_ddns.logging_setup import get_logger
from tether_ddns.providers.base import PROVIDER_REGISTRY
from tether_ddns.runtime import RuntimeState, Status
from tether_ddns.services.dispatch import DispatchService

_log = get_logger()


class SyncService:
    """Owns IP detection and per-domain sync over a shared AppContext."""

    def __init__(self, ctx: AppContext, dispatch: DispatchService) -> None:
        """Create a sync service bound to a context and dispatcher."""
        self._ctx = ctx
        self._dispatch = dispatch

    @property
    def _state(self) -> RuntimeState:
        """Return the runtime state from the context."""
        return self._ctx.runtime

    async def sync_domain(self, domain: DomainConfig, ip: str) -> Status:
        """Update a single domain, isolating provider exceptions."""
        state = self._state
        provider_cls = PROVIDER_REGISTRY.get(domain.provider)
        if provider_cls is None:
            state.set_status(
                domain.id, 'error', message=f'Unknown provider {domain.provider}')
            return 'error'
        state.set_status(domain.id, 'updating')
        try:
            config = provider_cls.ConfigModel.model_validate(domain.provider_config)
            assigned = await provider_cls().update(
                domain.hostname, domain.record_type, ip, config)
        except Exception as exc:  # noqa: BLE001 - provider errors must be contained
            _log.exception(
                'Provider %s failed for %s', domain.provider, domain.hostname)
            state.set_status(domain.id, 'error', message=str(exc))
            return 'error'
        state.set_status(domain.id, 'synced', ip=assigned or ip, message='')
        return 'synced'
