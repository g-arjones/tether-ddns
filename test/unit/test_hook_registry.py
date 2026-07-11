"""Tests for the hook registry and the built-in log hook."""
from pydantic import BaseModel

import pytest

from tether_ddns.hooks import base


def test_register_hook_adds_to_registry() -> None:
    """The decorator registers a hook by its key."""
    @base.register_hook
    class _Dummy(base.Hook):
        key = 'dummy-hook'
        display_name = 'Dummy'

        async def handle(self, event: base.HookEvent, config: BaseModel) -> None:
            return None

    assert base.HOOK_REGISTRY['dummy-hook'] is _Dummy


def test_load_hooks_imports_builtin_log_hook() -> None:
    """Auto-loading discovers the shipped log hook."""
    base.load_hooks()
    assert 'log' in base.HOOK_REGISTRY


@pytest.mark.asyncio
async def test_log_hook_handles_event() -> None:
    """The log hook processes an event without raising."""
    base.load_hooks()
    hook = base.HOOK_REGISTRY['log']()
    event = base.HookEvent(type='ip_changed', old='1.1.1.1', new='2.2.2.2')
    await hook.handle(event, hook.ConfigModel())


def test_router_firewall_supports_only_ip_changed() -> None:
    """The router firewall hook only handles ip_changed events."""
    from tether_ddns.hooks.registered_hooks.router_firewall import (
        RouterFirewallHook,
    )
    assert RouterFirewallHook.supported_events == ('ip_changed',)


def test_log_hook_supports_all_events() -> None:
    """The log hook handles every supported event type."""
    from tether_ddns.hooks.registered_hooks.log_hook import LogHook
    assert set(LogHook.supported_events) == set(base.SUPPORTED_EVENTS)


def test_event_labels_cover_supported_events() -> None:
    """Every supported event has a human label."""
    for event in base.SUPPORTED_EVENTS:
        assert event in base.EVENT_LABELS
    assert base.EVENT_LABELS['ip_changed'] == 'IP Changed'
    assert base.EVENT_LABELS['reachability_changed'] == 'Reachability Changed'
