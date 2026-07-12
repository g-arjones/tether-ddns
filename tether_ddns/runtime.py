"""In-memory runtime state, rebuilt from configuration on start."""
from __future__ import annotations

import time
from typing import Callable, Literal

from pydantic import BaseModel

from tether_ddns.config import AppConfig, DomainConfig

Status = Literal['synced', 'pending', 'error', 'updating']
Listener = Callable[[dict[str, object]], None]


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


class RuntimeState:
    """Holds live application state and notifies listeners of changes."""

    def __init__(self) -> None:
        """Create an empty runtime state."""
        self.public_ipv4: str | None = None
        self.public_ipv6: str | None = None
        self.online: bool = False
        self.domains: dict[str, DomainRuntime] = {}
        self._configs: dict[str, DomainConfig] = {}
        self._listeners: list[Listener] = []

    def add_listener(self, cb: Listener) -> None:
        """Register a listener called with a snapshot on each change."""
        self._listeners.append(cb)

    def remove_listener(self, cb: Listener) -> None:
        """Remove a registered listener."""
        if cb in self._listeners:
            self._listeners.remove(cb)

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
        """Update the current public IPv4 and notify listeners."""
        self.public_ipv4 = ip
        self._emit()

    def set_public_ipv6(self, ip: str | None) -> None:
        """Update the current public IPv6 and notify listeners."""
        self.public_ipv6 = ip
        self._emit()

    def set_online(self, online: bool) -> None:
        """Update reachability and notify listeners."""
        self.online = online
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
            'online': self.online,
            'domains': [d.model_dump() for d in self.domains.values()],
        }

    def _emit(self) -> None:
        snap = self.snapshot()
        for cb in list(self._listeners):
            cb(snap)
