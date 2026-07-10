"""IP-source base class, registry and auto-loader."""
from __future__ import annotations

import importlib
import pkgutil
from abc import ABC, abstractmethod

from tether_ddns.logging_setup import get_logger

_log = get_logger()

IP_SOURCE_REGISTRY: dict[str, type['IPSource']] = {}


class IPSource(ABC):
    """Base class for public-IP detection plugins."""

    key: str = ''
    display_name: str = ''

    @abstractmethod
    async def detect(self) -> str | None:
        """Return the detected public IP, or None on failure."""
        raise NotImplementedError


def register_ip_source(cls: type[IPSource]) -> type[IPSource]:
    """Register an IP-source class in the global registry."""
    IP_SOURCE_REGISTRY[cls.key] = cls
    return cls


def load_ip_sources() -> None:
    """Import all IP-source submodules so they self-register."""
    from tether_ddns.ip_sources import registered_sources

    for info in pkgutil.iter_modules(registered_sources.__path__):
        name = f'{registered_sources.__name__}.{info.name}'
        try:
            importlib.import_module(name)
        except Exception:  # noqa: BLE001 - a bad plugin must not break loading
            _log.exception('Failed to load IP-source module %s', name)


async def detect_public_ip(source_key: str = 'ipify') -> str | None:
    """Detect the public IP via the named source, or None on failure."""
    cls = IP_SOURCE_REGISTRY.get(source_key)
    if cls is None:
        _log.warning('Unknown IP source %s', source_key)
        return None
    try:
        return await cls().detect()
    except Exception:  # noqa: BLE001 - detection failure must not raise
        _log.exception('IP source %s failed', source_key)
        return None
