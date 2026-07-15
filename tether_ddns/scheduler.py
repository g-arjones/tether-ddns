"""APScheduler-driven periodic jobs with exception-isolated dispatch."""
from __future__ import annotations

from apscheduler.schedulers.asyncio import (  # pyright: ignore[reportMissingTypeStubs]
    AsyncIOScheduler,
)

from tether_ddns.config import AppConfig, DomainConfig
from tether_ddns.hooks.base import (
    DomainUpdateErrorEvent, DomainUpdatePendingEvent,
    DomainUpdateSuccessEvent, IpChangedEvent,
    ReachabilityChangedEvent)
from tether_ddns.ip_sources.base import IPFamily, detect_public_ip
from tether_ddns.logging_setup import get_logger
from tether_ddns.providers.base import PROVIDER_REGISTRY
from tether_ddns.reachability import ReachabilityService
from tether_ddns.runtime import RuntimeState, Status
from tether_ddns.services.dispatch import DispatchService

_log = get_logger()

REACHABILITY_INTERVAL_SECONDS = 30


def _family_for(record_type: str) -> IPFamily:
    """Return the IP family a record type resolves against."""
    return 'ipv6' if record_type == 'AAAA' else 'ipv4'


async def sync_domain(domain: DomainConfig, ip: str, state: RuntimeState) -> Status:
    """Update a single domain, isolating provider exceptions.

    Returns the terminal status ('synced' or 'error'). Does not dispatch
    hook events; the scheduler decides whether a transition occurred.
    """
    provider_cls = PROVIDER_REGISTRY.get(domain.provider)
    if provider_cls is None:
        state.set_status(domain.id, 'error', message=f'Unknown provider {domain.provider}')
        return 'error'
    state.set_status(domain.id, 'updating')
    try:
        config = provider_cls.ConfigModel.model_validate(domain.provider_config)
        assigned = await provider_cls().update(
            domain.hostname, domain.record_type, ip, config)
    except Exception as exc:  # noqa: BLE001 - provider errors must be contained
        _log.exception('Provider %s failed for %s', domain.provider, domain.hostname)
        state.set_status(domain.id, 'error', message=str(exc))
        return 'error'
    state.set_status(domain.id, 'synced', ip=assigned or ip, message='')
    return 'synced'


class Scheduler:
    """Owns the APScheduler instance and periodic checks."""

    def __init__(self, dispatch: DispatchService) -> None:
        """Create an unstarted scheduler bound to a dispatcher."""
        self._scheduler = AsyncIOScheduler()
        self._reachability = ReachabilityService()
        self._dispatch = dispatch

    def start(self, cfg: AppConfig, state: RuntimeState) -> None:
        """Schedule the reachability and IP-sync jobs and start."""
        self._scheduler.add_job(  # pyright: ignore[reportUnknownMemberType]
            self.check_reachability, 'interval',
            seconds=REACHABILITY_INTERVAL_SECONDS,
            args=[cfg, state], id='reachability', replace_existing=True,
        )
        self._scheduler.add_job(  # pyright: ignore[reportUnknownMemberType]
            self.sync_ips, 'interval', seconds=cfg.settings.check_interval,
            args=[cfg, state], id='sync', replace_existing=True,
        )
        self._scheduler.start()
        self._publish_next_check(state)

    def reschedule_sync(self, cfg: AppConfig, state: RuntimeState) -> None:
        """Re-add the sync job with the current check interval and republish."""
        self._scheduler.add_job(  # pyright: ignore[reportUnknownMemberType]
            self.sync_ips, 'interval', seconds=cfg.settings.check_interval,
            args=[cfg, state], id='sync', replace_existing=True,
        )
        self._publish_next_check(state)

    def run_startup_check(self, cfg: AppConfig, state: RuntimeState) -> None:
        """Schedule one immediate, non-blocking check cycle at startup."""
        self._scheduler.add_job(  # pyright: ignore[reportUnknownMemberType]
            self.check_once, 'date', args=[cfg, state],
            id='startup', replace_existing=True,
        )

    def shutdown(self) -> None:
        """Stop the scheduler."""
        if self._scheduler.running:
            self._scheduler.shutdown(wait=False)

    def _publish_next_check(self, state: RuntimeState) -> None:
        """Publish the sync job's next fire time to runtime state."""
        sc = self._scheduler
        get = sc.get_job  # pyright: ignore[reportUnknownMemberType,reportUnknownVariableType]
        job = get('sync')  # pyright: ignore[reportUnknownVariableType]
        next_run = (
            getattr(job, 'next_run_time', None)  # pyright: ignore[reportUnknownArgumentType]
            if job else None)
        ts = next_run.timestamp() if next_run else None
        state.set_next_check_at(ts)

    async def check_reachability(self, cfg: AppConfig, state: RuntimeState) -> None:
        """Run the DNS-quorum check; fire reachability_changed on transition."""
        was_online = state.online
        reach = await self._reachability.check()
        transitioned = state.record_reachability(reach)
        if transitioned:
            await self._dispatch.dispatch(
                'reachability_changed',
                ReachabilityChangedEvent(
                    online=reach.online, was_online=was_online))

    async def sync_ips(self, cfg: AppConfig, state: RuntimeState) -> None:
        """When online, refresh both IP families and sync domains."""
        if not state.online:
            return
        ipv4 = await detect_public_ip(cfg.settings.ip_source, 'ipv4')
        ipv6 = await detect_public_ip(cfg.settings.ip_source, 'ipv6')
        changed: set[IPFamily] = set()
        if ipv4 is not None and ipv4 != state.public_ipv4:
            old = state.public_ipv4
            state.set_public_ipv4(ipv4)
            changed.add('ipv4')
            await self._dispatch.dispatch(
                'ip_changed',
                IpChangedEvent(old_ip=old, new_ip=ipv4, family='ipv4'))
        if ipv6 is not None and ipv6 != state.public_ipv6:
            old6 = state.public_ipv6
            state.set_public_ipv6(ipv6)
            changed.add('ipv6')
            await self._dispatch.dispatch(
                'ip_changed',
                IpChangedEvent(old_ip=old6, new_ip=ipv6, family='ipv6'))
        by_family: dict[IPFamily, str | None] = {
            'ipv4': state.public_ipv4, 'ipv6': state.public_ipv6}
        for domain in cfg.domains:
            family = _family_for(domain.record_type)
            ip = by_family[family]
            if not domain.enabled:
                if state.set_freshness(domain.id, ip) == 'pending':
                    await self._dispatch.dispatch(
                        'domain_update_pending',
                        DomainUpdatePendingEvent(
                            domain_id=domain.id, hostname=domain.hostname,
                            record_type=domain.record_type, family=family,
                            current_ip=ip))
                continue
            if ip is None:
                continue
            runtime = state.domains.get(domain.id)
            needs_retry = (cfg.settings.retry_on_failure and runtime is not None
                           and runtime.status == 'error')
            is_fresh = runtime is None or runtime.status == 'pending'
            if not (family in changed or is_fresh or needs_retry):
                continue
            before = runtime.status if runtime is not None else None
            terminal = await sync_domain(domain, ip, state)
            if terminal == before:
                continue
            if terminal == 'synced':
                await self._dispatch.dispatch(
                    'domain_update_success',
                    DomainUpdateSuccessEvent(
                        domain_id=domain.id, hostname=domain.hostname,
                        record_type=domain.record_type, family=family,
                        ip=ip))
            elif terminal == 'error':
                message = state.domains[domain.id].message
                await self._dispatch.dispatch(
                    'domain_update_error',
                    DomainUpdateErrorEvent(
                        domain_id=domain.id, hostname=domain.hostname,
                        record_type=domain.record_type, family=family,
                        ip=ip, message=message))
        self._publish_next_check(state)

    async def check_once(self, cfg: AppConfig, state: RuntimeState) -> None:
        """Run reachability then, if online, an IP sync (startup/refresh)."""
        await self.check_reachability(cfg, state)
        if state.online:
            await self.sync_ips(cfg, state)
