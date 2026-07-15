"""Tests for DispatchService dispatch and run_hook_now."""
from unittest.mock import AsyncMock, MagicMock

import pytest

from tether_ddns.config import AppConfig, HookConfig
from tether_ddns.context import AppContext
from tether_ddns.hooks.base import HOOK_REGISTRY, ReachabilityChangedEvent
from tether_ddns.runtime import RuntimeState
from tether_ddns.services.dispatch import DispatchService


def _ctx(cfg: AppConfig) -> AppContext:
    """Build an AppContext with the given config and a fresh runtime."""
    return AppContext(cfg, RuntimeState(), MagicMock(), MagicMock(), MagicMock())


@pytest.mark.asyncio
async def test_dispatch_invokes_matching_enabled_hook() -> None:
    """A subscribed, enabled, supported hook is dispatched."""
    hook_cls = MagicMock()
    hook_cls.supported_events.return_value = ('reachability_changed',)
    instance = MagicMock()
    instance.handle = AsyncMock()
    hook_cls.return_value = instance
    hook_cls.ConfigModel.model_validate.return_value = MagicMock()
    hc = HookConfig(hook='fake', enabled=True, events=['reachability_changed'])
    cfg = AppConfig(hooks=[hc])
    with pytest.MonkeyPatch.context() as mp:
        mp.setitem(HOOK_REGISTRY, 'fake', hook_cls)
        svc = DispatchService(_ctx(cfg))
        await svc.dispatch(
            'reachability_changed',
            ReachabilityChangedEvent(online=True, was_online=False))
    instance.handle.assert_awaited_once()


@pytest.mark.asyncio
async def test_dispatch_skips_disabled_hook() -> None:
    """A disabled hook is not dispatched."""
    hook_cls = MagicMock()
    hook_cls.supported_events.return_value = ('reachability_changed',)
    instance = MagicMock()
    instance.handle = AsyncMock()
    hook_cls.return_value = instance
    hc = HookConfig(hook='fake', enabled=False, events=['reachability_changed'])
    cfg = AppConfig(hooks=[hc])
    with pytest.MonkeyPatch.context() as mp:
        mp.setitem(HOOK_REGISTRY, 'fake', hook_cls)
        svc = DispatchService(_ctx(cfg))
        await svc.dispatch(
            'reachability_changed',
            ReachabilityChangedEvent(online=True))
    instance.handle.assert_not_awaited()


@pytest.mark.asyncio
async def test_run_hook_now_unknown_hook_skips_all() -> None:
    """An unknown hook key skips all its configured events."""
    hc = HookConfig(hook='ghost', events=['ip_changed'])
    svc = DispatchService(_ctx(AppConfig(hooks=[hc])))
    result = await svc.run_hook_now(hc)
    assert result == {'ran': 0, 'skipped': ['ip_changed']}


@pytest.mark.asyncio
async def test_dispatch_skips_unsupported_event() -> None:
    """A hook subscribed to an event it does not support is not dispatched."""
    hook_cls = MagicMock()
    hook_cls.supported_events.return_value = ('ip_changed',)
    instance = MagicMock()
    instance.handle = AsyncMock()
    hook_cls.return_value = instance
    hc = HookConfig(hook='fake', enabled=True, events=['reachability_changed'])
    cfg = AppConfig(hooks=[hc])
    with pytest.MonkeyPatch.context() as mp:
        mp.setitem(HOOK_REGISTRY, 'fake', hook_cls)
        svc = DispatchService(_ctx(cfg))
        await svc.dispatch(
            'reachability_changed',
            ReachabilityChangedEvent(online=True))
    instance.handle.assert_not_awaited()


@pytest.mark.asyncio
async def test_dispatch_isolates_hook_exception() -> None:
    """A hook whose dispatch raises does not propagate to the caller."""
    hook_cls = MagicMock()
    hook_cls.supported_events.return_value = ('reachability_changed',)
    instance = MagicMock()
    instance.handle = AsyncMock(side_effect=RuntimeError('boom'))
    hook_cls.return_value = instance
    hook_cls.ConfigModel.model_validate.return_value = MagicMock()
    hc = HookConfig(hook='fake', enabled=True, events=['reachability_changed'])
    cfg = AppConfig(hooks=[hc])
    with pytest.MonkeyPatch.context() as mp:
        mp.setitem(HOOK_REGISTRY, 'fake', hook_cls)
        svc = DispatchService(_ctx(cfg))
        await svc.dispatch(
            'reachability_changed',
            ReachabilityChangedEvent(online=True))
    instance.handle.assert_awaited_once()


@pytest.mark.asyncio
async def test_run_hook_now_skips_event_with_no_synthesized_events() -> None:
    """An event that synthesizes no events from context is skipped."""
    hook_cls = MagicMock()
    hook_cls.supported_events.return_value = ('ip_changed',)
    instance = MagicMock()
    instance.handle = AsyncMock()
    hook_cls.return_value = instance
    hook_cls.ConfigModel.model_validate.return_value = MagicMock()
    hc = HookConfig(hook='fake', enabled=True, events=['ip_changed'])
    cfg = AppConfig(hooks=[hc])
    with pytest.MonkeyPatch.context() as mp:
        mp.setitem(HOOK_REGISTRY, 'fake', hook_cls)
        svc = DispatchService(_ctx(cfg))
        result = await svc.run_hook_now(hc)
    assert result == {'ran': 0, 'skipped': ['ip_changed']}
