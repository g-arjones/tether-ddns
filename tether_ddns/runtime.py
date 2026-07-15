"""In-memory runtime state, rebuilt from configuration on start."""
from __future__ import annotations

import time
from collections import deque
from typing import Callable, Literal, cast

from pydantic import BaseModel, ConfigDict, Field, PrivateAttr, field_validator

from tether_ddns.config import AppConfig, DomainConfig
from tether_ddns.reachability import ReachabilityResult, ResolverProbe

Status = Literal['synced', 'pending', 'error', 'updating']
Listener = Callable[[dict[str, object]], None]

REACHABILITY_HISTORY_SIZE = 60


class CheckRecord(BaseModel):
    """A single reachability check summary for the history buffer."""

    ts: float
    successes: int
    total: int


def freshness(assigned_ip: str | None, current_ip: str | None) -> Status:
    """Return 'synced' when the assigned IP matches the current public IP."""
    if assigned_ip is not None and assigned_ip == current_ip:
        return 'synced'
    return 'pending'


class DomainRuntime(BaseModel):
    """Live status for a single domain."""

    id: str  # noqa: A003
    status: Status
    ip: str | None = None
    updated: float | None = None
    message: str = ''


class RuntimeState(BaseModel):
    """Holds live application state and notifies listeners of changes."""

    model_config = ConfigDict(arbitrary_types_allowed=True)

    public_ipv4: str | None = None
    public_ipv6: str | None = None
    online: bool = False
    domains: dict[str, DomainRuntime] = Field(default_factory=dict)
    # Reachability telemetry is deliberately NOT persisted. It is a live,
    # per-check time-series that turns over every ~30 min, so persisting it
    # (a) rewrites the state file on every 30 s check and (b) would turn the
    # since-boot uptime% (online / checks) into a meaningless all-time figure
    # across restarts. These stay in memory and in snapshot() for the live UI;
    # the sparkline and uptime% intentionally rebuild after a restart.
    reachability_started_at: float = Field(default_factory=time.time, exclude=True)
    reachability_checks: int = Field(default=0, exclude=True)
    reachability_online: int = Field(default=0, exclude=True)
    reachability_history: deque[CheckRecord] = Field(
        default_factory=lambda: deque(maxlen=REACHABILITY_HISTORY_SIZE),
        exclude=True)
    reachability_latest: list[ResolverProbe] = Field(
        default_factory=list[ResolverProbe], exclude=True)
    next_check_at: float | None = Field(default=None, exclude=True)
    ipv4_changed_at: float | None = None
    ipv6_changed_at: float | None = None

    _listeners: list[Listener] = PrivateAttr(default_factory=list[Listener])
    _configs: dict[str, DomainConfig] = PrivateAttr(
        default_factory=dict[str, DomainConfig])

    @field_validator('reachability_history', mode='before')
    @classmethod
    def _bound_history(cls, value: object) -> 'deque[CheckRecord]':
        """Re-wrap any incoming sequence into a bounded history deque.

        Defensive only: ``reachability_history`` is excluded from persistence,
        so this does not run on a normal load (which uses the default factory).
        It still guards explicit construction with a ``reachability_history=``
        argument.
        """
        if isinstance(value, deque) and value.maxlen == REACHABILITY_HISTORY_SIZE:
            return cast('deque[CheckRecord]', value)
        raw: list[object] = (
            list(cast('list[object]', value))
            if isinstance(value, (list, tuple, deque)) else [])
        records = [
            v if isinstance(v, CheckRecord) else CheckRecord.model_validate(v)
            for v in raw
        ]
        return deque(records, maxlen=REACHABILITY_HISTORY_SIZE)

    def add_listener(self, cb: Listener) -> None:
        """Register a listener called with a snapshot on each change."""
        self._listeners.append(cb)

    def remove_listener(self, cb: Listener) -> None:
        """Remove a registered listener."""
        if cb in self._listeners:
            self._listeners.remove(cb)

    def restore(self, other: 'RuntimeState', cfg: AppConfig) -> None:
        """Load persisted state from ``other`` and seed configs from ``cfg``.

        Copies persisted fields into this instance and populates ``_configs``
        from the current configuration so a following :meth:`rebuild` keeps the
        status of persisted domains. Config edits made while the app was down
        are not specially detected; the next scheduled sync reconciles any
        stale status.
        """
        self.public_ipv4 = other.public_ipv4
        self.public_ipv6 = other.public_ipv6
        self.online = other.online
        self.ipv4_changed_at = other.ipv4_changed_at
        self.ipv6_changed_at = other.ipv6_changed_at
        self.reachability_started_at = other.reachability_started_at
        self.reachability_checks = other.reachability_checks
        self.reachability_online = other.reachability_online
        self.reachability_history = deque(
            other.reachability_history, maxlen=REACHABILITY_HISTORY_SIZE)
        self.domains = dict(other.domains)
        self._configs = {d.id: d for d in cfg.domains}

    def rebuild(self, cfg: AppConfig) -> None:
        """Reset domain runtimes from configuration, preserving history.

        A domain that is new, or whose record-affecting config changed, starts
        fresh at 'pending'; an unchanged domain keeps its runtime. The
        enabled flag is excluded from the change comparison.
        """
        previous = self.domains
        prev_configs = self._configs
        self.domains = {}
        self._configs = {}
        for d in cfg.domains:
            prior_runtime = previous.get(d.id)
            prior_config = prev_configs.get(d.id)
            unchanged = (
                prior_runtime is not None
                and prior_config is not None
                and prior_config.model_copy(update={'enabled': d.enabled}) == d)
            if unchanged:
                assert prior_runtime is not None
                self.domains[d.id] = prior_runtime
            else:
                self.domains[d.id] = DomainRuntime(id=d.id, status='pending')
            self._configs[d.id] = d
        self._emit()

    def set_public_ipv4(self, ip: str | None) -> None:
        """Update the current public IPv4, tracking last-changed, and notify."""
        if ip is not None and ip != self.public_ipv4:
            self.ipv4_changed_at = time.time()
        self.public_ipv4 = ip
        self._emit()

    def set_public_ipv6(self, ip: str | None) -> None:
        """Update the current public IPv6, tracking last-changed, and notify."""
        if ip is not None and ip != self.public_ipv6:
            self.ipv6_changed_at = time.time()
        self.public_ipv6 = ip
        self._emit()

    def set_online(self, online: bool) -> None:
        """Update reachability and notify listeners."""
        self.online = online
        self._emit()

    def record_reachability(self, result: ReachabilityResult) -> bool:
        """Record a reachability check; return True on an online transition."""
        transitioned = result.online != self.online
        self.reachability_history.append(CheckRecord(
            ts=time.time(), successes=result.successes, total=result.total))
        self.reachability_checks += 1
        if result.online:
            self.reachability_online += 1
        self.reachability_latest = list(result.probes)
        self.online = result.online
        self._emit()
        return transitioned

    def set_next_check_at(self, ts: float | None) -> None:
        """Set the next scheduled sync time and notify listeners."""
        self.next_check_at = ts
        self._emit()

    def set_status(
        self, domain_id: str, status: Status, *, ip: str | None = None, message: str = '',
    ) -> Status | None:
        """Update a domain's status; return the new status if it changed."""
        current = self.domains.get(domain_id)
        if current is None:
            return None
        changed = current.status != status
        current.status = status
        if ip is not None:
            current.ip = ip
        current.message = message
        current.updated = time.time()
        self._emit()
        return status if changed else None

    def set_freshness(self, domain_id: str, current_ip: str | None) -> Status | None:
        """Recompute a domain's status from freshness, preserving ip/updated.

        Only toggles between 'synced' and 'pending'; never clobbers 'error'
        or 'updating'. Returns the new status when it changes, else None.
        """
        current = self.domains.get(domain_id)
        if current is None or current.status in ('error', 'updating'):
            return None
        new_status = freshness(current.ip, current_ip)
        if new_status == current.status:
            return None
        current.status = new_status
        self._emit()
        return new_status

    def snapshot(self) -> dict[str, object]:
        """Return a serialisable snapshot of the state."""
        return {
            'public_ipv4': self.public_ipv4,
            'public_ipv6': self.public_ipv6,
            'ipv4_changed_at': self.ipv4_changed_at,
            'ipv6_changed_at': self.ipv6_changed_at,
            'online': self.online,
            'next_check_at': self.next_check_at,
            'reachability': {
                'started_at': self.reachability_started_at,
                'checks': self.reachability_checks,
                'online': self.reachability_online,
                'history': [r.model_dump() for r in self.reachability_history],
                'latest': [p.model_dump() for p in self.reachability_latest],
            },
            'domains': [d.model_dump() for d in self.domains.values()],
        }

    def _emit(self) -> None:
        snap = self.snapshot()
        for cb in list(self._listeners):
            cb(snap)
