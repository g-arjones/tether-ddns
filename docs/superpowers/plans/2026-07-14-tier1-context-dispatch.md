# Tier 1: AppContext + Event Synthesis + DispatchService — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce a framework-free `AppContext`, move hook-event payload construction onto the event types via `from_context`, add a `find_or_404` helper, and extract hook dispatch into a class-based `DispatchService`.

**Architecture:** A new `AppContext` dataclass bundles shared mutable state (`config`, `runtime`, `store`, `manager`) and is built once in `app.py`'s lifespan. Each hook event type gains a `from_context(ctx)` classmethod so `run_hook_now` becomes a generic, branch-free loop. Hook dispatch moves from module-level functions in `scheduler.py` into a `DispatchService` that owns the context. Clean break: no compatibility shims.

**Tech Stack:** Python 3.12+, FastAPI, Pydantic v2, APScheduler, pytest + pytest-asyncio.

## Global Constraints

- Single quotes for strings (ruff/flake8 enforced).
- Every function/method (including tests) needs a one-line docstring ending with a period (D103/pep257).
- Imports strictly alphabetical (flake8 I101).
- Async tests use `@pytest.mark.asyncio` + `async def` + `await` (never `asyncio.run`).
- Type gates: `mypy .` and `pyright` (strict) must pass over `tether_ddns/` AND `test/`.
- Coverage gate: `pytest test/ --cov=tether_ddns --cov-fail-under=90`.
- Run gates over BOTH dirs: `flake8 test/ tether_ddns/`, plain `pyright`.
- Access protected members in tests via `patch.object(obj, '_name')`; direct protected calls need `# pyright: ignore[reportPrivateUsage]` + `# noqa: SLF001`.
- Branch: `refactor/services-appcontext`. This tier is one commit landing on green gates.

---

## File Structure

- Create: `tether_ddns/context.py` — `AppContext` dataclass.
- Create: `tether_ddns/services/__init__.py` — empty package marker.
- Create: `tether_ddns/services/collection.py` — `find_or_404`.
- Create: `tether_ddns/services/dispatch.py` — `DispatchService`.
- Modify: `tether_ddns/hooks/base.py` — add `from_context` classmethods + `family_for` helper.
- Modify: `tether_ddns/scheduler.py` — remove `_dispatch`, `dispatch_*`, `run_hook_now`; call `DispatchService`.
- Modify: `tether_ddns/api.py` — use `find_or_404`; call `DispatchService.run_hook_now`.
- Modify: `tether_ddns/app.py` — build `AppContext` + `DispatchService` in the composition root.
- Create/Modify tests: `test/unit/test_context.py`, `test/unit/test_collection.py`, `test/unit/test_event_from_context.py`, `test/unit/test_dispatch_service.py`; migrate `test/unit/test_scheduler.py`, `test/unit/test_api.py`.

---

### Task 1: `find_or_404` helper

**Files:**
- Create: `tether_ddns/services/__init__.py`
- Create: `tether_ddns/services/collection.py`
- Test: `test/unit/test_collection.py`

**Interfaces:**
- Produces: `find_or_404(items: list[T], item_id: str, detail: str) -> tuple[int, T]` where `T` has a `.id: str` attribute; raises `fastapi.HTTPException(status_code=404, detail=detail)` on miss.

- [ ] **Step 1: Write the failing test**

```python
"""Tests for the find_or_404 collection helper."""
import pytest

from fastapi import HTTPException

from tether_ddns.config import DomainConfig
from tether_ddns.services.collection import find_or_404


def test_find_or_404_returns_index_and_item() -> None:
    """A matching id returns its index and the item."""
    a = DomainConfig(id='a', hostname='h1', provider='duckdns')
    b = DomainConfig(id='b', hostname='h2', provider='duckdns')
    idx, item = find_or_404([a, b], 'b', 'not found')
    assert idx == 1
    assert item is b


def test_find_or_404_raises_on_miss() -> None:
    """A missing id raises HTTPException(404) with the given detail."""
    with pytest.raises(HTTPException) as exc:
        find_or_404([], 'x', 'domain not found')
    assert exc.value.status_code == 404
    assert exc.value.detail == 'domain not found'
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest test/unit/test_collection.py -v`
Expected: FAIL with `ModuleNotFoundError: tether_ddns.services.collection`.

- [ ] **Step 3: Create the package marker**

Create `tether_ddns/services/__init__.py`:

```python
"""Application service layer."""
```

- [ ] **Step 4: Write minimal implementation**

Create `tether_ddns/services/collection.py`:

```python
"""Generic helpers for id-keyed configuration collections."""
from __future__ import annotations

from typing import Protocol, TypeVar

from fastapi import HTTPException


class _HasId(Protocol):
    """Structural type for objects carrying a string id."""

    id: str  # noqa: A003


T = TypeVar('T', bound=_HasId)


def find_or_404(items: list[T], item_id: str, detail: str) -> tuple[int, T]:
    """Return (index, item) for a matching id, or raise HTTPException(404)."""
    for i, item in enumerate(items):
        if item.id == item_id:
            return i, item
    raise HTTPException(status_code=404, detail=detail)
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pytest test/unit/test_collection.py -v`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add tether_ddns/services/__init__.py tether_ddns/services/collection.py test/unit/test_collection.py
git commit -m "feat: add find_or_404 collection helper"
```

---

### Task 2: `AppContext`

**Files:**
- Create: `tether_ddns/context.py`
- Test: `test/unit/test_context.py`

**Interfaces:**
- Consumes: `AppConfig`, `RuntimeState`, `ConfigStore` (config.py, runtime.py), `ConnectionManager` (ws.py).
- Produces: `AppContext(config, runtime, store, manager)` dataclass with `persist() -> None` (calls `store.save(config)`) and `rebuild() -> None` (calls `persist()` then `runtime.rebuild(config)`).

- [ ] **Step 1: Write the failing test**

```python
"""Tests for the framework-free AppContext."""
from unittest.mock import MagicMock

from tether_ddns.config import AppConfig
from tether_ddns.context import AppContext
from tether_ddns.runtime import RuntimeState


def _ctx() -> tuple[AppContext, MagicMock, MagicMock]:
    """Build an AppContext with mocked store and manager."""
    cfg = AppConfig()
    runtime = RuntimeState()
    store = MagicMock()
    manager = MagicMock()
    return AppContext(cfg, runtime, store, manager), store, manager


def test_persist_saves_config_via_store() -> None:
    """persist() saves the current config through the store."""
    ctx, store, _ = _ctx()
    ctx.persist()
    store.save.assert_called_once_with(ctx.config)


def test_rebuild_persists_then_rebuilds_runtime() -> None:
    """rebuild() saves config and rebuilds runtime from it."""
    ctx, store, _ = _ctx()
    ctx.runtime = MagicMock(spec=RuntimeState)
    ctx.rebuild()
    store.save.assert_called_once_with(ctx.config)
    ctx.runtime.rebuild.assert_called_once_with(ctx.config)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest test/unit/test_context.py -v`
Expected: FAIL with `ModuleNotFoundError: tether_ddns.context`.

- [ ] **Step 3: Write minimal implementation**

Create `tether_ddns/context.py`:

```python
"""Framework-free shared application context."""
from __future__ import annotations

from dataclasses import dataclass

from tether_ddns.config import AppConfig, ConfigStore
from tether_ddns.runtime import RuntimeState
from tether_ddns.ws import ConnectionManager


@dataclass
class AppContext:
    """Bundles shared mutable state for controllers and the scheduler."""

    config: AppConfig
    runtime: RuntimeState
    store: ConfigStore
    manager: ConnectionManager

    def persist(self) -> None:
        """Save the current configuration to disk."""
        self.store.save(self.config)

    def rebuild(self) -> None:
        """Persist configuration, then rebuild runtime from it."""
        self.persist()
        self.runtime.rebuild(self.config)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest test/unit/test_context.py -v`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add tether_ddns/context.py test/unit/test_context.py
git commit -m "feat: add framework-free AppContext"
```

---

### Task 3: `family_for` helper + event `from_context` classmethods

**Files:**
- Modify: `tether_ddns/hooks/base.py`
- Test: `test/unit/test_event_from_context.py`

**Interfaces:**
- Consumes: `AppContext` (context.py).
- Produces on each event class a classmethod `from_context(cls, ctx: AppContext) -> list[HookEventBase]`:
  - `ReachabilityChangedEvent.from_context` → single event with `online=was_online=ctx.runtime.online`.
  - `IpChangedEvent.from_context` → one per family with a known IP (`old_ip == new_ip == ip`).
  - `DomainUpdatePendingEvent.from_context` → one per domain whose runtime status is `'pending'`.
  - `DomainUpdateSuccessEvent.from_context` → one per domain with status `'synced'` and non-None `ip`.
  - `DomainUpdateErrorEvent.from_context` → one per domain with status `'error'`.
- Produces `family_for(record_type: str) -> IPFamily` (returns `'ipv6'` for `'AAAA'`, else `'ipv4'`).

Note: import `AppContext` under `TYPE_CHECKING` in `hooks/base.py` to avoid a circular import (context.py imports config/runtime/ws, not hooks).

- [ ] **Step 1: Write the failing test**

```python
"""Tests for event.from_context current-state synthesis."""
from tether_ddns.config import AppConfig, DomainConfig
from tether_ddns.context import AppContext
from tether_ddns.hooks.base import (
    DomainUpdateErrorEvent, DomainUpdatePendingEvent,
    DomainUpdateSuccessEvent, IpChangedEvent, ReachabilityChangedEvent)
from tether_ddns.runtime import DomainRuntime, RuntimeState


def _ctx(cfg: AppConfig, runtime: RuntimeState) -> AppContext:
    """Build an AppContext from config and runtime (store/manager unused here)."""
    return AppContext(cfg, runtime, store=None, manager=None)  # type: ignore[arg-type]


def test_reachability_from_context_snapshots_online() -> None:
    """Reachability synthesis mirrors current online with no transition."""
    rt = RuntimeState()
    rt.online = True
    events = ReachabilityChangedEvent.from_context(_ctx(AppConfig(), rt))
    assert len(events) == 1
    assert events[0].online is True
    assert events[0].was_online is True


def test_ip_changed_from_context_one_per_known_family() -> None:
    """Only families with a known IP produce an event."""
    rt = RuntimeState()
    rt.public_ipv4 = '1.2.3.4'
    events = IpChangedEvent.from_context(_ctx(AppConfig(), rt))
    assert [(e.family, e.new_ip) for e in events] == [('ipv4', '1.2.3.4')]
    assert events[0].old_ip == '1.2.3.4'


def test_ip_changed_from_context_empty_when_no_ip() -> None:
    """No known IP yields an empty list (skipped)."""
    assert IpChangedEvent.from_context(_ctx(AppConfig(), RuntimeState())) == []


def test_domain_success_from_context_matches_synced_domains() -> None:
    """Only synced domains with a known ip produce success events."""
    cfg = AppConfig(domains=[DomainConfig(id='d1', hostname='h', provider='duckdns')])
    rt = RuntimeState()
    rt.domains['d1'] = DomainRuntime(id='d1', status='synced', ip='9.9.9.9')
    events = DomainUpdateSuccessEvent.from_context(_ctx(cfg, rt))
    assert len(events) == 1
    assert events[0].domain_id == 'd1'
    assert events[0].ip == '9.9.9.9'


def test_domain_error_from_context_matches_error_domains() -> None:
    """Only error domains produce error events, carrying the message."""
    cfg = AppConfig(domains=[DomainConfig(id='d1', hostname='h', provider='duckdns')])
    rt = RuntimeState()
    rt.domains['d1'] = DomainRuntime(id='d1', status='error', message='boom')
    events = DomainUpdateErrorEvent.from_context(_ctx(cfg, rt))
    assert len(events) == 1
    assert events[0].message == 'boom'


def test_domain_pending_from_context_matches_pending_domains() -> None:
    """Only pending domains produce pending events."""
    cfg = AppConfig(domains=[DomainConfig(id='d1', hostname='h', provider='duckdns')])
    rt = RuntimeState()
    rt.domains['d1'] = DomainRuntime(id='d1', status='pending')
    rt.public_ipv4 = '1.2.3.4'
    events = DomainUpdatePendingEvent.from_context(_ctx(cfg, rt))
    assert len(events) == 1
    assert events[0].current_ip == '1.2.3.4'
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest test/unit/test_event_from_context.py -v`
Expected: FAIL with `AttributeError: type object 'ReachabilityChangedEvent' has no attribute 'from_context'`.

- [ ] **Step 3: Add `family_for` and imports to `hooks/base.py`**

At the top of `tether_ddns/hooks/base.py`, add the typing import and helper. Add to the existing `from typing import ...` line so it reads `from typing import Literal, TYPE_CHECKING`, add the family type import, and a `TYPE_CHECKING` block:

```python
from typing import Literal, TYPE_CHECKING

from tether_ddns.ip_sources.base import IPFamily

if TYPE_CHECKING:
    from tether_ddns.context import AppContext


def family_for(record_type: str) -> IPFamily:
    """Return the IP family a record type resolves against."""
    return 'ipv6' if record_type == 'AAAA' else 'ipv4'
```

- [ ] **Step 4: Add `from_context` to each event class**

In `ReachabilityChangedEvent`:

```python
    @classmethod
    def from_context(cls, ctx: AppContext) -> list['ReachabilityChangedEvent']:
        """Snapshot current reachability with no transition."""
        online = ctx.runtime.online
        return [cls(online=online, was_online=online)]
```

In `IpChangedEvent`:

```python
    @classmethod
    def from_context(cls, ctx: AppContext) -> list['IpChangedEvent']:
        """One event per family that currently has a known public IP."""
        pairs: tuple[tuple[IPFamily, str | None], ...] = (
            ('ipv4', ctx.runtime.public_ipv4), ('ipv6', ctx.runtime.public_ipv6))
        return [cls(old_ip=ip, new_ip=ip, family=fam) for fam, ip in pairs if ip]
```

In `DomainUpdatePendingEvent`:

```python
    @classmethod
    def from_context(cls, ctx: AppContext) -> list['DomainUpdatePendingEvent']:
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
```

In `DomainUpdateSuccessEvent`:

```python
    @classmethod
    def from_context(cls, ctx: AppContext) -> list['DomainUpdateSuccessEvent']:
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
```

In `DomainUpdateErrorEvent`:

```python
    @classmethod
    def from_context(cls, ctx: AppContext) -> list['DomainUpdateErrorEvent']:
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
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pytest test/unit/test_event_from_context.py -v`
Expected: PASS (6 tests).

- [ ] **Step 6: Run type gates**

Run: `mypy . && pyright`
Expected: no new errors.

- [ ] **Step 7: Commit**

```bash
git add tether_ddns/hooks/base.py test/unit/test_event_from_context.py
git commit -m "feat: add from_context synthesis to hook events"
```

---

### Task 4: `DispatchService`

**Files:**
- Create: `tether_ddns/services/dispatch.py`
- Test: `test/unit/test_dispatch_service.py`

**Interfaces:**
- Consumes: `AppContext`; `HOOK_REGISTRY`, `EVENT_SPECS`, `HookEventBase` (hooks/base.py); `HookConfig` (config.py).
- Produces: `DispatchService(ctx: AppContext)` with:
  - `async dispatch(self, event_key: str, event: HookEventBase) -> None` — invoke every enabled, subscribed, supported hook; isolate exceptions.
  - `async run_hook_now(self, hook_cfg: HookConfig) -> dict[str, object]` — returns `{'ran': int, 'skipped': list[str]}`; uses `EVENT_SPECS[key].model.from_context(ctx)`.

- [ ] **Step 1: Write the failing test**

```python
"""Tests for DispatchService dispatch and run_hook_now."""
from unittest.mock import AsyncMock, MagicMock

import pytest

from tether_ddns.config import AppConfig, HookConfig
from tether_ddns.context import AppContext
from tether_ddns.hooks.base import HOOK_REGISTRY, ReachabilityChangedEvent
from tether_ddns.runtime import RuntimeState
from tether_ddns.services.dispatch import DispatchService


def _ctx(cfg: AppConfig) -> AppContext:
    """Build an AppContext with the given config and a fresh runtime."""
    return AppContext(cfg, RuntimeState(), MagicMock(), MagicMock())


@pytest.mark.asyncio
async def test_dispatch_invokes_matching_enabled_hook() -> None:
    """A subscribed, enabled, supported hook is dispatched."""
    hook_cls = MagicMock()
    hook_cls.supported_events.return_value = ('reachability_changed',)
    instance = MagicMock()
    instance._dispatch = AsyncMock()
    hook_cls.return_value = instance
    hook_cls.ConfigModel.model_validate.return_value = MagicMock()
    hc = HookConfig(hook='fake', enabled=True, events=['reachability_changed'])
    cfg = AppConfig(hooks=[hc])
    with pytest.MonkeyPatch.context() as mp:
        mp.setitem(HOOK_REGISTRY, 'fake', hook_cls)
        svc = DispatchService(_ctx(cfg))
        await svc.dispatch(
            'reachability_changed',
            ReachabilityChangedEvent(online=True, was_online=False))
    instance._dispatch.assert_awaited_once()


@pytest.mark.asyncio
async def test_dispatch_skips_disabled_hook() -> None:
    """A disabled hook is not dispatched."""
    hook_cls = MagicMock()
    hook_cls.supported_events.return_value = ('reachability_changed',)
    instance = MagicMock()
    instance._dispatch = AsyncMock()
    hook_cls.return_value = instance
    hc = HookConfig(hook='fake', enabled=False, events=['reachability_changed'])
    cfg = AppConfig(hooks=[hc])
    with pytest.MonkeyPatch.context() as mp:
        mp.setitem(HOOK_REGISTRY, 'fake', hook_cls)
        svc = DispatchService(_ctx(cfg))
        await svc.dispatch(
            'reachability_changed',
            ReachabilityChangedEvent(online=True))
    instance._dispatch.assert_not_awaited()


@pytest.mark.asyncio
async def test_run_hook_now_unknown_hook_skips_all() -> None:
    """An unknown hook key skips all its configured events."""
    hc = HookConfig(hook='ghost', events=['ip_changed'])
    svc = DispatchService(_ctx(AppConfig(hooks=[hc])))
    result = await svc.run_hook_now(hc)
    assert result == {'ran': 0, 'skipped': ['ip_changed']}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest test/unit/test_dispatch_service.py -v`
Expected: FAIL with `ModuleNotFoundError: tether_ddns.services.dispatch`.

- [ ] **Step 3: Write minimal implementation**

Create `tether_ddns/services/dispatch.py`:

```python
"""Hook event dispatch as a context-owning service."""
from __future__ import annotations

from tether_ddns.context import AppContext
from tether_ddns.config import HookConfig
from tether_ddns.hooks.base import EVENT_SPECS, HOOK_REGISTRY, HookEventBase
from tether_ddns.logging_setup import get_logger

_log = get_logger()


class DispatchService:
    """Fires configured hooks for events over a shared AppContext."""

    def __init__(self, ctx: AppContext) -> None:
        """Create a dispatch service bound to a context."""
        self._ctx = ctx

    async def dispatch(self, event_key: str, event: HookEventBase) -> None:
        """Invoke every matching enabled hook, isolating exceptions."""
        for hc in self._ctx.config.hooks:
            cls = HOOK_REGISTRY.get(hc.hook)
            if cls is None:
                _log.warning('Unknown hook %s', hc.hook)
                continue
            if (not hc.enabled or event_key not in hc.events
                    or event_key not in cls.supported_events()):
                continue
            try:
                config = cls.ConfigModel.model_validate(hc.config)
                await cls()._dispatch(  # pyright: ignore[reportPrivateUsage]  # noqa: SLF001
                    event_key, event, config)  # type: ignore[arg-type]
            except Exception:  # noqa: BLE001 - hook errors must be contained
                _log.exception('Hook %s failed on %s', hc.hook, event_key)

    async def run_hook_now(self, hook_cfg: HookConfig) -> dict[str, object]:
        """Fire a hook for its enabled+supported events using current state."""
        cls = HOOK_REGISTRY.get(hook_cfg.hook)
        if cls is None:
            _log.warning('Unknown hook %s', hook_cfg.hook)
            return {'ran': 0, 'skipped': list(hook_cfg.events)}
        supported = cls.supported_events()
        ran = 0
        skipped: list[str] = []
        for event_key in hook_cfg.events:
            if event_key not in supported:
                continue
            events = EVENT_SPECS[event_key].model.from_context(self._ctx)
            if not events:
                skipped.append(event_key)
                continue
            for event in events:
                try:
                    config = cls.ConfigModel.model_validate(hook_cfg.config)
                    await cls()._dispatch(  # pyright: ignore[reportPrivateUsage]  # noqa: SLF001
                        event_key, event, config)  # type: ignore[arg-type]
                except Exception:  # noqa: BLE001 - hook errors must be contained
                    _log.exception('Hook %s failed on %s', hook_cfg.hook, event_key)
                ran += 1
        return {'ran': ran, 'skipped': skipped}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest test/unit/test_dispatch_service.py -v`
Expected: PASS (3 tests).

- [ ] **Step 5: Run type gates**

Run: `mypy . && pyright`
Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add tether_ddns/services/dispatch.py test/unit/test_dispatch_service.py
git commit -m "feat: add DispatchService owning AppContext"
```

---

### Task 5: Wire `AppContext` + `DispatchService` into `app.py`; remove scheduler dispatch functions

**Files:**
- Modify: `tether_ddns/app.py`
- Modify: `tether_ddns/scheduler.py`
- Modify: `tether_ddns/api.py`
- Test: migrate `test/unit/test_scheduler.py`, `test/unit/test_api.py`

**Interfaces:**
- Consumes: `AppContext` (context.py), `DispatchService` (services/dispatch.py).
- Produces: `app.state.ctx: AppContext`, `app.state.dispatch: DispatchService`. `scheduler.py` no longer defines `_dispatch`, `dispatch_ip_changed`, `dispatch_reachability_changed`, `dispatch_domain_update_pending/success/error`, or `run_hook_now`. `Scheduler.__init__` gains a `dispatch: DispatchService` parameter; its `check_reachability`/`sync_ips` call `self._dispatch.dispatch(key, event)`.

- [ ] **Step 1: Migrate scheduler dispatch tests to DispatchService**

In `test/unit/test_scheduler.py`, tests currently patch `tether_ddns.scheduler.dispatch_*` and call `scheduler.dispatch_ip_changed(...)`/`scheduler.run_hook_now(...)`. Replace those with `DispatchService` usage. Example replacements:

Replace the `run_hook_now` call sites:

```python
from tether_ddns.context import AppContext
from tether_ddns.services.dispatch import DispatchService


def _ctx(cfg: AppConfig, state: RuntimeState) -> AppContext:
    """Build an AppContext for dispatch tests."""
    from unittest.mock import MagicMock
    return AppContext(cfg, state, MagicMock(), MagicMock())
```

Then `result = await scheduler.run_hook_now(cfg.hooks[0], cfg, state)` becomes:

```python
    result = await DispatchService(_ctx(cfg, state)).run_hook_now(cfg.hooks[0])
```

And `await scheduler.dispatch_ip_changed(event, cfg)` becomes:

```python
    await DispatchService(_ctx(cfg, state)).dispatch('ip_changed', event)
```

For tests asserting the scheduler dispatches on transitions (patching `tether_ddns.scheduler.dispatch_domain_update_success` etc.), repoint to patching the `DispatchService.dispatch` method on the instance the scheduler holds — see Step 5 of the Tier 2 plan; for Tier 1, update only the dispatch-function-focused tests and leave scheduler-transition tests until `Scheduler` takes a `dispatch` arg (this task).

- [ ] **Step 2: Run migrated dispatch tests to verify they fail**

Run: `pytest test/unit/test_scheduler.py -v -k "run_hook or dispatch"`
Expected: FAIL (old symbols removed / not yet updated) — confirms tests target the new API.

- [ ] **Step 3: Remove dispatch functions from `scheduler.py` and inject `DispatchService`**

In `tether_ddns/scheduler.py`: delete `_dispatch`, all five `dispatch_*` async wrappers, and `run_hook_now`. Change `Scheduler.__init__` to accept and store a dispatcher, and update the transition call sites:

```python
    def __init__(self, dispatch: DispatchService) -> None:
        """Create an unstarted scheduler bound to a dispatcher."""
        self._scheduler = AsyncIOScheduler()
        self._reachability = ReachabilityService()
        self._dispatch = dispatch
```

In `check_reachability`, replace `await dispatch_reachability_changed(ReachabilityChangedEvent(...), cfg)` with:

```python
            await self._dispatch.dispatch(
                'reachability_changed',
                ReachabilityChangedEvent(online=reach.online, was_online=was_online))
```

In `sync_ips`, replace each `await dispatch_ip_changed(...)`, `await dispatch_domain_update_success(...)`, `await dispatch_domain_update_error(...)`, `await dispatch_domain_update_pending(...)` with `await self._dispatch.dispatch('<key>', <Event>(...))`. Add `from tether_ddns.services.dispatch import DispatchService` to the imports (alphabetical).

- [ ] **Step 4: Build `AppContext` + `DispatchService` in `app.py`**

In `tether_ddns/app.py` lifespan, after `manager = ConnectionManager()` and before `scheduler = Scheduler()`, add:

```python
        from tether_ddns.context import AppContext
        from tether_ddns.services.dispatch import DispatchService
        ctx = AppContext(config, runtime, resolved_store, manager)
        dispatch = DispatchService(ctx)
        scheduler = Scheduler(dispatch)
```

Remove the old `scheduler = Scheduler()` line. Add `app.state.ctx = ctx` and `app.state.dispatch = dispatch` alongside the other `app.state.*` assignments.

- [ ] **Step 5: Update `api.py` — `find_or_404` + `run_hook_now`**

In `tether_ddns/api.py`, replace the four manual lookup loops in `update_domain`, `delete_domain`, `update_hook`, `delete_hook` with `find_or_404`. Example for `update_domain`:

```python
    @router.put('/domains/{domain_id}')
    def update_domain(domain_id: str, payload: DomainInput) -> dict[str, object]:
        i, d = find_or_404(app.state.config.domains, domain_id, 'domain not found')
        data = payload.model_dump()
        data['provider_config'] = merge_secrets(
            _provider_schema(payload.provider),
            payload.provider_config, d.provider_config)
        updated = DomainConfig(id=domain_id, **data)
        app.state.config.domains[i] = updated
        _persist(app)
        app.state.runtime.rebuild(app.state.config)
        return _masked_domain(updated)
```

Replace the `run_hook` route body (which imported `run_hook_now` from `tether_ddns.scheduler`) with:

```python
    @router.post('/hooks-config/{hook_id}/run')
    async def run_hook(hook_id: str) -> dict[str, object]:
        _, h = find_or_404(app.state.config.hooks, hook_id, 'hook not found')
        return await app.state.dispatch.run_hook_now(h)
```

Add `from tether_ddns.services.collection import find_or_404` to imports (alphabetical). Remove the now-unused `from tether_ddns.scheduler import run_hook_now` local import.

- [ ] **Step 6: Migrate `test_api.py` dispatch patch targets**

In `test/unit/test_api.py`, the sync test patches `tether_ddns.scheduler.dispatch_domain_update_success/error/pending`. Repoint these to `tether_ddns.services.sync` targets in Tier 2; for Tier 1, the `/hooks-config/{id}/run` test must patch the dispatcher on `app.state.dispatch`. Update the run-hook test to assert against `app.state.dispatch.run_hook_now` behavior (call the real service; assert response `{'ran', 'skipped'}`).

- [ ] **Step 7: Run the full gate suite**

Run:
```bash
pytest test/ --cov=tether_ddns --cov-fail-under=90
flake8 test/ tether_ddns/ && ruff check .
mypy . && pyright
```
Expected: all pass; coverage ≥ 90%.

- [ ] **Step 8: Manual smoke**

Run: `uvicorn tether_ddns.app:create_app --factory --port 8099` (in a scratch dir), then `curl localhost:8099/api/state` and `curl -X POST localhost:8099/api/hooks-config/<id>/run` for a configured hook. Expected: `/api/state` returns JSON; run returns `{"ran": ..., "skipped": [...]}`.

- [ ] **Step 9: Commit (Tier 1 complete)**

```bash
git add -A
git commit -m "refactor: AppContext + DispatchService, remove scheduler dispatch funcs"
```

---

## Self-Review

- **Spec coverage:** AppContext (Task 2) ✓; from_context on all five events (Task 3) ✓; DispatchService + generic run_hook_now (Task 4) ✓; find_or_404 (Task 1) ✓; clean break / no shims (Task 5 removes symbols) ✓; composition root in app.py (Task 5) ✓. SyncService/thin Scheduler are Tier 2 (out of scope here) ✓.
- **Type consistency:** `AppContext(config, runtime, store, manager)` used identically in Tasks 2–5. `DispatchService(ctx)`, `.dispatch(event_key, event)`, `.run_hook_now(hook_cfg)` consistent across Tasks 4–5. `from_context(cls, ctx) -> list[...]` uniform in Task 3.
- **Boundary preserved:** live `sync_ips` still builds transition events inline (it constructs `IpChangedEvent(old_ip=old, new_ip=ipv4, ...)`); only `run_hook_now` uses `from_context`.
