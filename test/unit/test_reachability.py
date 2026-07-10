"""Tests for the DNS-quorum reachability service."""
from unittest.mock import AsyncMock, patch

import pytest

from tether_ddns.reachability import ReachabilityService


@pytest.mark.asyncio
async def test_online_when_quorum_met() -> None:
    """Two of three successful resolvers report online."""
    service = ReachabilityService(resolvers=['1.1.1.1', '8.8.8.8', '9.9.9.9'], quorum=2)
    with patch.object(
        service, '_query_one',
        new=AsyncMock(side_effect=[('1.1.1.1', 'ok'), ('8.8.8.8', 'ok'), ('9.9.9.9', 'timeout')]),
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
        new=AsyncMock(
            side_effect=[('1.1.1.1', 'ok'), ('8.8.8.8', 'timeout'), ('9.9.9.9', 'timeout')]),
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
