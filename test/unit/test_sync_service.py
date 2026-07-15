"""Tests for SyncService domain sync and IP orchestration."""
from unittest.mock import AsyncMock, MagicMock

import pytest

from tether_ddns.config import AppConfig, DomainConfig
from tether_ddns.context import AppContext
from tether_ddns.providers.base import load_providers
from tether_ddns.runtime import RuntimeState
from tether_ddns.services.sync import SyncService


def _svc(cfg: AppConfig, state: RuntimeState) -> SyncService:
    """Build a SyncService with a mocked dispatcher."""
    ctx = AppContext(cfg, state, MagicMock(), MagicMock())
    dispatch = MagicMock()
    dispatch.dispatch = AsyncMock()
    return SyncService(ctx, dispatch)


@pytest.mark.asyncio
async def test_sync_domain_unknown_provider_sets_error() -> None:
    """An unknown provider leaves the domain in error."""
    domain = DomainConfig(id='d1', hostname='h', provider='nope')
    state = RuntimeState()
    state.rebuild(AppConfig(domains=[domain]))
    svc = _svc(AppConfig(domains=[domain]), state)
    result = await svc.sync_domain(domain, '1.2.3.4')
    assert result == 'error'
    assert state.domains['d1'].status == 'error'


@pytest.mark.asyncio
async def test_sync_domain_success_marks_synced() -> None:
    """A successful provider update marks the domain synced."""
    load_providers()
    domain = DomainConfig(
        id='d1', hostname='h.duckdns.org', provider='duckdns',
        provider_config={'token': 't', 'domain': 'h'})
    state = RuntimeState()
    state.rebuild(AppConfig(domains=[domain]))
    svc = _svc(AppConfig(domains=[domain]), state)
    with pytest.MonkeyPatch.context() as mp:
        from tether_ddns.providers.base import PROVIDER_REGISTRY
        provider = PROVIDER_REGISTRY['duckdns']
        mp.setattr(provider, 'update', AsyncMock(return_value='1.2.3.4'))
        result = await svc.sync_domain(domain, '1.2.3.4')
    assert result == 'synced'
    assert state.domains['d1'].status == 'synced'
