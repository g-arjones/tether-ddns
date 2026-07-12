"""HTTP-based public IP sources."""
from __future__ import annotations

from typing import ClassVar

import aiohttp

from tether_ddns.ip_sources.base import IPFamily, IPSource, register_ip_source


async def _fetch(url: str) -> str:
    async with aiohttp.ClientSession() as session:
        async with session.get(url) as resp:
            resp.raise_for_status()
            return (await resp.text()).strip()


@register_ip_source
class IpifySource(IPSource):
    """Detects the public IP via ipify."""

    key = 'ipify'
    display_name = 'ipify.org'
    _URLS: ClassVar[dict[str, str]] = {
        'ipv4': 'https://api.ipify.org',
        'ipv6': 'https://api6.ipify.org',
    }

    async def detect(self, family: IPFamily) -> str:
        """Return the public IP from ipify for the family."""
        return await _fetch(self._URLS[family])


@register_ip_source
class IcanhazipSource(IPSource):
    """Detects the public IP via icanhazip."""

    key = 'icanhazip'
    display_name = 'icanhazip.com'
    _URLS: ClassVar[dict[str, str]] = {
        'ipv4': 'https://ipv4.icanhazip.com',
        'ipv6': 'https://ipv6.icanhazip.com',
    }

    async def detect(self, family: IPFamily) -> str:
        """Return the public IP from icanhazip for the family."""
        return await _fetch(self._URLS[family])
