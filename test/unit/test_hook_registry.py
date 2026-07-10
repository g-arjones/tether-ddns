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
