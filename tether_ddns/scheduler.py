"""APScheduler-driven periodic jobs with exception-isolated dispatch."""
from __future__ import annotations

from apscheduler.schedulers.asyncio import (  # pyright: ignore[reportMissingTypeStubs]
    AsyncIOScheduler,
)

from tether_ddns.config import AppConfig, DomainConfig
from tether_ddns.hooks.base import HOOK_REGISTRY, HookEvent
from tether_ddns.ip_sources.base import detect_public_ip
from tether_ddns.logging_setup import get_logger
from tether_ddns.providers.base import PROVIDER_REGISTRY
from tether_ddns.reachability import ReachabilityService
from tether_ddns.runtime import RuntimeState

_log = get_logger()


async def sync_domain(domain: DomainConfig, ip: str, state: RuntimeState) -> None:
    """Update a single domain, isolating provider exceptions."""
    provider_cls = PROVIDER_REGISTRY.get(domain.provider)
    if provider_cls is None:
        state.set_status(domain.id, 'error', message=f'Unknown provider {domain.provider}')
        return
    state.set_status(domain.id, 'updating')
    try:
        config = provider_cls.ConfigModel.model_validate(domain.provider_config)
        result = await provider_cls().update(domain.hostname, domain.record_type, ip, config)
    except Exception as exc:  # noqa: BLE001 - provider errors must be contained
        _log.exception('Provider %s failed for %s', domain.provider, domain.hostname)
        state.set_status(domain.id, 'error', message=str(exc))
        return
    if result.success:
        state.set_status(domain.id, 'synced', ip=result.ip or ip, message=result.message)
    else:
        state.set_status(domain.id, 'error', message=result.message)


async def dispatch_hooks(event: HookEvent, cfg: AppConfig) -> None:
    """Invoke every matching enabled hook, isolating exceptions."""
    for hook_cfg in cfg.hooks:
        if not hook_cfg.enabled or event.type not in hook_cfg.events:
            continue
        hook_cls = HOOK_REGISTRY.get(hook_cfg.hook)
        if hook_cls is None:
            _log.warning('Unknown hook %s', hook_cfg.hook)
            continue
        try:
            config = hook_cls.ConfigModel.model_validate(hook_cfg.config)
            await hook_cls().handle(event, config)
        except Exception:  # noqa: BLE001 - hook errors must be contained
            _log.exception('Hook %s failed on %s', hook_cfg.hook, event.type)


class Scheduler:
    """Owns the APScheduler instance and periodic checks."""

    def __init__(self) -> None:
        """Create an unstarted scheduler."""
        self._scheduler = AsyncIOScheduler()
        self._reachability = ReachabilityService()

    def start(self, cfg: AppConfig, state: RuntimeState) -> None:
        """Schedule the periodic check job and start the scheduler."""
        self._scheduler.add_job(  # pyright: ignore[reportUnknownMemberType]
            self.check_once, 'interval', seconds=cfg.settings.check_interval,
            args=[cfg, state], id='check', replace_existing=True,
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

    async def check_once(self, cfg: AppConfig, state: RuntimeState) -> None:
        """Run one reachability/IP check cycle, firing hooks and syncs."""
        reach = await self._reachability.check()
        if reach.online != state.online:
            old = 'online' if state.online else 'offline'
            new = 'online' if reach.online else 'offline'
            state.set_online(reach.online)
            await dispatch_hooks(
                HookEvent(type='reachability_changed', old=old, new=new), cfg)
        if not reach.online:
            return
        ip = await detect_public_ip(cfg.settings.ip_source)
        synced: set[str] = set()
        if ip is not None and ip != state.public_ip:
            old_ip = state.public_ip
            state.set_public_ip(ip)
            await dispatch_hooks(HookEvent(type='ip_changed', old=old_ip, new=ip), cfg)
            for domain in cfg.domains:
                if domain.enabled:
                    await sync_domain(domain, ip, state)
                    synced.add(domain.id)
        if cfg.settings.retry_on_failure and state.public_ip is not None:
            for domain in cfg.domains:
                runtime = state.domains.get(domain.id)
                if (domain.enabled and domain.id not in synced
                        and runtime is not None and runtime.status == 'error'):
                    await sync_domain(domain, state.public_ip, state)
