# Per-Event Hook Methods Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single `Hook.handle(event, config)` method with one typed method per event type (`on_ip_changed`, `on_reachability_changed`), inferring `supported_events` from overridden methods.

**Architecture:** A central `EVENT_SPECS` table in `tether_ddns/hooks/base.py` maps each event key to its label, handler-method name, and typed payload model. The `Hook` base class provides no-op defaults for every event method; `supported_events()` becomes a classmethod that reports which methods a subclass overrode. Scheduler/API call sites build the concrete payload and dispatch through `Hook._dispatch(event_key, payload, config)`. The external contract (event key strings, stored config, `/api/hooks` JSON) is unchanged.

**Tech Stack:** Python 3, Pydantic v2, dataclasses, pytest, pytest-asyncio.

## Global Constraints

- Event key strings stay exactly `'ip_changed'` and `'reachability_changed'`.
- `/api/hooks` response shape stays identical: `{key, display_name, events:[{key,label}], schema}`.
- Persisted config format unchanged; no frontend changes.
- Reachability payloads use booleans (`online`, `was_online`); reachability event dispatch keeps the same `'ip_changed'`/`'reachability_changed'` keys.
- Follow existing code style: `from __future__ import annotations`, single-quoted strings, `noqa` comments where the codebase already uses them.
- Run the full unit suite with `pytest test/unit -q` before each commit in this plan.

---

### Task 1: Typed event payloads and `EVENT_SPECS` in `base.py`

**Files:**
- Modify: `tether_ddns/hooks/base.py`
- Test: `test/unit/test_hook_registry.py`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `HookEventBase(BaseModel)`
  - `IpChangedEvent(HookEventBase)` with `old_ip: str | None = None`, `new_ip: str`, `family: Literal['ipv4', 'ipv6']`
  - `ReachabilityChangedEvent(HookEventBase)` with `online: bool`, `was_online: bool | None = None`
  - `EventSpec` frozen dataclass: `label: str`, `method: str`, `model: type[HookEventBase]`
  - `EVENT_SPECS: dict[str, EventSpec]` keyed by `'ip_changed'`, `'reachability_changed'`
  - `Hook.on_ip_changed(self, event: IpChangedEvent, config: BaseModel) -> None` (no-op default)
  - `Hook.on_reachability_changed(self, event: ReachabilityChangedEvent, config: BaseModel) -> None` (no-op default)
  - `Hook.supported_events(cls) -> tuple[str, ...]` classmethod
  - `Hook._dispatch(self, event_key: str, event: HookEventBase, config: BaseModel) -> None`
  - `HookEvent`, `SUPPORTED_EVENTS`, `EVENT_LABELS` are REMOVED.

- [ ] **Step 1: Write the failing tests**

Replace the whole body of `test/unit/test_hook_registry.py` with:

```python
"""Tests for the hook registry and the built-in log hook."""
from pydantic import BaseModel

import pytest

from tether_ddns.hooks import base


def test_register_hook_adds_to_registry() -> None:
    """The decorator registers a hook by its key."""
    @base.register_hook
    class _Dummy(base.Hook):
        key = 'dummy-hook'
        display_name = 'Dummy'

        async def on_ip_changed(
                self, event: base.IpChangedEvent, config: BaseModel) -> None:
            return None

    assert base.HOOK_REGISTRY['dummy-hook'] is _Dummy


def test_load_hooks_imports_builtin_log_hook() -> None:
    """Auto-loading discovers the shipped log hook."""
    base.load_hooks()
    assert 'log' in base.HOOK_REGISTRY


@pytest.mark.asyncio
async def test_log_hook_handles_ip_event() -> None:
    """The log hook processes an ip_changed event without raising."""
    base.load_hooks()
    hook = base.HOOK_REGISTRY['log']()
    event = base.IpChangedEvent(old_ip='1.1.1.1', new_ip='2.2.2.2', family='ipv4')
    await hook.on_ip_changed(event, hook.ConfigModel())


def test_supported_events_inferred_from_overrides() -> None:
    """A hook overriding one method supports only that event."""
    class _OnlyIp(base.Hook):
        key = '_onlyip'

        async def on_ip_changed(
                self, event: base.IpChangedEvent, config: BaseModel) -> None:
            return None

    assert _OnlyIp.supported_events() == ('ip_changed',)


def test_base_hook_supports_nothing() -> None:
    """A hook overriding no methods supports no events."""
    class _Empty(base.Hook):
        key = '_empty'

    assert _Empty.supported_events() == ()


def test_router_firewall_supports_only_ip_changed() -> None:
    """The router firewall hook only handles ip_changed events."""
    from tether_ddns.hooks.registered_hooks.router_firewall import (
        RouterFirewallHook,
    )
    assert RouterFirewallHook.supported_events() == ('ip_changed',)


def test_log_hook_supports_all_events() -> None:
    """The log hook handles every supported event type."""
    from tether_ddns.hooks.registered_hooks.log_hook import LogHook
    assert set(LogHook.supported_events()) == set(base.EVENT_SPECS)


def test_event_specs_have_labels() -> None:
    """Every event spec exposes a human label."""
    assert base.EVENT_SPECS['ip_changed'].label == 'IP Changed'
    assert base.EVENT_SPECS['reachability_changed'].label == 'Reachability Changed'


@pytest.mark.asyncio
async def test_dispatch_routes_to_method() -> None:
    """_dispatch calls the on_* method matching the event key."""
    seen: list[str] = []

    class _Spy(base.Hook):
        key = '_spy'

        async def on_ip_changed(
                self, event: base.IpChangedEvent, config: BaseModel) -> None:
            seen.append(event.new_ip)

    event = base.IpChangedEvent(new_ip='9.9.9.9', family='ipv4')
    await _Spy()._dispatch('ip_changed', event, base.EmptyConfig())
    assert seen == ['9.9.9.9']
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest test/unit/test_hook_registry.py -q`
Expected: FAIL (e.g. `AttributeError: module 'tether_ddns.hooks.base' has no attribute 'IpChangedEvent'`).

- [ ] **Step 3: Rewrite `tether_ddns/hooks/base.py`**

Replace everything from the imports through the end of the `Hook` class definition (keep `register_hook` and `load_hooks` unchanged at the bottom) so the file reads:

```python
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest test/unit/test_hook_registry.py -q`
Expected: PASS. (Other modules importing `HookEvent` will still fail their own tests — that is fixed in later tasks. Do not run the whole suite yet.)

- [ ] **Step 5: Commit**

```bash
git add tether_ddns/hooks/base.py test/unit/test_hook_registry.py
git commit -m "refactor(hooks): typed per-event payloads and EVENT_SPECS registry"
```

---

### Task 2: Convert `LogHook` and `RouterFirewallHook`

**Files:**
- Modify: `tether_ddns/hooks/registered_hooks/log_hook.py`
- Modify: `tether_ddns/hooks/registered_hooks/router_firewall.py`
- Test: `test/unit/test_router_firewall_hook.py`

**Interfaces:**
- Consumes: `IpChangedEvent`, `ReachabilityChangedEvent`, `Hook` from Task 1.
- Produces:
  - `LogHook` overriding both `on_ip_changed` and `on_reachability_changed`.
  - `RouterFirewallHook` overriding only `on_ip_changed(self, event: IpChangedEvent, config: BaseModel)`, reading `event.family` and `event.new_ip`; the `supported_events`/`handle`/`event.type` code is removed.

- [ ] **Step 1: Update the router firewall test call sites**

In `test/unit/test_router_firewall_hook.py`:

Change the import line
```python
from tether_ddns.hooks.base import HookEvent
```
to
```python
from tether_ddns.hooks.base import IpChangedEvent
```

Replace the `test_handle_updates_dest_ip` call:
```python
        await RouterFirewallHook().handle(
            HookEvent(type='ip_changed', old='2001:db8::1', new='2001:db8::9'),
            _cfg())
```
with (rename the test to `on_ip_changed`):
```python
        await RouterFirewallHook().on_ip_changed(
            IpChangedEvent(
                old_ip='2001:db8::1', new_ip='2001:db8::9', family='ipv6'),
            _cfg())
```

Replace the `test_handle_skips_family_mismatch` call:
```python
        await RouterFirewallHook().handle(
            HookEvent(type='ip_changed', old='203.0.113.1', new='203.0.113.9'),
            _cfg(ip_version='ipv6'))
```
with:
```python
        await RouterFirewallHook().on_ip_changed(
            IpChangedEvent(
                old_ip='203.0.113.1', new_ip='203.0.113.9', family='ipv4'),
            _cfg(ip_version='ipv6'))
```

Delete the entire `test_handle_ignores_non_ip_event` test (the `reachability_changed` case no longer reaches `on_ip_changed`; per-method routing makes it structurally impossible):
```python
@pytest.mark.asyncio
async def test_handle_ignores_non_ip_event() -> None:
    """A reachability_changed event does nothing."""
    session = _flow_session()
    cs = _patch_session(session)
    try:
        await RouterFirewallHook().handle(
            HookEvent(type='reachability_changed', old='offline', new='online'),
            _cfg())
    finally:
        cs.stop()
    session.get.assert_not_called()
```

Replace the `test_handle_rule_not_found_does_not_apply` call:
```python
        await RouterFirewallHook().handle(
            HookEvent(type='ip_changed', old=None, new='2001:db8::9'),
            _cfg(rule_name='Wireguard'))
```
with:
```python
        await RouterFirewallHook().on_ip_changed(
            IpChangedEvent(new_ip='2001:db8::9', family='ipv6'),
            _cfg(rule_name='Wireguard'))
```

Replace the `test_handle_aborts_without_salt` call:
```python
        await RouterFirewallHook().handle(
            HookEvent(type='ip_changed', old=None, new='2001:db8::9'), _cfg())
```
with:
```python
        await RouterFirewallHook().on_ip_changed(
            IpChangedEvent(new_ip='2001:db8::9', family='ipv6'), _cfg())
```

- [ ] **Step 2: Run the router firewall tests to verify they fail**

Run: `pytest test/unit/test_router_firewall_hook.py -q`
Expected: FAIL (`RouterFirewallHook` has no `on_ip_changed` yet / `IpChangedEvent` import mismatch inside the hook).

- [ ] **Step 3: Update `RouterFirewallHook`**

In `tether_ddns/hooks/registered_hooks/router_firewall.py`, change the import
```python
from tether_ddns.hooks.base import Hook, HookEvent, register_hook
```
to
```python
from tether_ddns.hooks.base import Hook, IpChangedEvent, register_hook
```

Replace the class attributes/handler:
```python
    key = 'router_firewall'
    display_name = 'Router Firewall (ZTE)'
    supported_events = ('ip_changed',)
    ConfigModel = RouterFirewallConfig

    _XHR_HEADERS = {'X-Requested-With': 'XMLHttpRequest'}
    _DATA_TAG = 'firewall_ipfilter_lua.lua'

    async def handle(self, event: HookEvent, config: BaseModel) -> None:
        """Update the configured firewall rule to the new public IP."""
        assert isinstance(config, RouterFirewallConfig)
        if event.type != 'ip_changed' or not event.new:
            return
        ip = event.new
        if family_of(ip) != config.ip_version:
            return
```
with:
```python
    key = 'router_firewall'
    display_name = 'Router Firewall (ZTE)'
    ConfigModel = RouterFirewallConfig

    _XHR_HEADERS = {'X-Requested-With': 'XMLHttpRequest'}
    _DATA_TAG = 'firewall_ipfilter_lua.lua'

    async def on_ip_changed(
            self, event: IpChangedEvent, config: BaseModel) -> None:
        """Update the configured firewall rule to the new public IP."""
        assert isinstance(config, RouterFirewallConfig)
        ip = event.new_ip
        if event.family != config.ip_version:
            return
```

(Leave `family_of` defined — it is still exported and covered by its own unit test.)

- [ ] **Step 4: Update `LogHook`**

Replace the whole body of `tether_ddns/hooks/registered_hooks/log_hook.py` with:

```python
"""A hook that logs each event it receives."""
from __future__ import annotations

from pydantic import BaseModel

from tether_ddns.hooks.base import (
    Hook,
    IpChangedEvent,
    ReachabilityChangedEvent,
    register_hook,
)
from tether_ddns.logging_setup import get_logger

_log = get_logger()


@register_hook
class LogHook(Hook):
    """Logs event details at INFO level."""

    key = 'log'
    display_name = 'Log Event'

    async def on_ip_changed(
            self, event: IpChangedEvent, config: BaseModel) -> None:
        """Log the IP transition."""
        _log.info(
            'Hook event ip_changed (%s): %s -> %s',
            event.family, event.old_ip, event.new_ip)

    async def on_reachability_changed(
            self, event: ReachabilityChangedEvent, config: BaseModel) -> None:
        """Log the reachability transition."""
        _log.info(
            'Hook event reachability_changed: %s -> %s',
            event.was_online, event.online)
```

- [ ] **Step 5: Run the hook tests to verify they pass**

Run: `pytest test/unit/test_router_firewall_hook.py test/unit/test_hook_registry.py -q`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add tether_ddns/hooks/registered_hooks/log_hook.py tether_ddns/hooks/registered_hooks/router_firewall.py test/unit/test_router_firewall_hook.py
git commit -m "refactor(hooks): convert log and router-firewall hooks to per-event methods"
```

---

### Task 3: Update scheduler dispatch and API call sites

**Files:**
- Modify: `tether_ddns/scheduler.py`
- Modify: `tether_ddns/api.py`
- Test: `test/unit/test_scheduler.py`, `test/unit/test_api.py`

**Interfaces:**
- Consumes: `IpChangedEvent`, `ReachabilityChangedEvent`, `EVENT_SPECS`, `Hook.supported_events()`, `Hook._dispatch()` from Tasks 1–2.
- Produces:
  - `scheduler.dispatch_ip_changed(event: IpChangedEvent, cfg: AppConfig) -> None`
  - `scheduler.dispatch_reachability_changed(event: ReachabilityChangedEvent, cfg: AppConfig) -> None`
  - `run_hook_now` unchanged signature: `(hook_cfg, cfg, state) -> dict[str, object]` returning `{'ran': int, 'skipped': list[str]}`.

- [ ] **Step 1: Update scheduler tests**

In `test/unit/test_scheduler.py`:

Change the import
```python
from tether_ddns.hooks.base import HookEvent, load_hooks
```
to
```python
from tether_ddns.hooks.base import (
    IpChangedEvent, ReachabilityChangedEvent, load_hooks)
```

In `test_dispatch_hooks_isolates_exceptions`, replace:
```python
    cfg = AppConfig(hooks=[HookConfig(id='h', hook='log', events=['ip_changed'])])
    event = HookEvent(type='ip_changed', old='1.1.1.1', new='2.2.2.2')
    with patch(
        'tether_ddns.hooks.registered_hooks.log_hook.LogHook.handle',
        new=AsyncMock(side_effect=RuntimeError('boom')),
    ):
        await scheduler.dispatch_hooks(event, cfg)  # must not raise
```
with:
```python
    cfg = AppConfig(hooks=[HookConfig(id='h', hook='log', events=['ip_changed'])])
    event = IpChangedEvent(old_ip='1.1.1.1', new_ip='2.2.2.2', family='ipv4')
    with patch(
        'tether_ddns.hooks.registered_hooks.log_hook.LogHook.on_ip_changed',
        new=AsyncMock(side_effect=RuntimeError('boom')),
    ):
        await scheduler.dispatch_ip_changed(event, cfg)  # must not raise
```

In `test_dispatch_skips_unsupported_event`, replace the spy hook and calls:
```python
    @register_hook
    class _SpyHook(Hook):
        key = '_spy'
        display_name = 'Spy'
        supported_events = ('ip_changed',)

        async def handle(self, event: HookEvent, config: BaseModel) -> None:
            calls.append(event.type)

    try:
        assert HOOK_REGISTRY['_spy'] is _SpyHook
        cfg = AppConfig(hooks=[HookConfig(
            hook='_spy', enabled=True,
            events=['ip_changed', 'reachability_changed'], config={})])
        await scheduler.dispatch_hooks(
            HookEvent(type='reachability_changed', old='offline', new='online'), cfg)
        assert calls == []
        await scheduler.dispatch_hooks(
            HookEvent(type='ip_changed', old='a', new='b'), cfg)
        assert calls == ['ip_changed']
    finally:
        HOOK_REGISTRY.pop('_spy', None)
```
with:
```python
    @register_hook
    class _SpyHook(Hook):
        key = '_spy'
        display_name = 'Spy'

        async def on_ip_changed(
                self, event: IpChangedEvent, config: BaseModel) -> None:
            calls.append('ip_changed')

    try:
        assert HOOK_REGISTRY['_spy'] is _SpyHook
        cfg = AppConfig(hooks=[HookConfig(
            hook='_spy', enabled=True,
            events=['ip_changed', 'reachability_changed'], config={})])
        await scheduler.dispatch_reachability_changed(
            ReachabilityChangedEvent(online=True, was_online=False), cfg)
        assert calls == []
        await scheduler.dispatch_ip_changed(
            IpChangedEvent(old_ip='a', new_ip='b', family='ipv4'), cfg)
        assert calls == ['ip_changed']
    finally:
        HOOK_REGISTRY.pop('_spy', None)
```

In `test_run_hook_now_fires_per_known_ip_family`, replace the spy and assertions:
```python
    @register_hook
    class _SpyRun(Hook):
        key = '_spyrun'
        display_name = 'SpyRun'
        supported_events = ('ip_changed', 'reachability_changed')

        async def handle(self, event: HookEvent, config: BaseModel) -> None:
            calls.append((event.type, event.old, event.new))
```
with:
```python
    @register_hook
    class _SpyRun(Hook):
        key = '_spyrun'
        display_name = 'SpyRun'

        async def on_ip_changed(
                self, event: IpChangedEvent, config: BaseModel) -> None:
            calls.append(('ip_changed', event.old_ip, event.new_ip))

        async def on_reachability_changed(
                self, event: ReachabilityChangedEvent,
                config: BaseModel) -> None:
            calls.append(('reachability_changed', event.online, event.online))
```
and change the reachability assertion:
```python
        assert ('reachability_changed', 'online', 'online') in calls
```
to:
```python
        assert ('reachability_changed', True, True) in calls
```
(Also update the `calls` type annotation near the top of that test from
`list[tuple[str, str | None, str | None]]` to `list[tuple[str, object, object]]`.)

In `test_run_hook_now_skips_ip_changed_when_no_ip`, replace:
```python
    @register_hook
    class _SpyNoIp(Hook):
        key = '_spynoip'
        display_name = 'SpyNoIp'
        supported_events = ('ip_changed',)

        async def handle(self, event: HookEvent, config: BaseModel) -> None:
            ran.append(event.type)
```
with:
```python
    @register_hook
    class _SpyNoIp(Hook):
        key = '_spynoip'
        display_name = 'SpyNoIp'

        async def on_ip_changed(
                self, event: IpChangedEvent, config: BaseModel) -> None:
            ran.append('ip_changed')
```

- [ ] **Step 2: Run scheduler tests to verify they fail**

Run: `pytest test/unit/test_scheduler.py -q`
Expected: FAIL (`scheduler` has no `dispatch_ip_changed` / `dispatch_reachability_changed`).

- [ ] **Step 3: Rewrite scheduler dispatch functions**

In `tether_ddns/scheduler.py`, change the import of `HookEvent`:
```python
from tether_ddns.hooks.base import HookEvent
```
to
```python
from tether_ddns.hooks.base import (
    IpChangedEvent, ReachabilityChangedEvent)
```
(Match the exact existing import statement; it may be grouped with other names — replace only the `HookEvent` name.)

Replace `dispatch_hooks` with two typed dispatchers plus a shared helper:
```python
async def _dispatch(event_key: str, event: object, cfg: AppConfig) -> None:
    """Invoke every matching enabled hook, isolating exceptions."""
    for hook_cfg in cfg.hooks:
        hook_cls = HOOK_REGISTRY.get(hook_cfg.hook)
        if hook_cls is None:
            _log.warning('Unknown hook %s', hook_cfg.hook)
            continue
        if (not hook_cfg.enabled
                or event_key not in hook_cfg.events
                or event_key not in hook_cls.supported_events()):
            continue
        try:
            config = hook_cls.ConfigModel.model_validate(hook_cfg.config)
            await hook_cls()._dispatch(event_key, event, config)  # type: ignore[arg-type]  # noqa: SLF001
        except Exception:  # noqa: BLE001 - hook errors must be contained
            _log.exception('Hook %s failed on %s', hook_cfg.hook, event_key)


async def dispatch_ip_changed(event: IpChangedEvent, cfg: AppConfig) -> None:
    """Dispatch an ip_changed event to matching hooks."""
    await _dispatch('ip_changed', event, cfg)


async def dispatch_reachability_changed(
        event: ReachabilityChangedEvent, cfg: AppConfig) -> None:
    """Dispatch a reachability_changed event to matching hooks."""
    await _dispatch('reachability_changed', event, cfg)
```

Rewrite `run_hook_now` to build typed payloads:
```python
async def run_hook_now(
    hook_cfg: HookConfig, cfg: AppConfig, state: RuntimeState,
) -> dict[str, object]:
    """Fire a hook for its enabled+supported events using current state.

    Returns {'ran': <handle invocations>, 'skipped': [<event keys skipped>]}.
    """
    hook_cls = HOOK_REGISTRY.get(hook_cfg.hook)
    if hook_cls is None:
        _log.warning('Unknown hook %s', hook_cfg.hook)
        return {'ran': 0, 'skipped': list(hook_cfg.events)}
    jobs: list[tuple[str, object]] = []
    skipped: list[str] = []
    supported = hook_cls.supported_events()
    for event_key in hook_cfg.events:
        if event_key not in supported:
            continue
        if event_key == 'reachability_changed':
            jobs.append((
                event_key,
                ReachabilityChangedEvent(
                    online=state.online, was_online=state.online)))
        elif event_key == 'ip_changed':
            families: list[tuple[str, str]] = [
                (fam, ip) for fam, ip in (
                    ('ipv4', state.public_ipv4), ('ipv6', state.public_ipv6))
                if ip]
            if not families:
                skipped.append('ip_changed')
            for fam, ip in families:
                jobs.append((
                    event_key,
                    IpChangedEvent(old_ip=ip, new_ip=ip, family=fam)))  # type: ignore[arg-type]
    ran = 0
    for event_key, event in jobs:
        try:
            config = hook_cls.ConfigModel.model_validate(hook_cfg.config)
            await hook_cls()._dispatch(event_key, event, config)  # type: ignore[arg-type]  # noqa: SLF001
        except Exception:  # noqa: BLE001 - hook errors must be contained
            _log.exception('Hook %s failed on %s', hook_cfg.hook, event_key)
        ran += 1
    return {'ran': ran, 'skipped': skipped}
```

Update the two `Scheduler` call sites. Replace:
```python
        if reach.online != state.online:
            old = 'online' if state.online else 'offline'
            new = 'online' if reach.online else 'offline'
            state.set_online(reach.online)
            await dispatch_hooks(
                HookEvent(type='reachability_changed', old=old, new=new), cfg)
```
with:
```python
        if reach.online != state.online:
            was_online = state.online
            state.set_online(reach.online)
            await dispatch_reachability_changed(
                ReachabilityChangedEvent(
                    online=reach.online, was_online=was_online), cfg)
```

Replace:
```python
        if ipv4 is not None and ipv4 != state.public_ipv4:
            old = state.public_ipv4
            state.set_public_ipv4(ipv4)
            changed.add('ipv4')
            await dispatch_hooks(HookEvent(type='ip_changed', old=old, new=ipv4), cfg)
        if ipv6 is not None and ipv6 != state.public_ipv6:
            old6 = state.public_ipv6
            state.set_public_ipv6(ipv6)
            changed.add('ipv6')
            await dispatch_hooks(HookEvent(type='ip_changed', old=old6, new=ipv6), cfg)
```
with:
```python
        if ipv4 is not None and ipv4 != state.public_ipv4:
            old = state.public_ipv4
            state.set_public_ipv4(ipv4)
            changed.add('ipv4')
            await dispatch_ip_changed(
                IpChangedEvent(old_ip=old, new_ip=ipv4, family='ipv4'), cfg)
        if ipv6 is not None and ipv6 != state.public_ipv6:
            old6 = state.public_ipv6
            state.set_public_ipv6(ipv6)
            changed.add('ipv6')
            await dispatch_ip_changed(
                IpChangedEvent(old_ip=old6, new_ip=ipv6, family='ipv6'), cfg)
```

- [ ] **Step 4: Update `api.py`**

In `tether_ddns/api.py`, find the import of `EVENT_LABELS` (grep `EVENT_LABELS` and `supported_events`) and replace the `EVENT_LABELS` import name with `EVENT_SPECS`.

Replace `_validate_hook_events`:
```python
    for event in events:
        if event not in cls.supported_events:
```
with:
```python
    for event in events:
        if event not in cls.supported_events():
```

Replace the `/hooks` response builder:
```python
            {'key': k, 'display_name': c.display_name,
             'events': [
                 {'key': e, 'label': EVENT_LABELS.get(e, e)}
                 for e in c.supported_events],
             'schema': c.config_schema()}
```
with:
```python
            {'key': k, 'display_name': c.display_name,
             'events': [
                 {'key': e, 'label': EVENT_SPECS[e].label}
                 for e in c.supported_events()],
             'schema': c.config_schema()}
```

- [ ] **Step 5: Run the full unit suite to verify it passes**

Run: `pytest test/unit -q`
Expected: PASS (all tests).

- [ ] **Step 6: Commit**

```bash
git add tether_ddns/scheduler.py tether_ddns/api.py test/unit/test_scheduler.py test/unit/test_api.py
git commit -m "refactor(hooks): route dispatch through typed per-event methods"
```

---

### Task 4: Update README, static checks and cleanup

**Files:**
- Modify: `README.md`
- Verify only: whole `tether_ddns/` and `test/` tree.

- [ ] **Step 1: Update the "Add a hook" example in `README.md`**

Replace the code block:
```python
from pydantic import BaseModel
from tether_ddns.hooks.base import Hook, HookEvent, register_hook


@register_hook
class MyHook(Hook):
    key = 'myhook'
    display_name = 'My Hook'
    # Restrict which events this hook accepts. Defaults to all supported
    # events; the UI only offers these, and the scheduler never dispatches an
    # unsupported event to the hook.
    supported_events = ('ip_changed',)

    async def handle(self, event: HookEvent, config: BaseModel) -> None:
        # react to 'ip_changed' / 'reachability_changed' events
        ...
```
with:
```python
from pydantic import BaseModel
from tether_ddns.hooks.base import (
    Hook, IpChangedEvent, ReachabilityChangedEvent, register_hook)


@register_hook
class MyHook(Hook):
    key = 'myhook'
    display_name = 'My Hook'

    # Override only the event methods you care about. The events a hook
    # supports are inferred from which on_* methods it overrides; the UI only
    # offers those, and the scheduler never dispatches an unsupported event.
    async def on_ip_changed(
            self, event: IpChangedEvent, config: BaseModel) -> None:
        # react to a public IP change (event.new_ip, event.family)
        ...

    async def on_reachability_changed(
            self, event: ReachabilityChangedEvent, config: BaseModel) -> None:
        # react to an online/offline transition (event.online)
        ...
```

- [ ] **Step 2: Confirm no stale references remain**

Run: `grep -rn "HookEvent\|SUPPORTED_EVENTS\|EVENT_LABELS\|dispatch_hooks\|\.handle(" tether_ddns test`
Expected: no matches in `tether_ddns/` or `test/` (matches only under `docs/` are fine — those are historical plan documents).

- [ ] **Step 3: Run the lint/type test gate**

Run: `pytest test/test_ruff.py test/test_mypy.py test/test_pyright.py test/test_flake8.py -q`
Expected: PASS. If ruff/flake8 flags unused imports (e.g. a leftover `family_of` import) or mypy flags a payload construction, fix inline and re-run.

- [ ] **Step 4: Run the full suite once more**

Run: `pytest test/unit -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "docs: update README hook example for per-event methods"
```

---

## Self-Review

- **Spec coverage:** payload models (Task 1) ✓; `Hook` methods + inferred `supported_events` + `_dispatch` + `EVENT_SPECS` (Task 1) ✓; concrete hooks converted (Task 2) ✓; scheduler + api call sites, booleans for reachability, unchanged contract (Task 3) ✓; tests updated across all four affected test files ✓; lint/type gate (Task 4) ✓.
- **Placeholder scan:** every code step shows complete code; no TBD/TODO.
- **Type consistency:** `IpChangedEvent(old_ip, new_ip, family)`, `ReachabilityChangedEvent(online, was_online)`, `EVENT_SPECS[key].label/method/model`, `supported_events()` classmethod, `_dispatch(event_key, event, config)`, `dispatch_ip_changed`/`dispatch_reachability_changed` are used consistently across tasks.
