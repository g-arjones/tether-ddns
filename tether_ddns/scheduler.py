"""APScheduler-driven periodic jobs with exception-isolated dispatch."""
from __future__ import annotations

from apscheduler.schedulers.asyncio import (  # pyright: ignore[reportMissingTypeStubs]
    AsyncIOScheduler,
)

from tether_ddns.config import AppConfig, DomainConfig, HookConfig
from tether_ddns.hooks.base import (
    DomainUpdateErrorEvent, DomainUpdatePendingEvent,
    DomainUpdateSuccessEvent, HOOK_REGISTRY, IpChangedEvent,
    ReachabilityChangedEvent)
from tether_ddns.ip_sources.base import IPFamily, detect_public_ip
from tether_ddns.logging_setup import get_logger
from tether_ddns.providers.base import PROVIDER_REGISTRY
from tether_ddns.reachability import ReachabilityService
from tether_ddns.runtime import RuntimeState, Status

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
        result = await provider_cls().update(domain.hostname, domain.record_type, ip, config)
    except Exception as exc:  # noqa: BLE001 - provider errors must be contained
        _log.exception('Provider %s failed for %s', domain.provider, domain.hostname)
        state.set_status(domain.id, 'error', message=str(exc))
        return 'error'
    if result.success:
        state.set_status(domain.id, 'synced', ip=result.ip or ip, message=result.message)
        return 'synced'
    state.set_status(domain.id, 'error', message=result.message)
    return 'error'


async def _dispatch(event_key: str, event: object, cfg: AppConfig) -> None:
    """Invoke every matching enabled hook, isolating exceptions."""
    for hook_cfg in cfg.hooks:
        hook_cls = HOOK_REGISTRY.get(hook_cfg.hook)
        if hook_cls is None:
            _log.warning('Unknown hook %s', hook_cfg.hook)
            continue
        if (not hook_cfg.enabled
                or event_key not in hook_cfg.events
                or event_key not in hook_cls.supported_events()):
            continue
        try:
            config = hook_cls.ConfigModel.model_validate(hook_cfg.config)
            await hook_cls()._dispatch(  # type: ignore[reportPrivateUsage]  # noqa: SLF001
                event_key, event, config)  # type: ignore[arg-type]
        except Exception:  # noqa: BLE001 - hook errors must be contained
            _log.exception('Hook %s failed on %s', hook_cfg.hook, event_key)


async def dispatch_ip_changed(event: IpChangedEvent, cfg: AppConfig) -> None:
    """Dispatch an ip_changed event to matching hooks."""
    await _dispatch('ip_changed', event, cfg)


async def dispatch_reachability_changed(
        event: ReachabilityChangedEvent, cfg: AppConfig) -> None:
    """Dispatch a reachability_changed event to matching hooks."""
    await _dispatch('reachability_changed', event, cfg)


async def dispatch_domain_update_pending(
        event: DomainUpdatePendingEvent, cfg: AppConfig) -> None:
    """Dispatch a domain_update_pending event to matching hooks."""
    await _dispatch('domain_update_pending', event, cfg)


async def dispatch_domain_update_success(
        event: DomainUpdateSuccessEvent, cfg: AppConfig) -> None:
    """Dispatch a domain_update_success event to matching hooks."""
    await _dispatch('domain_update_success', event, cfg)


async def dispatch_domain_update_error(
        event: DomainUpdateErrorEvent, cfg: AppConfig) -> None:
    """Dispatch a domain_update_error event to matching hooks."""
    await _dispatch('domain_update_error', event, cfg)


async def run_hook_now(
    hook_cfg: HookConfig, cfg: AppConfig, state: RuntimeState,
) -> dict[str, object]:
    """Fire a hook for its enabled+supported events using current state.

    Returns {'ran': <handle invocations>, 'skipped': [<event keys skipped>]}.
    """
    hook_cls = HOOK_REGISTRY.get(hook_cfg.hook)
    if hook_cls is None:
        _log.warning('Unknown hook %s', hook_cfg.hook)
        return {'ran': 0, 'skipped': list(hook_cfg.events)}
    jobs: list[tuple[str, object]] = []
    skipped: list[str] = []
    supported = hook_cls.supported_events()
    for event_key in hook_cfg.events:
        if event_key not in supported:
            continue
        if event_key == 'reachability_changed':
            jobs.append((
                event_key,
                ReachabilityChangedEvent(
                    online=state.online, was_online=state.online)))
        elif event_key == 'ip_changed':
            candidates: tuple[tuple[IPFamily, str | None], ...] = (
                ('ipv4', state.public_ipv4), ('ipv6', state.public_ipv6))
            families: list[tuple[IPFamily, str]] = [
                (family, ip) for family, ip in candidates if ip]
            if not families:
                skipped.append('ip_changed')
            for family, ip in families:
                jobs.append((
                    event_key,
                    IpChangedEvent(old_ip=ip, new_ip=ip, family=family)))
        elif event_key in (
                'domain_update_pending', 'domain_update_success',
                'domain_update_error'):
            status_for_key = {
                'domain_update_pending': 'pending',
                'domain_update_success': 'synced',
                'domain_update_error': 'error',
            }[event_key]
            matched = False
            for domain in cfg.domains:
                runtime = state.domains.get(domain.id)
                if runtime is None or runtime.status != status_for_key:
                    continue
                family = _family_for(domain.record_type)
                if event_key == 'domain_update_pending':
                    current_ip = (state.public_ipv4 if family == 'ipv4'
                                  else state.public_ipv6)
                    jobs.append((event_key, DomainUpdatePendingEvent(
                        domain_id=domain.id, hostname=domain.hostname,
                        record_type=domain.record_type, family=family,
                        current_ip=current_ip)))
                    matched = True
                elif event_key == 'domain_update_success':
                    if runtime.ip is None:
                        continue
                    jobs.append((event_key, DomainUpdateSuccessEvent(
                        domain_id=domain.id, hostname=domain.hostname,
                        record_type=domain.record_type, family=family,
                        ip=runtime.ip)))
                    matched = True
                else:  # domain_update_error
                    jobs.append((event_key, DomainUpdateErrorEvent(
                        domain_id=domain.id, hostname=domain.hostname,
                        record_type=domain.record_type, family=family,
                        ip=runtime.ip, message=runtime.message)))
                    matched = True
            if not matched:
                skipped.append(event_key)
    ran = 0
    for event_key, event in jobs:
        try:
            config = hook_cls.ConfigModel.model_validate(hook_cfg.config)
            await hook_cls()._dispatch(  # type: ignore[reportPrivateUsage]  # noqa: SLF001
                event_key, event, config)  # type: ignore[arg-type]
        except Exception:  # noqa: BLE001 - hook errors must be contained
            _log.exception('Hook %s failed on %s', hook_cfg.hook, event_key)
        ran += 1
    return {'ran': ran, 'skipped': skipped}


class Scheduler:
    """Owns the APScheduler instance and periodic checks."""

    def __init__(self) -> None:
        """Create an unstarted scheduler."""
        self._scheduler = AsyncIOScheduler()
        self._reachability = ReachabilityService()

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

    async def check_reachability(self, cfg: AppConfig, state: RuntimeState) -> None:
        """Run the DNS-quorum check; fire reachability_changed on transition."""
        reach = await self._reachability.check()
        if reach.online != state.online:
            was_online = state.online
            state.set_online(reach.online)
            await dispatch_reachability_changed(
                ReachabilityChangedEvent(
                    online=reach.online, was_online=was_online), cfg)

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
            await dispatch_ip_changed(
                IpChangedEvent(old_ip=old, new_ip=ipv4, family='ipv4'), cfg)
        if ipv6 is not None and ipv6 != state.public_ipv6:
            old6 = state.public_ipv6
            state.set_public_ipv6(ipv6)
            changed.add('ipv6')
            await dispatch_ip_changed(
                IpChangedEvent(old_ip=old6, new_ip=ipv6, family='ipv6'), cfg)
        by_family: dict[IPFamily, str | None] = {
            'ipv4': state.public_ipv4, 'ipv6': state.public_ipv6}
        for domain in cfg.domains:
            family = _family_for(domain.record_type)
            ip = by_family[family]
            if not domain.enabled:
                if state.set_freshness(domain.id, ip) == 'pending':
                    await dispatch_domain_update_pending(
                        DomainUpdatePendingEvent(
                            domain_id=domain.id, hostname=domain.hostname,
                            record_type=domain.record_type, family=family,
                            current_ip=ip), cfg)
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
                await dispatch_domain_update_success(
                    DomainUpdateSuccessEvent(
                        domain_id=domain.id, hostname=domain.hostname,
                        record_type=domain.record_type, family=family,
                        ip=ip), cfg)
            elif terminal == 'error':
                message = state.domains[domain.id].message
                await dispatch_domain_update_error(
                    DomainUpdateErrorEvent(
                        domain_id=domain.id, hostname=domain.hostname,
                        record_type=domain.record_type, family=family,
                        ip=ip, message=message), cfg)

    async def check_once(self, cfg: AppConfig, state: RuntimeState) -> None:
        """Run reachability then, if online, an IP sync (startup/refresh)."""
        await self.check_reachability(cfg, state)
        if state.online:
            await self.sync_ips(cfg, state)
