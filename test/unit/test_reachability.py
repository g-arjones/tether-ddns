"""Tests for the DNS-quorum reachability service."""
import asyncio
from typing import Any
from unittest.mock import AsyncMock, patch

import pytest

from tether_ddns.reachability import (
    ReachabilityResult, ReachabilityService, ResolverProbe)


@pytest.mark.asyncio
async def test_online_when_quorum_met() -> None:
    """Two of three successful resolvers report online."""
    service = ReachabilityService(resolvers=['1.1.1.1', '8.8.8.8', '9.9.9.9'], quorum=2)
    with patch.object(
        service, '_query_one',
        new=AsyncMock(side_effect=[
            ResolverProbe(ip='1.1.1.1', ok=True, latency_ms=10.0),
            ResolverProbe(ip='8.8.8.8', ok=True, latency_ms=15.0),
            ResolverProbe(ip='9.9.9.9', ok=False),
        ]),
    ):
        result = await service.check()
    assert result.online is True
    assert result.successes == 2


@pytest.mark.asyncio
async def test_offline_when_quorum_not_met() -> None:
    """Only one successful resolver reports offline."""
    service = ReachabilityService(resolvers=['1.1.1.1', '8.8.8.8', '9.9.9.9'], quorum=2)
    with patch.object(
        service, '_query_one',
        new=AsyncMock(side_effect=[
            ResolverProbe(ip='1.1.1.1', ok=True, latency_ms=10.0),
            ResolverProbe(ip='8.8.8.8', ok=False),
            ResolverProbe(ip='9.9.9.9', ok=False),
        ]),
    ):
        result = await service.check()
    assert result.online is False
    assert result.successes == 1


@pytest.mark.asyncio
async def test_check_uses_query_dns(monkeypatch: pytest.MonkeyPatch) -> None:
    """check() resolves via the non-deprecated query_dns and reports online."""
    service = ReachabilityService(resolvers=['1.1.1.1'], quorum=1)

    class _FakeResolver:

        def __init__(self, nameservers: list[str]) -> None:
            self.nameservers = nameservers

        async def query_dns(self, host: str, qtype: str) -> object:
            return object()

    monkeypatch.setattr('tether_ddns.reachability.aiodns.DNSResolver', _FakeResolver)
    result = await service.check()
    assert result.online is True
    assert result.details == {'1.1.1.1': 'ok'}


def test_resolver_probe_defaults() -> None:
    probe = ResolverProbe(ip='1.1.1.1', ok=True, latency_ms=12.5)
    assert probe.ip == '1.1.1.1'
    assert probe.ok is True
    assert probe.latency_ms == 12.5
    assert ResolverProbe(ip='9.9.9.9', ok=False).latency_ms is None


def test_query_one_success_has_latency(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_wait_for(coro: Any, timeout: Any) -> None:  # noqa: ARG001
        if asyncio.iscoroutine(coro):
            coro.close()
        return None

    monkeypatch.setattr('tether_ddns.reachability.asyncio.wait_for', fake_wait_for)
    svc = ReachabilityService(resolvers=['1.1.1.1'])
    probe = asyncio.run(svc._query_one('1.1.1.1'))  # noqa: SLF001
    assert probe.ip == '1.1.1.1'
    assert probe.ok is True
    assert probe.latency_ms is not None
    assert probe.latency_ms >= 0


def test_query_one_timeout_has_no_latency(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_wait_for(coro: Any, timeout: Any) -> None:  # noqa: ARG001
        if asyncio.iscoroutine(coro):
            coro.close()
        raise asyncio.TimeoutError

    monkeypatch.setattr('tether_ddns.reachability.asyncio.wait_for', fake_wait_for)
    svc = ReachabilityService(resolvers=['1.1.1.1'])
    probe = asyncio.run(svc._query_one('1.1.1.1'))  # noqa: SLF001
    assert probe.ok is False
    assert probe.latency_ms is None


def test_check_assembles_probes(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_query_one(self: Any, resolver_ip: str) -> ResolverProbe:  # noqa: ARG001
        return ResolverProbe(ip=resolver_ip, ok=True, latency_ms=5.0)

    monkeypatch.setattr(ReachabilityService, '_query_one', fake_query_one)
    svc = ReachabilityService(resolvers=['1.1.1.1', '8.8.8.8'])
    result: ReachabilityResult = asyncio.run(svc.check())
    assert [p.ip for p in result.probes] == ['1.1.1.1', '8.8.8.8']
    assert result.successes == 2
    assert result.online is True
