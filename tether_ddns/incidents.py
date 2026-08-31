"""Incident model for the persisted reachability history window."""
from __future__ import annotations

import time
from typing import Literal, NamedTuple

from pydantic import BaseModel, Field

from tether_ddns.reachability import ReachabilityResult

Severity = Literal['degraded', 'outage']

WINDOW_DAYS = 30
WINDOW_SECONDS = WINDOW_DAYS * 24 * 60 * 60


class Incident(BaseModel):
    """A contiguous span during which reachability was not fully healthy."""

    start: float
    end: float | None = None
    severity: Severity
    min_successes: int
    total: int
    failed: list[str] = Field(default_factory=list[str])


class IncidentWindow(BaseModel):
    """The persisted 30-day incident window."""

    monitoring_since: float = Field(default_factory=time.time)
    rev: int = 0
    incidents: list[Incident] = Field(default_factory=list[Incident])
    ongoing: Incident | None = None


class IncidentView(NamedTuple):
    """The live incident data published to the UI on each check."""

    ongoing: Incident | None
    rev: int


def classify(result: ReachabilityResult) -> Severity | None:
    """Return the severity for a check, or None when fully healthy.

    ``ReachabilityResult.online`` already encodes ``successes >= quorum``, so
    this needs no access to the probe's configuration.
    """
    if result.successes >= result.total:
        return None
    return 'degraded' if result.online else 'outage'


def failed_ips(result: ReachabilityResult) -> list[str]:
    """Return the resolver IPs whose probe failed in this check."""
    return [p.ip for p in result.probes if not p.ok]


def prune(window: IncidentWindow, cutoff: float) -> bool:
    """Drop incidents that ended before ``cutoff``; True if any were dropped."""
    kept = [i for i in window.incidents if i.end is None or i.end >= cutoff]
    if len(kept) == len(window.incidents):
        return False
    window.incidents = kept
    return True
