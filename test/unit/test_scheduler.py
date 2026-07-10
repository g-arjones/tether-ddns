"""Tests for scheduler dispatch and exception isolation."""
from unittest.mock import AsyncMock, patch

import pytest

from tether_ddns import scheduler
from tether_ddns.config import AppConfig, DomainConfig, HookConfig
from tether_ddns.hooks.base import HookEvent, load_hooks
from tether_ddns.providers.base import load_providers
from tether_ddns.runtime import RuntimeState


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
