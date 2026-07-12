"""Tests for the DuckDNS provider."""
from unittest.mock import AsyncMock, MagicMock, patch

from pydantic import BaseModel, SecretStr

import pytest

from tether_ddns.providers.ddns_providers.duckdns import DuckDNSProvider


def _cfg() -> BaseModel:
    return DuckDNSProvider.ConfigModel(token=SecretStr('secret'), domain='myhost')


@pytest.mark.asyncio
async def test_update_success() -> None:
    """A DuckDNS 'OK' body yields a successful result."""
    provider = DuckDNSProvider()
    resp = MagicMock()
    resp.text = AsyncMock(return_value='OK')
    session = MagicMock()
    session.get.return_value.__aenter__ = AsyncMock(return_value=resp)
    session.get.return_value.__aexit__ = AsyncMock(return_value=False)
    with patch('tether_ddns.providers.ddns_providers.duckdns.aiohttp.ClientSession') as cs:
        cs.return_value.__aenter__ = AsyncMock(return_value=session)
        cs.return_value.__aexit__ = AsyncMock(return_value=False)
        result = await provider.update('myhost', 'A', '1.2.3.4', _cfg())
    assert result == '1.2.3.4'


@pytest.mark.asyncio
async def test_update_failure() -> None:
    """A non-OK body raises a TetherError."""
    from tether_ddns.errors import TetherError
    provider = DuckDNSProvider()
    resp = MagicMock()
    resp.text = AsyncMock(return_value='KO')
    session = MagicMock()
    session.get.return_value.__aenter__ = AsyncMock(return_value=resp)
    session.get.return_value.__aexit__ = AsyncMock(return_value=False)
    with patch('tether_ddns.providers.ddns_providers.duckdns.aiohttp.ClientSession') as cs:
        cs.return_value.__aenter__ = AsyncMock(return_value=session)
        cs.return_value.__aexit__ = AsyncMock(return_value=False)
        with pytest.raises(TetherError, match='DuckDNS returned'):
            await provider.update('myhost', 'A', '1.2.3.4', _cfg())
