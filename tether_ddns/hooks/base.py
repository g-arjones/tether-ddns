"""Hook base class, event models, registry and auto-loader."""
from __future__ import annotations

import importlib
import pkgutil
from abc import ABC
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, Literal, TYPE_CHECKING

from pydantic import BaseModel

from tether_ddns.ip_sources.base import IPFamily
from tether_ddns.logging_setup import get_logger
from tether_ddns.plugin_config import ConfigModelMixin, EmptyConfig as EmptyConfig  # noqa: F401

if TYPE_CHECKING:
    from tether_ddns.context import AppContext

_log = get_logger()

HOOK_REGISTRY: dict[str, type['Hook[Any]']] = {}


def family_for(record_type: str) -> IPFamily:
    """Return the IP family a record type resolves against."""
    return 'ipv6' if record_type == 'AAAA' else 'ipv4'


class HookEventBase(BaseModel):
    """Base for all hook event payloads."""

    @classmethod
    def from_context(cls, ctx: 'AppContext') -> Sequence['HookEventBase']:
        """Build events of this type from the current context."""
        return []


class IpChangedEvent(HookEventBase):
    """The public IP for a family changed."""

    old_ip: str | None = None
    new_ip: str
    family: Literal['ipv4', 'ipv6']

    @classmethod
    def from_context(cls, ctx: 'AppContext') -> list['IpChangedEvent']:
        """One event per family that currently has a known public IP."""
        pairs: tuple[tuple[IPFamily, str | None], ...] = (
            ('ipv4', ctx.runtime.public_ipv4), ('ipv6', ctx.runtime.public_ipv6))
        return [cls(old_ip=ip, new_ip=ip, family=fam) for fam, ip in pairs if ip]


class ReachabilityChangedEvent(HookEventBase):
    """The service transitioned between online and offline."""

    online: bool
    was_online: bool | None = None

    @classmethod
    def from_context(cls, ctx: 'AppContext') -> list['ReachabilityChangedEvent']:
        """Snapshot current reachability with no transition."""
        online = ctx.runtime.online
        return [cls(online=online, was_online=online)]


class DomainUpdatePendingEvent(HookEventBase):
    """A domain's record became stale against the current public IP."""

    domain_id: str
    hostname: str
    record_type: str
    family: Literal['ipv4', 'ipv6']
    current_ip: str | None = None

    @classmethod
    def from_context(cls, ctx: 'AppContext') -> list['DomainUpdatePendingEvent']:
        """One event per domain currently in 'pending'."""
        out: list['DomainUpdatePendingEvent'] = []
        for d in ctx.config.domains:
            rt = ctx.runtime.domains.get(d.id)
            if rt is None or rt.status != 'pending':
                continue
            family = family_for(d.record_type)
            current_ip = (ctx.runtime.public_ipv4 if family == 'ipv4'
                          else ctx.runtime.public_ipv6)
            out.append(cls(
                domain_id=d.id, hostname=d.hostname, record_type=d.record_type,
                family=family, current_ip=current_ip))
        return out


class DomainUpdateSuccessEvent(HookEventBase):
    """A domain's record was updated to the current public IP."""

    domain_id: str
    hostname: str
    record_type: str
    family: Literal['ipv4', 'ipv6']
    ip: str

    @classmethod
    def from_context(cls, ctx: 'AppContext') -> list['DomainUpdateSuccessEvent']:
        """One event per domain currently 'synced' with a known ip."""
        out: list['DomainUpdateSuccessEvent'] = []
        for d in ctx.config.domains:
            rt = ctx.runtime.domains.get(d.id)
            if rt is None or rt.status != 'synced' or rt.ip is None:
                continue
            out.append(cls(
                domain_id=d.id, hostname=d.hostname, record_type=d.record_type,
                family=family_for(d.record_type), ip=rt.ip))
        return out


class DomainUpdateErrorEvent(HookEventBase):
    """A domain update attempt failed."""

    domain_id: str
    hostname: str
    record_type: str
    family: Literal['ipv4', 'ipv6']
    ip: str | None = None
    message: str

    @classmethod
    def from_context(cls, ctx: 'AppContext') -> list['DomainUpdateErrorEvent']:
        """One event per domain currently in 'error'."""
        out: list['DomainUpdateErrorEvent'] = []
        for d in ctx.config.domains:
            rt = ctx.runtime.domains.get(d.id)
            if rt is None or rt.status != 'error':
                continue
            out.append(cls(
                domain_id=d.id, hostname=d.hostname, record_type=d.record_type,
                family=family_for(d.record_type), ip=rt.ip, message=rt.message))
        return out


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


class Hook[ConfigT: BaseModel](ConfigModelMixin, ABC):  # noqa: D101
    """Base class for hook plugins."""

    key: str = ''
    display_name: str = ''

    @classmethod
    def config_schema(cls) -> dict[str, object]:
        """Return the JSON schema for this hook's configuration."""
        return cls.ConfigModel.model_json_schema()

    async def on_ip_changed(
            self, event: IpChangedEvent, config: ConfigT) -> None:
        """Handle an IP change. Override to react; default is a no-op."""

    async def on_reachability_changed(
            self, event: ReachabilityChangedEvent, config: ConfigT) -> None:
        """Handle a reachability change. Override to react; default no-op."""

    async def on_domain_update_pending(
            self, event: DomainUpdatePendingEvent,
            config: ConfigT) -> None:
        """Handle a domain becoming stale. Override to react; default no-op."""

    async def on_domain_update_success(
            self, event: DomainUpdateSuccessEvent,
            config: ConfigT) -> None:
        """Handle a successful domain update. Default no-op."""

    async def on_domain_update_error(
            self, event: DomainUpdateErrorEvent,
            config: ConfigT) -> None:
        """Handle a failed domain update. Default no-op."""

    @classmethod
    def supported_events(cls) -> tuple[str, ...]:
        """Return the event keys whose handler this hook overrides."""
        return tuple(
            key for key, spec in EVENT_SPECS.items()
            if getattr(cls, spec.method) is not getattr(Hook, spec.method)
        )

    async def handle(
            self, event_key: str, event: HookEventBase,
            config: ConfigT) -> None:
        """Route an event to the matching on_* handler."""
        await getattr(self, EVENT_SPECS[event_key].method)(event, config)


def register_hook[C: Hook[Any]](cls: type[C]) -> type[C]:  # noqa: D103
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
