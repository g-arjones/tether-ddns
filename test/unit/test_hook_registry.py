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

        async def on_ip_changed(
                self, event: base.IpChangedEvent, config: BaseModel) -> None:
            return None

    assert base.HOOK_REGISTRY['dummy-hook'] is _Dummy


def test_load_hooks_imports_builtin_log_hook() -> None:
    """Auto-loading discovers the shipped log hook."""
    base.load_hooks()
    assert 'log' in base.HOOK_REGISTRY


@pytest.mark.asyncio
async def test_log_hook_handles_ip_event() -> None:
    """The log hook processes an ip_changed event without raising."""
    base.load_hooks()
    hook = base.HOOK_REGISTRY['log']()
    event = base.IpChangedEvent(old_ip='1.1.1.1', new_ip='2.2.2.2', family='ipv4')
    await hook.on_ip_changed(event, hook.ConfigModel())


def test_supported_events_inferred_from_overrides() -> None:
    """A hook overriding one method supports only that event."""
    class _OnlyIp(base.Hook):
        key = '_onlyip'

        async def on_ip_changed(
                self, event: base.IpChangedEvent, config: BaseModel) -> None:
            return None

    assert _OnlyIp.supported_events() == ('ip_changed',)


def test_base_hook_supports_nothing() -> None:
    """A hook overriding no methods supports no events."""
    class _Empty(base.Hook):
        key = '_empty'

    assert _Empty.supported_events() == ()


def test_router_firewall_supports_only_ip_changed() -> None:
    """The router firewall hook only handles ip_changed events."""
    from tether_ddns.hooks.registered_hooks.router_firewall import (
        RouterFirewallHook,
    )
    assert RouterFirewallHook.supported_events() == ('ip_changed',)


def test_log_hook_supports_all_events() -> None:
    """The log hook handles every supported event type."""
    from tether_ddns.hooks.registered_hooks.log_hook import LogHook
    assert set(LogHook.supported_events()) == set(base.EVENT_SPECS)


def test_event_specs_have_labels() -> None:
    """Every event spec exposes a human label."""
    assert base.EVENT_SPECS['ip_changed'].label == 'IP Changed'
    assert base.EVENT_SPECS['reachability_changed'].label == 'Reachability Changed'


@pytest.mark.asyncio
async def test_dispatch_routes_to_method() -> None:
    """_dispatch calls the on_* method matching the event key."""
    seen: list[str] = []

    class _Spy(base.Hook):
        key = '_spy'

        async def on_ip_changed(
                self, event: base.IpChangedEvent, config: BaseModel) -> None:
            seen.append(event.new_ip)

    event = base.IpChangedEvent(new_ip='9.9.9.9', family='ipv4')
    await _Spy()._dispatch('ip_changed', event, base.EmptyConfig())
    assert seen == ['9.9.9.9']
