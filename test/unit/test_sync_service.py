"""Tests for SyncService domain sync and IP orchestration."""
from typing import cast
from unittest.mock import AsyncMock, MagicMock

import pytest

from tether_ddns.config_store import AppConfig, DomainConfig
from tether_ddns.context import AppContext
from tether_ddns.providers.base import load_providers
from tether_ddns.runtime import RuntimeState
from tether_ddns.services.sync import SyncService


def _svc(cfg: AppConfig, state: RuntimeState) -> SyncService:
    """Build a SyncService with a mocked dispatcher."""
    ctx = AppContext(cfg, state, MagicMock(), MagicMock(), MagicMock())
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


@pytest.mark.asyncio
async def test_sync_ips_offline_is_noop() -> None:
    """When offline, sync_ips does nothing and detects no IPs."""
    state = RuntimeState()
    state.online = False
    svc = _svc(AppConfig(), state)
    await svc.sync_ips()
    assert state.public_ipv4 is None


@pytest.mark.asyncio
async def test_refresh_public_ips_dispatches_on_change() -> None:
    """A newly detected IPv4 updates state, is returned, and dispatched."""
    state = RuntimeState()
    state.online = True
    svc = _svc(AppConfig(), state)
    with pytest.MonkeyPatch.context() as mp:
        async def _detect(source: str, family: str) -> str | None:
            """Return an IPv4 only."""
            return '1.2.3.4' if family == 'ipv4' else None
        mp.setattr('tether_ddns.services.sync.detect_public_ip', _detect)
        changed = await svc.refresh_public_ips()
    assert changed == {'ipv4'}
    assert state.public_ipv4 == '1.2.3.4'
    disp = svc._dispatch.dispatch  # noqa: SLF001  # pyright: ignore[reportPrivateUsage]
    cast(AsyncMock, disp).assert_awaited()


@pytest.mark.asyncio
async def test_sync_one_now_raises_when_no_ip() -> None:
    """sync_one_now raises 503 when no public IP can be determined."""
    from fastapi import HTTPException
    domain = DomainConfig(id='d1', hostname='h', provider='duckdns')
    state = RuntimeState()
    state.rebuild(AppConfig(domains=[domain]))
    svc = _svc(AppConfig(domains=[domain]), state)
    with pytest.MonkeyPatch.context() as mp:
        async def _none(source: str, family: str) -> str | None:
            """Return no IP."""
            return None
        mp.setattr('tether_ddns.services.sync.detect_public_ip', _none)
        with pytest.raises(HTTPException) as exc:
            await svc.sync_one_now(domain)
    assert exc.value.status_code == 503


@pytest.mark.asyncio
async def test_sync_one_now_uses_runtime_ip() -> None:
    """sync_one_now uses the runtime IP without detecting when present."""
    load_providers()
    domain = DomainConfig(
        id='d1', hostname='h.duckdns.org', provider='duckdns',
        provider_config={'token': 't', 'domain': 'h'})
    state = RuntimeState()
    state.rebuild(AppConfig(domains=[domain]))
    state.public_ipv4 = '5.5.5.5'
    svc = _svc(AppConfig(domains=[domain]), state)
    with pytest.MonkeyPatch.context() as mp:
        from tether_ddns.providers.base import PROVIDER_REGISTRY
        mp.setattr(
            PROVIDER_REGISTRY['duckdns'], 'update', AsyncMock(return_value='5.5.5.5'))
        await svc.sync_one_now(domain)
    assert state.domains['d1'].status == 'synced'
