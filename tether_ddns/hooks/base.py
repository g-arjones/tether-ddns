"""Hook base class, event model, registry and auto-loader."""
from __future__ import annotations

import importlib
import pkgutil
from abc import ABC, abstractmethod
from typing import Literal

from pydantic import BaseModel

from tether_ddns.logging_setup import get_logger

_log = get_logger()

SUPPORTED_EVENTS: tuple[str, ...] = ('reachability_changed', 'ip_changed')
EVENT_LABELS: dict[str, str] = {
    'ip_changed': 'IP Changed',
    'reachability_changed': 'Reachability Changed',
}
HOOK_REGISTRY: dict[str, type['Hook']] = {}


class EmptyConfig(BaseModel):
    """Default configuration for hooks that need no settings."""


class HookEvent(BaseModel):
    """An event delivered to hooks."""

    type: Literal['reachability_changed', 'ip_changed']  # noqa: A003
    old: str | None = None
    new: str | None = None


class Hook(ABC):
    """Base class for hook plugins."""

    key: str = ''
    display_name: str = ''
    supported_events: tuple[str, ...] = SUPPORTED_EVENTS
    ConfigModel: type[BaseModel] = EmptyConfig

    @classmethod
    def config_schema(cls) -> dict[str, object]:
        """Return the JSON schema for this hook's configuration."""
        return cls.ConfigModel.model_json_schema()

    @abstractmethod
    async def handle(self, event: HookEvent, config: BaseModel) -> None:
        """Handle an event."""
        raise NotImplementedError


def register_hook(cls: type[Hook]) -> type[Hook]:
    """Register a hook class in the global registry."""
    HOOK_REGISTRY[cls.key] = cls
    return cls


def load_hooks() -> None:
    """Import all hook submodules so they self-register."""
    from tether_ddns.hooks import registered_hooks

    for info in pkgutil.iter_modules(registered_hooks.__path__):
        name = f'{registered_hooks.__name__}.{info.name}'
        try:
            importlib.import_module(name)
        except Exception:  # noqa: BLE001 - a bad plugin must not break loading
            _log.exception('Failed to load hook module %s', name)
