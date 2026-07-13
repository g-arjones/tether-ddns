"""HTTP-based public IP sources."""
from __future__ import annotations

from typing import ClassVar

import aiodns

from pycares import TXTRecordData

from tether_ddns.ip_sources.base import IPFamily, IPSource, register_ip_source


@register_ip_source
class Cloudflare(IPSource):
    """Detects the public IP via Cloudflare DNS."""

    key = 'cloudflare'
    display_name = 'Cloudflare'
    _RESOLVERS: ClassVar[dict[str, str]] = {
        'ipv4': '1.1.1.1',
        'ipv6': '2606:4700:4700::1111',
    }

    async def detect(self, family: IPFamily) -> str:
        """Return the public IP from Cloudflare for the family."""
        async with aiodns.DNSResolver(nameservers=[self._RESOLVERS[family]]) as resolver:
            records = (await resolver.query_dns('whoami.Cloudflare', 'TXT', qclass='CHAOS')).answer
            assert isinstance(records[0].data, TXTRecordData)
            return records[0].data.data.decode('utf-8')
