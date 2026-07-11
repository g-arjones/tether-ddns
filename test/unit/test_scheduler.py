"""Tests for scheduler dispatch and exception isolation."""
from unittest.mock import AsyncMock, MagicMock, patch

from pydantic import BaseModel

import pytest

from tether_ddns import scheduler
from tether_ddns.config import AppConfig, DomainConfig, HookConfig
from tether_ddns.hooks.base import (
    IpChangedEvent, ReachabilityChangedEvent, load_hooks)
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
    event = IpChangedEvent(old_ip='1.1.1.1', new_ip='2.2.2.2', family='ipv4')
    with patch(
        'tether_ddns.hooks.registered_hooks.log_hook.LogHook.on_ip_changed',
        new=AsyncMock(side_effect=RuntimeError('boom')),
    ):
        await scheduler.dispatch_ip_changed(event, cfg)  # must not raise


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
    assert state.public_ipv4 == '9.9.9.9'
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


def test_run_startup_check_registers_immediate_job() -> None:
    """run_startup_check adds a one-shot job with id 'startup'."""
    cfg = AppConfig()
    state = RuntimeState()
    sched = scheduler.Scheduler()
    fake = MagicMock()
    with patch.object(sched, '_scheduler', fake):
        sched.run_startup_check(cfg, state)
    kwargs = fake.add_job.call_args.kwargs
    assert kwargs['id'] == 'startup'
    assert kwargs['args'] == [cfg, state]
    assert fake.add_job.call_args.args[1] == 'date'


@pytest.mark.asyncio
async def test_check_once_retries_error_domain_without_ip_change() -> None:
    """Retry re-syncs an error domain even when the IP is unchanged."""
    load_providers()
    domain = DomainConfig(
        id='a', hostname='myhost', provider='duckdns',
        provider_config={'token': 'x', 'domain': 'myhost'},
    )
    cfg = AppConfig(domains=[domain])
    cfg.settings.retry_on_failure = True
    state = RuntimeState()
    state.rebuild(cfg)
    state.online = True
    state.set_public_ipv4('9.9.9.9')
    state.set_status('a', 'error', message='earlier failure')
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
    assert state.domains['a'].status == 'synced'


@pytest.mark.asyncio
async def test_check_once_no_retry_when_disabled() -> None:
    """With retry disabled an error domain is left untouched."""
    load_providers()
    domain = DomainConfig(
        id='a', hostname='myhost', provider='duckdns',
        provider_config={'token': 'x', 'domain': 'myhost'},
    )
    cfg = AppConfig(domains=[domain])
    cfg.settings.retry_on_failure = False
    state = RuntimeState()
    state.rebuild(cfg)
    state.online = True
    state.set_public_ipv4('9.9.9.9')
    state.set_status('a', 'error', message='earlier failure')
    sched = scheduler.Scheduler()
    update = AsyncMock()
    with patch(
        'tether_ddns.scheduler.ReachabilityService.check',
        new=AsyncMock(return_value=_online(True)),
    ), patch(
        'tether_ddns.scheduler.detect_public_ip',
        new=AsyncMock(return_value='9.9.9.9'),
    ), patch(
        'tether_ddns.providers.ddns_providers.duckdns.DuckDNSProvider.update',
        new=update,
    ):
        await sched.check_once(cfg, state)
    assert state.domains['a'].status == 'error'
    update.assert_not_called()


@pytest.mark.asyncio
async def test_reachability_transition_fires_hook_only_on_change() -> None:
    """check_reachability fires reachability_changed only on an online transition."""
    load_hooks()
    cfg = AppConfig(hooks=[HookConfig(id='h', hook='log', events=['reachability_changed'])])
    state = RuntimeState()
    sched = scheduler.Scheduler()
    with patch.object(sched, '_reachability') as reach:
        reach.check = AsyncMock(return_value=_online(True))
        with patch('tether_ddns.scheduler.dispatch_reachability_changed', new=AsyncMock()) as dh:
            await sched.check_reachability(cfg, state)
            assert state.online is True
            dh.assert_awaited_once()
            dh.reset_mock()
            await sched.check_reachability(cfg, state)  # no transition
            dh.assert_not_awaited()


@pytest.mark.asyncio
async def test_sync_ips_updates_families_and_syncs_by_record_type() -> None:
    """sync_ips detects both families and syncs A from v4, AAAA from v6."""
    load_providers()
    cfg = AppConfig(domains=[
        DomainConfig(id='a', hostname='a', provider='duckdns', record_type='A',
                     provider_config={'token': 'x', 'domain': 'a'}),
        DomainConfig(id='b', hostname='b', provider='duckdns', record_type='AAAA',
                     provider_config={'token': 'x', 'domain': 'b'}),
    ])
    state = RuntimeState()
    state.rebuild(cfg)
    state.online = True
    sched = scheduler.Scheduler()

    async def _detect(source: str, family: str) -> str:
        return '203.0.113.5' if family == 'ipv4' else '2001:db8::5'

    with patch('tether_ddns.scheduler.detect_public_ip', new=AsyncMock(side_effect=_detect)), \
         patch('tether_ddns.scheduler.sync_domain', new=AsyncMock()) as sd:
        await sched.sync_ips(cfg, state)
    assert state.public_ipv4 == '203.0.113.5'
    assert state.public_ipv6 == '2001:db8::5'
    calls = {c.args[0].id: c.args[1] for c in sd.await_args_list}
    assert calls['a'] == '203.0.113.5'
    assert calls['b'] == '2001:db8::5'


@pytest.mark.asyncio
async def test_dispatch_skips_unsupported_event() -> None:
    """A hook is not invoked for an event it does not support, even if enabled."""
    from tether_ddns.hooks.base import HOOK_REGISTRY, Hook, register_hook

    calls: list[str] = []

    @register_hook
    class _SpyHook(Hook):
        key = '_spy'
        display_name = 'Spy'

        async def on_ip_changed(
                self, event: IpChangedEvent, config: BaseModel) -> None:
            calls.append('ip_changed')

    try:
        assert HOOK_REGISTRY['_spy'] is _SpyHook
        cfg = AppConfig(hooks=[HookConfig(
            hook='_spy', enabled=True,
            events=['ip_changed', 'reachability_changed'], config={})])
        await scheduler.dispatch_reachability_changed(
            ReachabilityChangedEvent(online=True, was_online=False), cfg)
        assert calls == []
        await scheduler.dispatch_ip_changed(
            IpChangedEvent(old_ip='a', new_ip='b', family='ipv4'), cfg)
        assert calls == ['ip_changed']
    finally:
        HOOK_REGISTRY.pop('_spy', None)


@pytest.mark.asyncio
async def test_run_hook_now_fires_per_known_ip_family() -> None:
    """ip_changed fires once per known IP family with current values."""
    from tether_ddns.hooks.base import HOOK_REGISTRY, Hook, register_hook

    calls: list[tuple[str, object, object]] = []

    @register_hook
    class _SpyRun(Hook):
        key = '_spyrun'
        display_name = 'SpyRun'

        async def on_ip_changed(
                self, event: IpChangedEvent, config: BaseModel) -> None:
            calls.append(('ip_changed', event.old_ip, event.new_ip))

        async def on_reachability_changed(
                self, event: ReachabilityChangedEvent,
                config: BaseModel) -> None:
            calls.append(('reachability_changed', event.online, event.online))

    try:
        assert HOOK_REGISTRY['_spyrun'] is _SpyRun
        state = RuntimeState()
        state.set_public_ipv4('1.2.3.4')
        state.set_public_ipv6('2001:db8::9')
        state.set_online(True)
        cfg = AppConfig(hooks=[HookConfig(
            id='h', hook='_spyrun', enabled=True,
            events=['ip_changed', 'reachability_changed'], config={})])
        result = await scheduler.run_hook_now(cfg.hooks[0], cfg, state)
        assert result['ran'] == 3
        assert result['skipped'] == []
        assert ('ip_changed', '1.2.3.4', '1.2.3.4') in calls
        assert ('ip_changed', '2001:db8::9', '2001:db8::9') in calls
        assert ('reachability_changed', True, True) in calls
    finally:
        HOOK_REGISTRY.pop('_spyrun', None)


@pytest.mark.asyncio
async def test_run_hook_now_skips_ip_changed_when_no_ip() -> None:
    """ip_changed is skipped and reported when no IP is known."""
    from tether_ddns.hooks.base import HOOK_REGISTRY, Hook, register_hook

    ran: list[str] = []

    @register_hook
    class _SpyNoIp(Hook):
        key = '_spynoip'
        display_name = 'SpyNoIp'

        async def on_ip_changed(
                self, event: IpChangedEvent, config: BaseModel) -> None:
            ran.append('ip_changed')

    try:
        assert HOOK_REGISTRY['_spynoip'] is _SpyNoIp
        state = RuntimeState()
        cfg = AppConfig(hooks=[HookConfig(
            id='h', hook='_spynoip', enabled=True, events=['ip_changed'], config={})])
        result = await scheduler.run_hook_now(cfg.hooks[0], cfg, state)
        assert ran == []
        assert result['ran'] == 0
        assert result['skipped'] == ['ip_changed']
    finally:
        HOOK_REGISTRY.pop('_spynoip', None)


@pytest.mark.asyncio
async def test_run_hook_now_ignores_unsupported_enabled_event() -> None:
    """An enabled-but-unsupported event is neither run nor reported as skipped."""
    from tether_ddns.hooks.base import HOOK_REGISTRY, Hook, register_hook

    ran: list[str] = []

    @register_hook
    class _SpyUnsup(Hook):
        key = '_spyunsup'
        display_name = 'SpyUnsup'

        async def on_ip_changed(
                self, event: IpChangedEvent, config: BaseModel) -> None:
            ran.append('ip_changed')

    try:
        assert HOOK_REGISTRY['_spyunsup'] is _SpyUnsup
        state = RuntimeState()
        state.set_online(True)
        cfg = AppConfig(hooks=[HookConfig(
            id='h', hook='_spyunsup', enabled=True,
            events=['reachability_changed'], config={})])
        result = await scheduler.run_hook_now(cfg.hooks[0], cfg, state)
        assert ran == []
        assert result == {'ran': 0, 'skipped': []}
    finally:
        HOOK_REGISTRY.pop('_spyunsup', None)
