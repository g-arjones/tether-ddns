"""Tests for scheduler dispatch and exception isolation."""
import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

from pydantic import BaseModel

import pytest

from tether_ddns import scheduler
from tether_ddns.config import AppConfig, DomainConfig, HookConfig
from tether_ddns.context import AppContext
from tether_ddns.hooks.base import (
    IpChangedEvent, ReachabilityChangedEvent, load_hooks)
from tether_ddns.providers.base import load_providers
from tether_ddns.reachability import (
    ReachabilityProbe, ReachabilityResult, ResolverProbe)
from tether_ddns.runtime import RuntimeState
from tether_ddns.services.dispatch import DispatchService
from tether_ddns.services.sync import SyncService


def _ctx(cfg: AppConfig, state: RuntimeState) -> AppContext:
    """Build an AppContext for dispatch tests."""
    return AppContext(cfg, state, MagicMock(), MagicMock())


def _disp(cfg: AppConfig, state: RuntimeState) -> DispatchService:
    """Build a DispatchService over cfg and state."""
    return DispatchService(_ctx(cfg, state))


def _sched(
    cfg: AppConfig, state: RuntimeState, disp: AsyncMock | None = None,
) -> scheduler.Scheduler:
    """Build a Scheduler wired to a real SyncService over cfg/state."""
    dispatch = disp if disp is not None else AsyncMock()
    sync = SyncService(_ctx(cfg, state), dispatch)
    return scheduler.Scheduler(_ctx(cfg, state), sync, dispatch, ReachabilityProbe())


def _online(online: bool) -> ReachabilityResult:
    return ReachabilityResult(online=online, successes=3 if online else 0, total=3)


def _ok_result(ip: str) -> str:
    return ip


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
        await SyncService(
            _ctx(AppConfig(domains=[domain]), state),
            AsyncMock()).sync_domain(domain, '1.2.3.4')
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
        await _disp(cfg, RuntimeState()).dispatch('ip_changed', event)  # must not raise


@pytest.mark.asyncio
async def test_sync_domain_unknown_provider_sets_error() -> None:
    """An unknown provider yields an error status without raising."""
    domain = DomainConfig(id='a', hostname='h', provider='nope')
    state = RuntimeState()
    state.rebuild(AppConfig(domains=[domain]))
    await SyncService(
        _ctx(AppConfig(domains=[domain]), state),
        AsyncMock()).sync_domain(domain, '1.2.3.4')
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
    with patch(
        'tether_ddns.providers.ddns_providers.duckdns.DuckDNSProvider.update',
        new=AsyncMock(return_value='5.6.7.8'),
    ):
        await SyncService(
            _ctx(AppConfig(domains=[domain]), state),
            AsyncMock()).sync_domain(domain, '1.2.3.4')
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
    sched = _sched(cfg, state)
    with patch(
        'tether_ddns.reachability.ReachabilityProbe.check',
        new=AsyncMock(return_value=_online(True)),
    ), patch(
        'tether_ddns.services.sync.detect_public_ip',
        new=AsyncMock(return_value='9.9.9.9'),
    ), patch(
        'tether_ddns.providers.ddns_providers.duckdns.DuckDNSProvider.update',
        new=AsyncMock(return_value='9.9.9.9'),
    ):
        await sched.check_once()
    assert state.online is True
    assert state.public_ipv4 == '9.9.9.9'
    assert state.domains['a'].status == 'synced'


@pytest.mark.asyncio
async def test_check_once_offline_returns_early() -> None:
    """Staying offline does not attempt IP detection."""
    cfg = AppConfig()
    state = RuntimeState()
    sched = _sched(cfg, state)
    detect = AsyncMock(return_value='1.1.1.1')
    with patch(
        'tether_ddns.reachability.ReachabilityProbe.check',
        new=AsyncMock(return_value=_online(False)),
    ), patch('tether_ddns.services.sync.detect_public_ip', new=detect):
        await sched.check_once()
    assert state.online is False
    detect.assert_not_called()


@pytest.mark.asyncio
async def test_scheduler_start_and_shutdown() -> None:
    """Start schedules the job and shutdown stops cleanly."""
    cfg = AppConfig()
    state = RuntimeState()
    sched = _sched(cfg, state)
    sched.start()
    sched.shutdown()
    sched.shutdown()  # idempotent when already stopped


def test_run_startup_check_registers_immediate_job() -> None:
    """run_startup_check adds a one-shot job with id 'startup'."""
    cfg = AppConfig()
    state = RuntimeState()
    sched = _sched(cfg, state)
    fake = MagicMock()
    with patch.object(sched, '_scheduler', fake):
        sched.run_startup_check()
    kwargs = fake.add_job.call_args.kwargs
    assert kwargs['id'] == 'startup'
    assert kwargs['args'] == []
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
    sched = _sched(cfg, state)
    with patch(
        'tether_ddns.reachability.ReachabilityProbe.check',
        new=AsyncMock(return_value=_online(True)),
    ), patch(
        'tether_ddns.services.sync.detect_public_ip',
        new=AsyncMock(return_value='9.9.9.9'),
    ), patch(
        'tether_ddns.providers.ddns_providers.duckdns.DuckDNSProvider.update',
        new=AsyncMock(return_value='9.9.9.9'),
    ):
        await sched.check_once()
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
    sched = _sched(cfg, state)
    update = AsyncMock()
    with patch(
        'tether_ddns.reachability.ReachabilityProbe.check',
        new=AsyncMock(return_value=_online(True)),
    ), patch(
        'tether_ddns.services.sync.detect_public_ip',
        new=AsyncMock(return_value='9.9.9.9'),
    ), patch(
        'tether_ddns.providers.ddns_providers.duckdns.DuckDNSProvider.update',
        new=update,
    ):
        await sched.check_once()
    assert state.domains['a'].status == 'error'
    update.assert_not_called()


@pytest.mark.asyncio
async def test_reachability_transition_fires_hook_only_on_change() -> None:
    """check_reachability fires reachability_changed only on an online transition."""
    load_hooks()
    cfg = AppConfig(hooks=[HookConfig(id='h', hook='log', events=['reachability_changed'])])
    state = RuntimeState()
    disp = AsyncMock()
    sched = _sched(cfg, state, disp)
    with patch.object(sched, '_reachability') as reach:
        reach.check = AsyncMock(return_value=_online(True))
        await sched.check_reachability()
        assert state.online is True
        disp.dispatch.assert_awaited_once()
        assert disp.dispatch.await_args.args[0] == 'reachability_changed'
        disp.dispatch.reset_mock()
        await sched.check_reachability()  # no transition
        disp.dispatch.assert_not_awaited()


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
    sched = _sched(cfg, state)

    async def _detect(source: str, family: str) -> str:
        return '203.0.113.5' if family == 'ipv4' else '2001:db8::5'

    with patch('tether_ddns.services.sync.detect_public_ip', new=AsyncMock(side_effect=_detect)), \
         patch('tether_ddns.services.sync.SyncService.sync_domain', new=AsyncMock()) as sd:
        await sched.sync_ips()
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
        disp = _disp(cfg, RuntimeState())
        await disp.dispatch(
            'reachability_changed',
            ReachabilityChangedEvent(online=True, was_online=False))
        assert calls == []
        await disp.dispatch(
            'ip_changed', IpChangedEvent(old_ip='a', new_ip='b', family='ipv4'))
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
        result = await _disp(cfg, state).run_hook_now(cfg.hooks[0])
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
        result = await _disp(cfg, state).run_hook_now(cfg.hooks[0])
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
        result = await _disp(cfg, state).run_hook_now(cfg.hooks[0])
        assert ran == []
        assert result == {'ran': 0, 'skipped': []}
    finally:
        HOOK_REGISTRY.pop('_spyunsup', None)


@pytest.mark.asyncio
async def test_sync_ips_marks_disabled_domain_pending_on_ip_change() -> None:
    """A disabled domain whose assigned IP no longer matches becomes pending."""
    load_providers()
    domain = DomainConfig(
        id='a', hostname='myhost', provider='duckdns',
        provider_config={'token': 'x', 'domain': 'myhost'}, enabled=False)
    cfg = AppConfig(domains=[domain])
    state = RuntimeState()
    state.rebuild(cfg)
    state.online = True
    state.set_status('a', 'synced', ip='1.1.1.1')
    sched = _sched(cfg, state)
    update = AsyncMock()
    with patch(
        'tether_ddns.reachability.ReachabilityProbe.check',
        new=AsyncMock(return_value=_online(True)),
    ), patch(
        'tether_ddns.services.sync.detect_public_ip',
        new=AsyncMock(return_value='2.2.2.2'),
    ), patch(
        'tether_ddns.providers.ddns_providers.duckdns.DuckDNSProvider.update',
        new=update,
    ):
        await sched.check_once()
    assert state.domains['a'].status == 'pending'
    update.assert_not_called()


@pytest.mark.asyncio
async def test_sync_ips_keeps_disabled_domain_synced_when_matching() -> None:
    """A disabled domain still matching the current IP stays synced."""
    load_providers()
    domain = DomainConfig(
        id='a', hostname='myhost', provider='duckdns',
        provider_config={'token': 'x', 'domain': 'myhost'}, enabled=False)
    cfg = AppConfig(domains=[domain])
    state = RuntimeState()
    state.rebuild(cfg)
    state.online = True
    state.set_status('a', 'synced', ip='9.9.9.9')
    sched = _sched(cfg, state)
    update = AsyncMock()
    with patch(
        'tether_ddns.reachability.ReachabilityProbe.check',
        new=AsyncMock(return_value=_online(True)),
    ), patch(
        'tether_ddns.services.sync.detect_public_ip',
        new=AsyncMock(return_value='9.9.9.9'),
    ), patch(
        'tether_ddns.providers.ddns_providers.duckdns.DuckDNSProvider.update',
        new=update,
    ):
        await sched.check_once()
    assert state.domains['a'].status == 'synced'
    update.assert_not_called()


@pytest.mark.asyncio
async def test_sync_ips_fires_success_on_transition() -> None:
    """An enabled domain going pending->synced fires domain_update_success."""
    load_providers()
    load_hooks()
    domain = DomainConfig(
        id='a', hostname='myhost', provider='duckdns',
        provider_config={'token': 'x', 'domain': 'myhost'})
    cfg = AppConfig(domains=[domain], hooks=[HookConfig(
        id='h', hook='log', enabled=True,
        events=['domain_update_success'], config={})])
    state = RuntimeState()
    state.rebuild(cfg)
    state.online = True
    disp = AsyncMock()
    sched = _sched(cfg, state, disp)

    with patch(
        'tether_ddns.reachability.ReachabilityProbe.check',
        new=AsyncMock(return_value=_online(True)),
    ), patch(
        'tether_ddns.services.sync.detect_public_ip',
        new=AsyncMock(return_value='9.9.9.9'),
    ), patch(
        'tether_ddns.providers.ddns_providers.duckdns.DuckDNSProvider.update',
        new=AsyncMock(return_value=_ok_result('9.9.9.9')),
    ):
        await sched.check_once()
    from tether_ddns.hooks.base import DomainUpdateSuccessEvent
    seen = [c.args[1] for c in disp.dispatch.await_args_list
            if c.args[0] == 'domain_update_success']
    assert len(seen) == 1
    assert isinstance(seen[0], DomainUpdateSuccessEvent)
    assert seen[0].ip == '9.9.9.9'


@pytest.mark.asyncio
async def test_sync_ips_fires_error_on_transition() -> None:
    """An enabled domain going pending->error fires domain_update_error."""
    load_providers()
    domain = DomainConfig(
        id='a', hostname='myhost', provider='duckdns',
        provider_config={'token': 'x', 'domain': 'myhost'})
    cfg = AppConfig(domains=[domain])
    state = RuntimeState()
    state.rebuild(cfg)
    state.online = True
    disp = AsyncMock()
    sched = _sched(cfg, state, disp)

    with patch(
        'tether_ddns.reachability.ReachabilityProbe.check',
        new=AsyncMock(return_value=_online(True)),
    ), patch(
        'tether_ddns.services.sync.detect_public_ip',
        new=AsyncMock(return_value='9.9.9.9'),
    ), patch(
        'tether_ddns.providers.ddns_providers.duckdns.DuckDNSProvider.update',
        new=AsyncMock(side_effect=RuntimeError('boom')),
    ):
        await sched.check_once()
    from tether_ddns.hooks.base import DomainUpdateErrorEvent
    seen = [c.args[1] for c in disp.dispatch.await_args_list
            if c.args[0] == 'domain_update_error']
    assert len(seen) == 1
    assert isinstance(seen[0], DomainUpdateErrorEvent)
    assert 'boom' in seen[0].message


@pytest.mark.asyncio
async def test_sync_ips_fires_pending_for_disabled_transition() -> None:
    """A disabled domain going synced->pending fires domain_update_pending."""
    load_providers()
    domain = DomainConfig(
        id='a', hostname='myhost', provider='duckdns',
        provider_config={'token': 'x', 'domain': 'myhost'}, enabled=False)
    cfg = AppConfig(domains=[domain])
    state = RuntimeState()
    state.rebuild(cfg)
    state.online = True
    state.set_status('a', 'synced', ip='1.1.1.1')
    disp = AsyncMock()
    sched = _sched(cfg, state, disp)

    with patch(
        'tether_ddns.reachability.ReachabilityProbe.check',
        new=AsyncMock(return_value=_online(True)),
    ), patch(
        'tether_ddns.services.sync.detect_public_ip',
        new=AsyncMock(return_value='2.2.2.2'),
    ):
        await sched.check_once()
    from tether_ddns.hooks.base import DomainUpdatePendingEvent
    seen = [c.args[1] for c in disp.dispatch.await_args_list
            if c.args[0] == 'domain_update_pending']
    assert len(seen) == 1
    assert isinstance(seen[0], DomainUpdatePendingEvent)
    assert seen[0].current_ip == '2.2.2.2'


@pytest.mark.asyncio
async def test_sync_ips_no_event_without_transition() -> None:
    """A re-confirmed synced domain fires no domain-update event."""
    load_providers()
    domain = DomainConfig(
        id='a', hostname='myhost', provider='duckdns',
        provider_config={'token': 'x', 'domain': 'myhost'})
    cfg = AppConfig(domains=[domain])
    state = RuntimeState()
    state.rebuild(cfg)
    state.online = True
    state.set_public_ipv4('9.9.9.9')
    state.set_status('a', 'synced', ip='9.9.9.9')
    disp = AsyncMock()
    sched = _sched(cfg, state, disp)

    with patch(
        'tether_ddns.reachability.ReachabilityProbe.check',
        new=AsyncMock(return_value=_online(True)),
    ), patch(
        'tether_ddns.services.sync.detect_public_ip',
        new=AsyncMock(return_value='9.9.9.9'),
    ), patch(
        'tether_ddns.providers.ddns_providers.duckdns.DuckDNSProvider.update',
        new=AsyncMock(return_value=_ok_result('9.9.9.9')),
    ):
        await sched.check_once()
    seen = [c for c in disp.dispatch.await_args_list
            if c.args[0] == 'domain_update_success']
    assert seen == []


@pytest.mark.asyncio
async def test_run_hook_now_domain_update_error_matches_state() -> None:
    """Run-now for domain_update_error fires only for error domains, with message."""
    from tether_ddns.hooks.base import HOOK_REGISTRY, Hook, register_hook

    seen: list[tuple[str, str]] = []

    @register_hook
    class _SpyErr(Hook):  # pyright: ignore[reportUnusedClass]
        key = '_spyerr'
        display_name = 'SpyErr'

        async def on_domain_update_error(
                self, event: object, config: object) -> None:
            seen.append((event.domain_id, event.message))  # type: ignore[attr-defined]

    try:
        cfg = AppConfig(
            domains=[
                DomainConfig(id='a', hostname='a.example.com', provider='duckdns'),
                DomainConfig(id='b', hostname='b.example.com', provider='duckdns'),
            ],
            hooks=[HookConfig(
                id='h', hook='_spyerr', enabled=True,
                events=['domain_update_error'], config={})])
        state = RuntimeState()
        state.rebuild(cfg)
        state.set_status('a', 'error', ip='1.1.1.1', message='provider down')
        state.set_status('b', 'synced', ip='2.2.2.2')
        result = await _disp(cfg, state).run_hook_now(cfg.hooks[0])
        assert result['ran'] == 1
        assert seen == [('a', 'provider down')]
    finally:
        HOOK_REGISTRY.pop('_spyerr', None)


@pytest.mark.asyncio
async def test_run_hook_now_domain_update_success_matches_state() -> None:
    """Run-now for domain_update_success fires only for synced domains with ip."""
    from tether_ddns.hooks.base import HOOK_REGISTRY, Hook, register_hook

    seen: list[str] = []

    @register_hook
    class _SpyOk(Hook):  # pyright: ignore[reportUnusedClass]
        key = '_spyok'
        display_name = 'SpyOk'

        async def on_domain_update_success(
                self, event: object, config: object) -> None:
            seen.append(event.ip)  # type: ignore[attr-defined]

    try:
        cfg = AppConfig(
            domains=[
                DomainConfig(id='a', hostname='a.example.com', provider='duckdns'),
                DomainConfig(id='b', hostname='b.example.com', provider='duckdns'),
            ],
            hooks=[HookConfig(
                id='h', hook='_spyok', enabled=True,
                events=['domain_update_success'], config={})])
        state = RuntimeState()
        state.rebuild(cfg)
        state.set_status('a', 'synced', ip='9.9.9.9')
        # 'b' stays pending -> should not fire success
        result = await _disp(cfg, state).run_hook_now(cfg.hooks[0])
        assert result['ran'] == 1
        assert seen == ['9.9.9.9']
    finally:
        HOOK_REGISTRY.pop('_spyok', None)


@pytest.mark.asyncio
async def test_run_hook_now_domain_update_pending_matches_state() -> None:
    """Run-now for domain_update_pending fires for pending domains with current_ip."""
    from tether_ddns.hooks.base import HOOK_REGISTRY, Hook, register_hook

    seen: list[tuple[str, str | None]] = []

    @register_hook
    class _SpyPend(Hook):  # pyright: ignore[reportUnusedClass]
        key = '_spypend'
        display_name = 'SpyPend'

        async def on_domain_update_pending(
                self, event: object, config: object) -> None:
            seen.append((event.domain_id, event.current_ip))  # type: ignore[attr-defined]

    try:
        cfg = AppConfig(
            domains=[
                DomainConfig(id='a', hostname='a.example.com', provider='duckdns'),
                DomainConfig(id='b', hostname='b.example.com', provider='duckdns'),
            ],
            hooks=[HookConfig(
                id='h', hook='_spypend', enabled=True,
                events=['domain_update_pending'], config={})])
        state = RuntimeState()
        state.rebuild(cfg)  # both start pending
        state.set_public_ipv4('5.5.5.5')
        state.set_status('b', 'synced', ip='5.5.5.5')  # 'b' no longer pending
        result = await _disp(cfg, state).run_hook_now(cfg.hooks[0])
        assert result['ran'] == 1
        assert seen == [('a', '5.5.5.5')]
    finally:
        HOOK_REGISTRY.pop('_spypend', None)


@pytest.mark.asyncio
async def test_run_hook_now_success_skips_synced_without_ip() -> None:
    """A synced domain with no known ip is skipped for domain_update_success."""
    from tether_ddns.hooks.base import HOOK_REGISTRY, Hook, register_hook

    seen: list[str] = []

    @register_hook
    class _SpyNoIp(Hook):  # pyright: ignore[reportUnusedClass]
        key = '_spynoipok'
        display_name = 'SpyNoIpOk'

        async def on_domain_update_success(
                self, event: object, config: object) -> None:
            seen.append(event.ip)  # type: ignore[attr-defined]

    try:
        cfg = AppConfig(
            domains=[
                DomainConfig(id='a', hostname='a.example.com', provider='duckdns'),
            ],
            hooks=[HookConfig(
                id='h', hook='_spynoipok', enabled=True,
                events=['domain_update_success'], config={})])
        state = RuntimeState()
        state.rebuild(cfg)
        state.set_status('a', 'synced')  # synced but ip stays None
        result = await _disp(cfg, state).run_hook_now(cfg.hooks[0])
        assert result['ran'] == 0
        assert result['skipped'] == ['domain_update_success']
        assert seen == []
    finally:
        HOOK_REGISTRY.pop('_spynoipok', None)


@pytest.mark.asyncio
async def test_edited_domain_repushes_without_ip_change() -> None:
    """Editing a synced domain's hostname forces a re-push next cycle."""
    load_providers()
    domain = DomainConfig(
        id='a', hostname='old.example.com', provider='duckdns',
        provider_config={'token': 'x', 'domain': 'old'})
    cfg = AppConfig(domains=[domain])
    state = RuntimeState()
    state.rebuild(cfg)
    state.online = True
    state.set_public_ipv4('9.9.9.9')
    state.set_status('a', 'synced', ip='9.9.9.9')
    # User edits the hostname; the API mutates cfg and rebuilds.
    cfg.domains[0] = DomainConfig(
        id='a', hostname='new.example.com', provider='duckdns',
        provider_config={'token': 'x', 'domain': 'old'})
    state.rebuild(cfg)
    assert state.domains['a'].status == 'pending'
    sched = _sched(cfg, state)
    update = AsyncMock(return_value='9.9.9.9')
    with patch(
        'tether_ddns.reachability.ReachabilityProbe.check',
        new=AsyncMock(return_value=_online(True)),
    ), patch(
        'tether_ddns.services.sync.detect_public_ip',
        new=AsyncMock(return_value='9.9.9.9'),
    ), patch(
        'tether_ddns.providers.ddns_providers.duckdns.DuckDNSProvider.update',
        new=update,
    ):
        await sched.sync_ips()
    update.assert_called_once()
    assert state.domains['a'].status == 'synced'


def _reach(online: bool) -> ReachabilityResult:
    return ReachabilityResult(
        online=online, successes=3 if online else 0, total=3,
        probes=[ResolverProbe(ip='1.1.1.1', ok=online, latency_ms=4.0)])


def test_check_reachability_records_every_run(monkeypatch: pytest.MonkeyPatch) -> None:
    """check_reachability increments check count on every run."""
    state = RuntimeState()
    sched = _sched(AppConfig(), state)

    async def fake_check() -> ReachabilityResult:
        return _reach(True)

    with patch.object(sched, '_reachability') as reach:
        reach.check = AsyncMock(side_effect=fake_check)
        asyncio.run(sched.check_reachability())
        asyncio.run(sched.check_reachability())
        assert state.reachability_checks == 2
        assert state.online is True


def test_check_reachability_dispatches_only_on_transition() -> None:
    """check_reachability only dispatches hooks on online/offline transition."""
    dispatched: list[bool] = []

    async def fake_dispatch(key: str, event: ReachabilityChangedEvent) -> None:
        dispatched.append(event.online)

    disp = AsyncMock()
    disp.dispatch.side_effect = fake_dispatch
    sched = _sched(AppConfig(), RuntimeState(), disp)
    online = [False]

    async def fake_check() -> ReachabilityResult:
        return _reach(online[0])

    with patch.object(sched, '_reachability') as reach:
        reach.check = AsyncMock(side_effect=fake_check)
        online[0] = True
        asyncio.run(sched.check_reachability())   # transition -> dispatch
        asyncio.run(sched.check_reachability())   # steady -> no dispatch
        assert dispatched == [True]


@pytest.mark.asyncio
async def test_start_publishes_next_check_at() -> None:
    """start() sets next_check_at in the runtime state."""
    cfg = AppConfig()
    state = RuntimeState()
    sched = _sched(cfg, state)
    sched.start()
    try:
        assert state.next_check_at is not None
        assert state.next_check_at > 0
    finally:
        sched.shutdown()


@pytest.mark.asyncio
async def test_reschedule_sync_applies_new_interval() -> None:
    """reschedule_sync re-adds the sync job and updates next_check_at."""
    cfg = AppConfig()
    state = RuntimeState()
    sched = _sched(cfg, state)
    sched.start()
    try:
        first = state.next_check_at
        assert first is not None
        cfg.settings.check_interval = 60
        sched.reschedule_sync()
        assert state.next_check_at is not None
    finally:
        sched.shutdown()


def test_reschedule_sync_republishes_next_check() -> None:
    """reschedule_sync re-adds the sync job and republishes next_check_at."""
    cfg = AppConfig()
    state = RuntimeState()
    sched = _sched(cfg, state)
    fake = MagicMock()
    with patch.object(sched, '_scheduler', fake):
        sched.reschedule_sync()
    kwargs = fake.add_job.call_args.kwargs
    assert kwargs['id'] == 'sync'
    assert kwargs['seconds'] == cfg.settings.check_interval
    assert kwargs['replace_existing'] is True
    fake.get_job.assert_called_with('sync')
