"""DuckDNS dynamic DNS provider."""
from __future__ import annotations

import aiohttp

from pydantic import BaseModel, SecretStr

from tether_ddns.errors import TetherError
from tether_ddns.providers.base import (
    DDNSProvider,
    register_provider,
)


class DuckDNSConfig(BaseModel):
    """Configuration for the DuckDNS provider."""

    token: SecretStr


@register_provider
class DuckDNSProvider(DDNSProvider[DuckDNSConfig]):
    """Updates DuckDNS records via its HTTP API."""

    key = 'duckdns'
    display_name = 'DuckDNS'
    ConfigModel = DuckDNSConfig

    async def update(
        self, hostname: str, record_type: str, ip: str, config: DuckDNSConfig,
    ) -> str:
        """Update the DuckDNS record for the given hostname."""
        url = 'https://www.duckdns.org/update'
        params = {
            'domains': hostname,
            'token': config.token.get_secret_value(),
            'ip': ip,
        }
        async with aiohttp.ClientSession() as session:
            async with session.get(url, params=params) as resp:
                body = (await resp.text()).strip()
        if body != 'OK':
            raise TetherError(f'DuckDNS returned {body}')
        return ip
