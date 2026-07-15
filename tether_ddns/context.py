"""Framework-free shared application context."""
from __future__ import annotations

from dataclasses import dataclass

from tether_ddns.config import AppConfig, ConfigStore
from tether_ddns.runtime import RuntimeState
from tether_ddns.state_store import StateStore
from tether_ddns.ws import ConnectionManager


@dataclass
class AppContext:
    """Bundles shared mutable state for controllers and the scheduler."""

    config: AppConfig
    runtime: RuntimeState
    store: ConfigStore
    state_store: StateStore
    manager: ConnectionManager

    def persist(self) -> None:
        """Save the current configuration to disk."""
        self.store.save(self.config)

    def persist_state(self) -> None:
        """Save the current runtime state to disk."""
        self.state_store.save(self.runtime)

    def rebuild(self) -> None:
        """Persist configuration, then rebuild runtime from it."""
        self.persist()
        self.runtime.rebuild(self.config)
