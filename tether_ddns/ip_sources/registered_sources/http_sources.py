"""HTTP-based public IP sources."""
from __future__ import annotations

import aiohttp

from tether_ddns.ip_sources.base import IPSource, register_ip_source


async def _fetch(url: str) -> str | None:
    async with aiohttp.ClientSession() as session:
        async with session.get(url) as resp:
            return (await resp.text()).strip()


@register_ip_source
class IpifySource(IPSource):
    """Detects the public IP via api.ipify.org."""

    key = 'ipify'
    display_name = 'ipify.org'

    async def detect(self) -> str | None:
        """Return the public IP from ipify."""
        return await _fetch('https://api.ipify.org')


@register_ip_source
class IcanhazipSource(IPSource):
    """Detects the public IP via icanhazip.com."""

    key = 'icanhazip'
    display_name = 'icanhazip.com'

    async def detect(self) -> str | None:
        """Return the public IP from icanhazip."""
        return await _fetch('https://icanhazip.com')
