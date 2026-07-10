"""Tests for scheduler dispatch and exception isolation."""
from unittest.mock import AsyncMock, patch

import pytest

from tether_ddns import scheduler
from tether_ddns.config import AppConfig, DomainConfig, HookConfig
from tether_ddns.hooks.base import HookEvent, load_hooks
from tether_ddns.providers.base import load_providers
from tether_ddns.reachability import ReachabilityResult
from tether_ddns.runtime import RuntimeState


def _online(online: bool) -> ReachabilityResult:
    return ReachabilityResult(online=online, successes=3 if online else 0, total=3)


@pytest.mark.asyncio
async def test_sync_domain_provider_exception_sets_error() -> None:
    """A provider that raises leaves the domain in error, not crashing."""
    load_providers()
    domain = DomainConfig(
        id='a', hostname='myhost', provider='duckdns',
        provider_config={'token': 'x', 'domain': 'myhost'},
    )
    state = RuntimeState()
    state.rebuild(AppConfig(domains=[domain]))
    with patch(
        'tether_ddns.providers.ddns_providers.duckdns.DuckDNSProvider.update',
        new=AsyncMock(side_effect=RuntimeError('boom')),
    ):
        await scheduler.sync_domain(domain, '1.2.3.4', state)
    assert state.domains['a'].status == 'error'


@pytest.mark.asyncio
async def test_dispatch_hooks_isolates_exceptions() -> None:
    """A raising hook does not prevent others from running."""
    load_hooks()
    cfg = AppConfig(hooks=[HookConfig(id='h', hook='log', events=['ip_changed'])])
    event = HookEvent(type='ip_changed', old='1.1.1.1', new='2.2.2.2')
    with patch(
        'tether_ddns.hooks.registered_hooks.log_hook.LogHook.handle',
        new=AsyncMock(side_effect=RuntimeError('boom')),
    ):
        await scheduler.dispatch_hooks(event, cfg)  # must not raise


@pytest.mark.asyncio
async def test_sync_domain_unknown_provider_sets_error() -> None:
    """An unknown provider yields an error status without raising."""
    domain = DomainConfig(id='a', hostname='h', provider='nope')
    state = RuntimeState()
    state.rebuild(AppConfig(domains=[domain]))
    await scheduler.sync_domain(domain, '1.2.3.4', state)
    assert state.domains['a'].status == 'error'


@pytest.mark.asyncio
async def test_sync_domain_success_marks_synced() -> None:
    """A successful provider update marks the domain synced."""
    load_providers()
    domain = DomainConfig(
        id='a', hostname='myhost', provider='duckdns',
        provider_config={'token': 'x', 'domain': 'myhost'},
    )
    state = RuntimeState()
    state.rebuild(AppConfig(domains=[domain]))
    from tether_ddns.providers.base import UpdateResult
    with patch(
        'tether_ddns.providers.ddns_providers.duckdns.DuckDNSProvider.update',
        new=AsyncMock(return_value=UpdateResult(success=True, ip='5.6.7.8')),
    ):
        await scheduler.sync_domain(domain, '1.2.3.4', state)
    assert state.domains['a'].status == 'synced'
    assert state.domains['a'].ip == '5.6.7.8'


@pytest.mark.asyncio
async def test_check_once_online_transition_and_ip_change() -> None:
    """Going online detects a new IP, fires hooks and syncs enabled domains."""
    load_providers()
    load_hooks()
    domain = DomainConfig(
        id='a', hostname='myhost', provider='duckdns',
        provider_config={'token': 'x', 'domain': 'myhost'},
    )
    cfg = AppConfig(
        domains=[domain],
        hooks=[HookConfig(hook='log', events=['ip_changed', 'reachability_changed'])],
    )
    state = RuntimeState()
    state.rebuild(cfg)
    sched = scheduler.Scheduler()
    from tether_ddns.providers.base import UpdateResult
    with patch(
        'tether_ddns.scheduler.ReachabilityService.check',
        new=AsyncMock(return_value=_online(True)),
    ), patch(
        'tether_ddns.scheduler.detect_public_ip',
        new=AsyncMock(return_value='9.9.9.9'),
    ), patch(
        'tether_ddns.providers.ddns_providers.duckdns.DuckDNSProvider.update',
        new=AsyncMock(return_value=UpdateResult(success=True, ip='9.9.9.9')),
    ):
        await sched.check_once(cfg, state)
    assert state.online is True
    assert state.public_ip == '9.9.9.9'
    assert state.domains['a'].status == 'synced'


@pytest.mark.asyncio
async def test_check_once_offline_returns_early() -> None:
    """Staying offline does not attempt IP detection."""
    cfg = AppConfig()
    state = RuntimeState()
    sched = scheduler.Scheduler()
    detect = AsyncMock(return_value='1.1.1.1')
    with patch(
        'tether_ddns.scheduler.ReachabilityService.check',
        new=AsyncMock(return_value=_online(False)),
    ), patch('tether_ddns.scheduler.detect_public_ip', new=detect):
        await sched.check_once(cfg, state)
    assert state.online is False
    detect.assert_not_called()


@pytest.mark.asyncio
async def test_scheduler_start_and_shutdown() -> None:
    """Start schedules the job and shutdown stops cleanly."""
    cfg = AppConfig()
    state = RuntimeState()
    sched = scheduler.Scheduler()
    sched.start(cfg, state)
    sched.shutdown()
    sched.shutdown()  # idempotent when already stopped
