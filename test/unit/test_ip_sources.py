"""Tests for the IP-source registry and built-in HTTP sources."""
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from tether_ddns.ip_sources import base


def test_load_ip_sources_registers_ipify() -> None:
    """Auto-loading discovers the built-in ipify source."""
    base.load_ip_sources()
    assert 'ipify' in base.IP_SOURCE_REGISTRY


@pytest.mark.asyncio
async def test_detect_public_ip_uses_source() -> None:
    """detect_public_ip returns the source's detected IP."""
    base.load_ip_sources()
    with patch.object(
        base.IP_SOURCE_REGISTRY['ipify'], 'detect',
        new=AsyncMock(return_value='203.0.113.9'),
    ):
        assert await base.detect_public_ip('ipify') == '203.0.113.9'


@pytest.mark.asyncio
async def test_detect_public_ip_unknown_source_returns_none() -> None:
    """An unknown source key yields None rather than raising."""
    assert await base.detect_public_ip('nope') is None


@pytest.mark.asyncio
async def test_ipify_source_reads_http_body() -> None:
    """The ipify source returns the trimmed HTTP body."""
    base.load_ip_sources()
    source = base.IP_SOURCE_REGISTRY['ipify']()
    resp = MagicMock()
    resp.text = AsyncMock(return_value=' 203.0.113.7\n')
    session = MagicMock()
    session.get.return_value.__aenter__ = AsyncMock(return_value=resp)
    session.get.return_value.__aexit__ = AsyncMock(return_value=False)
    target = 'tether_ddns.ip_sources.registered_sources.http_sources.aiohttp.ClientSession'
    with patch(target) as cs:
        cs.return_value.__aenter__ = AsyncMock(return_value=session)
        cs.return_value.__aexit__ = AsyncMock(return_value=False)
        assert await source.detect() == '203.0.113.7'
