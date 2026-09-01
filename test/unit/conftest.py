"""Shared fixtures for the unit test suite."""
from typing import Callable

import pytest

from tether_ddns.reachability import ReachabilityResult, ResolverProbe

QUORUM = 1


@pytest.fixture
def make_result() -> Callable[[list[bool]], ReachabilityResult]:
    """Return a factory building a ReachabilityResult from probe outcomes.

    Probe IPs are assigned as ``10.0.0.<index>`` and ``online`` is derived from
    the quorum, matching ReachabilityProbe's own rule.
    """
    def _make(oks: list[bool]) -> ReachabilityResult:
        probes = [
            ResolverProbe(ip=f'10.0.0.{i}', ok=ok, latency_ms=1.0 if ok else None)
            for i, ok in enumerate(oks)
        ]
        successes = sum(oks)
        return ReachabilityResult(
            online=successes >= QUORUM, successes=successes,
            total=len(oks), details={}, probes=probes)
    return _make
