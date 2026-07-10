"""In-memory runtime state, rebuilt from configuration on start."""
from __future__ import annotations

import time
from typing import Callable, Literal

from pydantic import BaseModel

from tether_ddns.config import AppConfig

Status = Literal['synced', 'pending', 'error', 'paused', 'updating']
Listener = Callable[[dict[str, object]], None]


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
        self.public_ip: str | None = None
        self.online: bool = False
        self.domains: dict[str, DomainRuntime] = {}
        self._listeners: list[Listener] = []

    def add_listener(self, cb: Listener) -> None:
        """Register a listener called with a snapshot on each change."""
        self._listeners.append(cb)

    def remove_listener(self, cb: Listener) -> None:
        """Remove a registered listener."""
        if cb in self._listeners:
            self._listeners.remove(cb)

    def rebuild(self, cfg: AppConfig) -> None:
        """Reset domain runtimes from configuration."""
        self.domains = {
            d.id: DomainRuntime(id=d.id, status='pending' if d.enabled else 'paused')
            for d in cfg.domains
        }
        self._emit()

    def set_public_ip(self, ip: str | None) -> None:
        """Update the current public IP and notify listeners."""
        self.public_ip = ip
        self._emit()

    def set_online(self, online: bool) -> None:
        """Update reachability and notify listeners."""
        self.online = online
        self._emit()

    def set_status(
        self, domain_id: str, status: Status, *, ip: str | None = None, message: str = '',
    ) -> None:
        """Update a domain's status and notify listeners."""
        current = self.domains.get(domain_id)
        if current is None:
            return
        current.status = status
        if ip is not None:
            current.ip = ip
        current.message = message
        current.updated = time.time()
        self._emit()

    def snapshot(self) -> dict[str, object]:
        """Return a serialisable snapshot of the state."""
        return {
            'public_ip': self.public_ip,
            'online': self.online,
            'domains': [d.model_dump() for d in self.domains.values()],
        }

    def _emit(self) -> None:
        snap = self.snapshot()
        for cb in list(self._listeners):
            cb(snap)
