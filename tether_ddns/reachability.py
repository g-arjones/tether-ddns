"""Internet reachability via a DNS-resolution quorum (adapted reference)."""
from __future__ import annotations

import asyncio

import aiodns

from pydantic import BaseModel, Field

from tether_ddns.logging_setup import get_logger

_log = get_logger()

DEFAULT_RESOLVERS = ['1.1.1.1', '8.8.8.8', '9.9.9.9']
DEFAULT_QUERY_HOST = 'cloudflare.com'


class ReachabilityResult(BaseModel):
    """Outcome of a reachability check."""

    online: bool
    successes: int
    total: int
    details: dict[str, str] = Field(default_factory=dict)


class ReachabilityService:
    """Checks reachability via a quorum of independent DNS resolvers."""

    def __init__(
        self,
        resolvers: list[str] | None = None,
        query_host: str = DEFAULT_QUERY_HOST,
        per_query_timeout: float = 2.0,
        quorum: int = 2,
    ) -> None:
        """Configure resolvers, query host, timeout and quorum."""
        self._resolver_ips = resolvers or DEFAULT_RESOLVERS
        self._query_host = query_host
        self._timeout = per_query_timeout
        self._quorum = quorum

    async def _query_one(self, resolver_ip: str) -> tuple[str, str]:
        """Resolve against one resolver; return (ip, 'ok' | error)."""
        resolver = aiodns.DNSResolver(nameservers=[resolver_ip])
        try:
            await asyncio.wait_for(
                resolver.query(self._query_host, 'A'), timeout=self._timeout)
            return resolver_ip, 'ok'
        except asyncio.TimeoutError:
            return resolver_ip, 'timeout'
        except aiodns.error.DNSError as exc:
            return resolver_ip, f'dns_error: {exc}'
        except Exception as exc:  # noqa: BLE001 - one bad resolver must not kill the check
            return resolver_ip, f'error: {exc}'

    async def check(self) -> ReachabilityResult:
        """Query all resolvers concurrently and evaluate the quorum."""
        results = await asyncio.gather(
            *(self._query_one(ip) for ip in self._resolver_ips))
        details = dict(results)
        successes = sum(1 for _, status in results if status == 'ok')
        online = successes >= self._quorum
        if not online:
            _log.warning(
                'Reachability failed: %d/%d resolvers ok (%s)',
                successes, len(self._resolver_ips), details)
        return ReachabilityResult(
            online=online, successes=successes,
            total=len(self._resolver_ips), details=details)
