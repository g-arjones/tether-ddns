"""DuckDNS dynamic DNS provider."""
from __future__ import annotations

import aiohttp

from pydantic import BaseModel, SecretStr

from tether_ddns.providers.base import (
    DDNSProvider,
    UpdateResult,
    register_provider,
)


class DuckDNSConfig(BaseModel):
    """Configuration for the DuckDNS provider."""

    token: SecretStr
    domain: str


@register_provider
class DuckDNSProvider(DDNSProvider):
    """Updates DuckDNS records via its HTTP API."""

    key = 'duckdns'
    display_name = 'DuckDNS'
    ConfigModel = DuckDNSConfig

    async def update(
        self, hostname: str, record_type: str, ip: str, config: BaseModel,
    ) -> UpdateResult:
        """Update the DuckDNS record for the configured domain."""
        assert isinstance(config, DuckDNSConfig)
        url = 'https://www.duckdns.org/update'
        params = {
            'domains': config.domain,
            'token': config.token.get_secret_value(),
            'ip': ip,
        }
        async with aiohttp.ClientSession() as session:
            async with session.get(url, params=params) as resp:
                body = (await resp.text()).strip()
        return UpdateResult(success=body == 'OK', ip=ip, message=body)
