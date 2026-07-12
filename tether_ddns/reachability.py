"""Internet reachability via a DNS-resolution quorum (adapted reference)."""
from __future__ import annotations

import asyncio
import time

import aiodns

from pydantic import BaseModel, Field

from tether_ddns.logging_setup import get_logger

_log = get_logger()

DEFAULT_RESOLVERS = ['1.1.1.1', '8.8.8.8', '9.9.9.9']
DEFAULT_QUERY_HOST = 'cloudflare.com'


class ResolverProbe(BaseModel):
    """Outcome of a single resolver query."""

    ip: str
    ok: bool
    latency_ms: float | None = None


class ReachabilityResult(BaseModel):
    """Outcome of a reachability check."""

    online: bool
    successes: int
    total: int
    details: dict[str, str] = Field(default_factory=dict)
    probes: list[ResolverProbe] = Field(default_factory=list[ResolverProbe])


class ReachabilityService:
    """Checks reachability via a quorum of independent DNS resolvers."""

    def __init__(
        self,
        resolvers: list[str] | None = None,
        query_host: str = DEFAULT_QUERY_HOST,
        per_query_timeout: float = 2.0,
        quorum: int = 2,
        warn_throttle_seconds: float = 300.0,
    ) -> None:
        """Configure resolvers, query host, timeout and quorum."""
        self._resolver_ips = resolvers or DEFAULT_RESOLVERS
        self._query_host = query_host
        self._timeout = per_query_timeout
        self._quorum = quorum
        self._warn_throttle_seconds = warn_throttle_seconds
        self._last_online = True
        self._last_warn_ts: float | None = None

    async def _query_one(self, resolver_ip: str) -> ResolverProbe:
        """Resolve against one resolver, returning a timed probe."""
        resolver = aiodns.DNSResolver(nameservers=[resolver_ip])
        start = time.perf_counter()
        try:
            await asyncio.wait_for(
                resolver.query_dns(self._query_host, 'A'), timeout=self._timeout)
        except asyncio.TimeoutError:
            return ResolverProbe(ip=resolver_ip, ok=False)
        except aiodns.error.DNSError:
            return ResolverProbe(ip=resolver_ip, ok=False)
        except Exception:  # noqa: BLE001 - one bad resolver must not kill the check
            return ResolverProbe(ip=resolver_ip, ok=False)
        latency_ms = (time.perf_counter() - start) * 1000
        return ResolverProbe(ip=resolver_ip, ok=True, latency_ms=latency_ms)

    async def check(self) -> ReachabilityResult:
        """Query all resolvers concurrently and evaluate the quorum."""
        probes: list[ResolverProbe]
        probes = list(await asyncio.gather(
            *(self._query_one(ip) for ip in self._resolver_ips)))
        details = {
            p.ip: 'ok' if p.ok else 'unreachable' for p in probes}
        successes = sum(1 for p in probes if p.ok)
        online = successes >= self._quorum
        if not online:
            now = time.monotonic()
            first_failure = self._last_online
            throttle_elapsed = (
                self._last_warn_ts is None
                or now - self._last_warn_ts >= self._warn_throttle_seconds)
            if first_failure or throttle_elapsed:
                _log.warning(
                    'Reachability failed: %d/%d resolvers ok (%s)',
                    successes, len(self._resolver_ips), details)
                self._last_warn_ts = now
        elif not self._last_online:
            _log.info(
                'Reachability restored: %d/%d resolvers ok',
                successes, len(self._resolver_ips))
            self._last_warn_ts = None
        self._last_online = online
        return ReachabilityResult(
            online=online, successes=successes,
            total=len(self._resolver_ips), details=details,
            probes=probes)
