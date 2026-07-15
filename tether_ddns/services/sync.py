"""IP detection and domain-sync orchestration as a context-owning service."""
from __future__ import annotations

from fastapi import HTTPException

from tether_ddns.config import DomainConfig
from tether_ddns.context import AppContext
from tether_ddns.hooks.base import (
    DomainUpdateErrorEvent, DomainUpdatePendingEvent,
    DomainUpdateSuccessEvent, IpChangedEvent, family_for)
from tether_ddns.ip_sources.base import IPFamily, detect_public_ip
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

    async def refresh_public_ips(self) -> set[IPFamily]:
        """Detect both families, update state, dispatch ip_changed; return changed."""
        state = self._state
        source = self._ctx.config.settings.ip_source
        changed: set[IPFamily] = set()
        setters = {'ipv4': state.set_public_ipv4, 'ipv6': state.set_public_ipv6}
        current: dict[IPFamily, str | None] = {
            'ipv4': state.public_ipv4, 'ipv6': state.public_ipv6}
        for family in ('ipv4', 'ipv6'):
            detected = await detect_public_ip(source, family)
            if detected is None or detected == current[family]:
                continue
            old = current[family]
            setters[family](detected)
            changed.add(family)
            await self._dispatch.dispatch(
                'ip_changed',
                IpChangedEvent(old_ip=old, new_ip=detected, family=family))
        return changed

    async def _sync_one(
        self, domain: DomainConfig, changed: set[IPFamily],
    ) -> None:
        """Apply freshness/retry/enabled rules to one domain and dispatch."""
        state = self._state
        family = family_for(domain.record_type)
        ip = state.public_ipv4 if family == 'ipv4' else state.public_ipv6
        if not domain.enabled:
            if state.set_freshness(domain.id, ip) == 'pending':
                await self._dispatch.dispatch(
                    'domain_update_pending', DomainUpdatePendingEvent(
                        domain_id=domain.id, hostname=domain.hostname,
                        record_type=domain.record_type, family=family,
                        current_ip=ip))
            return
        if ip is None:
            return
        runtime = state.domains.get(domain.id)
        needs_retry = (self._ctx.config.settings.retry_on_failure
                       and runtime is not None and runtime.status == 'error')
        is_fresh = runtime is None or runtime.status == 'pending'
        if not (family in changed or is_fresh or needs_retry):
            return
        before = runtime.status if runtime is not None else None
        terminal = await self.sync_domain(domain, ip)
        if terminal == before:
            return
        if terminal == 'synced':
            await self._dispatch.dispatch(
                'domain_update_success', DomainUpdateSuccessEvent(
                    domain_id=domain.id, hostname=domain.hostname,
                    record_type=domain.record_type, family=family, ip=ip))
        elif terminal == 'error':
            await self._dispatch.dispatch(
                'domain_update_error', DomainUpdateErrorEvent(
                    domain_id=domain.id, hostname=domain.hostname,
                    record_type=domain.record_type, family=family, ip=ip,
                    message=state.domains[domain.id].message))

    async def sync_ips(self) -> None:
        """When online, refresh both IP families and sync every domain."""
        if not self._state.online:
            return
        changed = await self.refresh_public_ips()
        for domain in self._ctx.config.domains:
            await self._sync_one(domain, changed)

    async def sync_one_now(self, domain: DomainConfig) -> None:
        """Ensure a public IP for the domain's family, then sync it once."""
        state = self._state
        family = family_for(domain.record_type)
        ip = state.public_ipv4 if family == 'ipv4' else state.public_ipv6
        if not ip:
            ip = await detect_public_ip(self._ctx.config.settings.ip_source, family)
            if not ip:
                raise HTTPException(status_code=503, detail='public IP unknown')
            if family == 'ipv4':
                state.set_public_ipv4(ip)
            else:
                state.set_public_ipv6(ip)
        await self.sync_domain(domain, ip)
