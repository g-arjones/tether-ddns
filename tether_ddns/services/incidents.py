"""Records reachability incidents into the persisted 30-day window."""
from __future__ import annotations

import time

from tether_ddns.incident_store import IncidentStore
from tether_ddns.incidents import (
    Incident,
    IncidentView,
    IncidentWindow,
    Severity,
    WINDOW_SECONDS,
    classify,
    failed_ips,
    prune,
)
from tether_ddns.reachability import ReachabilityResult


class IncidentRecorder:
    """Turns a stream of reachability checks into persisted incidents."""

    def __init__(self, store: IncidentStore) -> None:
        """Load and prune the window, ensuring it exists on disk.

        The first ever start writes the file so ``monitoring_since`` is stable
        across restarts; every later healthy start writes nothing.
        """
        self._store = store
        self._dirty = False
        existed = store.path.exists()
        self._window = store.load()
        pruned = prune(self._window, time.time() - WINDOW_SECONDS)
        if pruned:
            self._window.rev += 1
        if pruned or not existed:
            self._store.save(self._window)

    @property
    def view(self) -> IncidentView:
        """Return the ongoing incident and current revision."""
        return IncidentView(self._window.ongoing, self._window.rev)

    def window(self, now: float | None = None) -> IncidentWindow:
        """Return the window filtered to the retention period."""
        cutoff = (time.time() if now is None else now) - WINDOW_SECONDS
        return self._window.model_copy(update={
            'incidents': [
                i for i in self._window.incidents
                if i.end is None or i.end >= cutoff
            ],
        })

    def record(
        self, result: ReachabilityResult, now: float | None = None,
    ) -> IncidentView:
        """Fold one check into the window, writing only on a real change."""
        ts = time.time() if now is None else now
        changed = prune(self._window, ts - WINDOW_SECONDS)
        severity = classify(result)
        ongoing = self._window.ongoing
        if ongoing is None:
            if severity is not None:
                self._open(severity, result, ts)
                changed = True
        elif severity is None:
            self._close(ongoing, ts)
            changed = True
        elif severity == ongoing.severity:
            self._dirty = self._widen(ongoing, result) or self._dirty
        else:
            self._close(ongoing, ts)
            self._open(severity, result, ts)
            changed = True
        if changed:
            self._window.rev += 1
            self._store.save(self._window)
            self._dirty = False
        return self.view

    def flush(self) -> None:
        """Persist pending in-memory widening of an ongoing incident."""
        if self._dirty:
            self._store.save(self._window)
            self._dirty = False

    def _open(
        self, severity: Severity, result: ReachabilityResult, ts: float,
    ) -> None:
        """Start a new ongoing incident at ``ts``."""
        self._window.ongoing = Incident(
            start=ts, end=None, severity=severity,
            min_successes=result.successes, total=result.total,
            failed=failed_ips(result))

    def _close(self, ongoing: Incident, ts: float) -> None:
        """End the ongoing incident at ``ts`` and file it."""
        ongoing.end = ts
        self._window.incidents.append(ongoing)
        self._window.ongoing = None

    @staticmethod
    def _widen(ongoing: Incident, result: ReachabilityResult) -> bool:
        """Absorb a check into an ongoing incident; True if anything changed."""
        changed = False
        if result.successes < ongoing.min_successes:
            ongoing.min_successes = result.successes
            ongoing.total = result.total
            changed = True
        for ip in failed_ips(result):
            if ip not in ongoing.failed:
                ongoing.failed.append(ip)
                changed = True
        if changed and len(ongoing.failed) > 1:
            ongoing.failed.sort()
        return changed
