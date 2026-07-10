"""DDNS provider base class, registry and auto-loader."""
from __future__ import annotations

import importlib
import pkgutil
from abc import ABC, abstractmethod

from pydantic import BaseModel

from tether_ddns.logging_setup import get_logger

_log = get_logger()

PROVIDER_REGISTRY: dict[str, type['DDNSProvider']] = {}


class UpdateResult(BaseModel):
    """Outcome of a provider update attempt."""

    success: bool
    ip: str | None = None
    message: str = ''


class DDNSProvider(ABC):
    """Base class for DDNS provider plugins."""

    key: str = ''
    display_name: str = ''
    ConfigModel: type[BaseModel] = BaseModel

    @classmethod
    def config_schema(cls) -> dict[str, object]:
        """Return the JSON schema for this provider's configuration."""
        return cls.ConfigModel.model_json_schema()

    @abstractmethod
    async def update(
        self, hostname: str, record_type: str, ip: str, config: BaseModel,
    ) -> UpdateResult:
        """Update the DNS record and return the result."""
        raise NotImplementedError


def register_provider(cls: type[DDNSProvider]) -> type[DDNSProvider]:
    """Register a provider class in the global registry."""
    PROVIDER_REGISTRY[cls.key] = cls
    return cls


def load_providers() -> None:
    """Import all provider submodules so they self-register."""
    from tether_ddns.providers import ddns_providers

    for info in pkgutil.iter_modules(ddns_providers.__path__):
        name = f'{ddns_providers.__name__}.{info.name}'
        try:
            importlib.import_module(name)
        except Exception:  # noqa: BLE001 - a bad plugin must not break loading
            _log.exception('Failed to load provider module %s', name)
