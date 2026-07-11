"""Hook base class, event models, registry and auto-loader."""
from __future__ import annotations

import importlib
import pkgutil
from abc import ABC
from dataclasses import dataclass
from typing import Literal

from pydantic import BaseModel

from tether_ddns.logging_setup import get_logger

_log = get_logger()

HOOK_REGISTRY: dict[str, type['Hook']] = {}


class EmptyConfig(BaseModel):
    """Default configuration for hooks that need no settings."""


class HookEventBase(BaseModel):
    """Base for all hook event payloads."""


class IpChangedEvent(HookEventBase):
    """The public IP for a family changed."""

    old_ip: str | None = None
    new_ip: str
    family: Literal['ipv4', 'ipv6']


class ReachabilityChangedEvent(HookEventBase):
    """The service transitioned between online and offline."""

    online: bool
    was_online: bool | None = None


class DomainUpdatePendingEvent(HookEventBase):
    """A domain's record became stale against the current public IP."""

    domain_id: str
    hostname: str
    record_type: str
    family: Literal['ipv4', 'ipv6']
    current_ip: str | None = None


class DomainUpdateSuccessEvent(HookEventBase):
    """A domain's record was updated to the current public IP."""

    domain_id: str
    hostname: str
    record_type: str
    family: Literal['ipv4', 'ipv6']
    ip: str


class DomainUpdateErrorEvent(HookEventBase):
    """A domain update attempt failed."""

    domain_id: str
    hostname: str
    record_type: str
    family: Literal['ipv4', 'ipv6']
    ip: str | None = None
    message: str


@dataclass(frozen=True)
class EventSpec:
    """Describes one hook event type."""

    label: str
    method: str
    model: type[HookEventBase]


EVENT_SPECS: dict[str, EventSpec] = {
    'ip_changed': EventSpec('IP Changed', 'on_ip_changed', IpChangedEvent),
    'reachability_changed': EventSpec(
        'Reachability Changed', 'on_reachability_changed',
        ReachabilityChangedEvent),
    'domain_update_pending': EventSpec(
        'Domain Update Pending', 'on_domain_update_pending',
        DomainUpdatePendingEvent),
    'domain_update_success': EventSpec(
        'Domain Update Success', 'on_domain_update_success',
        DomainUpdateSuccessEvent),
    'domain_update_error': EventSpec(
        'Domain Update Error', 'on_domain_update_error',
        DomainUpdateErrorEvent),
}


class Hook(ABC):
    """Base class for hook plugins."""

    key: str = ''
    display_name: str = ''
    ConfigModel: type[BaseModel] = EmptyConfig

    @classmethod
    def config_schema(cls) -> dict[str, object]:
        """Return the JSON schema for this hook's configuration."""
        return cls.ConfigModel.model_json_schema()

    async def on_ip_changed(
            self, event: IpChangedEvent, config: BaseModel) -> None:
        """Handle an IP change. Override to react; default is a no-op."""

    async def on_reachability_changed(
            self, event: ReachabilityChangedEvent, config: BaseModel) -> None:
        """Handle a reachability change. Override to react; default no-op."""

    async def on_domain_update_pending(
            self, event: DomainUpdatePendingEvent,
            config: BaseModel) -> None:
        """Handle a domain becoming stale. Override to react; default no-op."""

    async def on_domain_update_success(
            self, event: DomainUpdateSuccessEvent,
            config: BaseModel) -> None:
        """Handle a successful domain update. Default no-op."""

    async def on_domain_update_error(
            self, event: DomainUpdateErrorEvent,
            config: BaseModel) -> None:
        """Handle a failed domain update. Default no-op."""

    @classmethod
    def supported_events(cls) -> tuple[str, ...]:
        """Return the event keys whose handler this hook overrides."""
        return tuple(
            key for key, spec in EVENT_SPECS.items()
            if getattr(cls, spec.method) is not getattr(Hook, spec.method)
        )

    async def _dispatch(
            self, event_key: str, event: HookEventBase,
            config: BaseModel) -> None:
        """Route an event to the matching on_* handler."""
        await getattr(self, EVENT_SPECS[event_key].method)(event, config)


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
