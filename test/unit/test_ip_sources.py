"""Tests for the IP-source registry and built-in HTTP sources."""
from unittest.mock import AsyncMock, MagicMock, patch

from _pytest.logging import LogCaptureFixture

import pytest

from tether_ddns.ip_sources import base


def test_load_ip_sources_registers_ipify() -> None:
    """Auto-loading discovers the built-in ipify source."""
    base.load_ip_sources()
    assert 'ipify' in base.IP_SOURCE_REGISTRY


@pytest.mark.asyncio
async def test_detect_public_ip_uses_source() -> None:
    """detect_public_ip returns the source's detected IP for a family."""
    base.load_ip_sources()
    with patch.object(
        base.IP_SOURCE_REGISTRY['ipify'], 'detect',
        new=AsyncMock(return_value='203.0.113.9'),
    ):
        assert await base.detect_public_ip('ipify', 'ipv4') == '203.0.113.9'


@pytest.mark.asyncio
async def test_detect_public_ip_unknown_source_returns_none() -> None:
    """An unknown source key yields None rather than raising."""
    assert await base.detect_public_ip('nope', 'ipv4') is None


@pytest.mark.asyncio
async def test_ipify_source_reads_http_body() -> None:
    """The ipify source returns the trimmed HTTP body for ipv4."""
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
        assert await source.detect('ipv4') == '203.0.113.7'
        session.get.assert_called_once_with('https://api.ipify.org')


@pytest.mark.asyncio
async def test_ipify_source_reads_ipv6_endpoint() -> None:
    """The ipify source fetches the v6 endpoint for the ipv6 family."""
    base.load_ip_sources()
    source = base.IP_SOURCE_REGISTRY['ipify']()
    with patch(
        'tether_ddns.ip_sources.registered_sources.http_sources._fetch',
        new=AsyncMock(return_value='2001:db8::1'),
    ) as fetch:
        assert await source.detect('ipv6') == '2001:db8::1'
        fetch.assert_awaited_once_with('https://api6.ipify.org')


@pytest.mark.asyncio
async def test_cloudflare_source_reads_txt_record() -> None:
    """The Cloudflare source returns the decoded TXT answer for a family."""
    base.load_ip_sources()
    source = base.IP_SOURCE_REGISTRY['cloudflare']()
    record = MagicMock()
    record.data = MagicMock(spec=MagicMock)
    record.data.data = b'203.0.113.5'
    response = MagicMock()
    response.answer = [record]
    resolver = MagicMock()
    resolver.query_dns = AsyncMock(return_value=response)
    target = 'tether_ddns.ip_sources.registered_sources.dns_sources.aiodns.DNSResolver'
    with patch(target) as dns_resolver, patch(
        'tether_ddns.ip_sources.registered_sources.dns_sources.TXTRecordData',
        MagicMock,
    ):
        dns_resolver.return_value.__aenter__ = AsyncMock(return_value=resolver)
        dns_resolver.return_value.__aexit__ = AsyncMock(return_value=False)
        assert await source.detect('ipv4') == '203.0.113.5'
        dns_resolver.assert_called_once_with(nameservers=['1.1.1.1'])
        resolver.query_dns.assert_awaited_once_with(
            'whoami.Cloudflare', 'TXT', qclass='CHAOS',
        )


@pytest.mark.asyncio
async def test_detect_public_ip_returns_none_and_logs_debug_on_error(
    caplog: LogCaptureFixture,
) -> None:
    """A raising source yields None and a DEBUG log, not an error."""
    import logging
    from tether_ddns.ip_sources import base

    @base.register_ip_source
    class _Boom(base.IPSource):  # pyright: ignore[reportUnusedClass]
        key = '_boom'
        display_name = 'Boom'

        async def detect(self, family: base.IPFamily) -> str:
            raise RuntimeError('no route')

    try:
        with caplog.at_level(logging.DEBUG, logger='tether_ddns'):
            result = await base.detect_public_ip('_boom', 'ipv6')
        assert result is None
        assert any(r.levelno == logging.DEBUG for r in caplog.records)
    finally:
        base.IP_SOURCE_REGISTRY.pop('_boom', None)
