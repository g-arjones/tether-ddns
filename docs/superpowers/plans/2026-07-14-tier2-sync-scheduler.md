# Tier 2: SyncService + Thin Scheduler — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Precondition:** Tier 1 is merged/complete (`AppContext`, `DispatchService`, `from_context`, `find_or_404` exist; `scheduler.py` no longer defines dispatch functions; `Scheduler.__init__(dispatch)`).

**Goal:** Extract IP-sync orchestration from `scheduler.py` into a class-based `SyncService(ctx, dispatch)`, reduce `Scheduler` to APScheduler bookkeeping delegating to it, and route the manual `/domains/{id}/sync` endpoint through `SyncService.sync_one_now`.

**Architecture:** `SyncService` owns the `AppContext` and a concrete `DispatchService`. It provides `sync_domain`, `refresh_public_ips`, `sync_ips`, `_sync_one`, and `sync_one_now`. `Scheduler` holds the APScheduler instance and `ReachabilityService`, delegating job bodies to `SyncService` and keeping only `_publish_next_check`. Dependency graph: `Scheduler → SyncService → DispatchService → AppContext`.

**Tech Stack:** Python 3.12+, FastAPI, Pydantic v2, APScheduler, pytest + pytest-asyncio.

## Global Constraints

- Single quotes; one-line docstrings ending with a period on every function/method incl. tests.
- Imports strictly alphabetical.
- Async tests use `@pytest.mark.asyncio` + `async def` + `await`.
- `mypy .` and `pyright` (strict) over `tether_ddns/` AND `test/`.
- `pytest test/ --cov=tether_ddns --cov-fail-under=90`.
- `flake8 test/ tether_ddns/`, `ruff check .`.
- Protected access in tests via `patch.object`; direct protected calls need `# pyright: ignore[reportPrivateUsage]` + `# noqa: SLF001`.
- Branch: `refactor/services-appcontext`. This tier is a second commit landing on green gates.

---

## File Structure

- Create: `tether_ddns/services/sync.py` — `SyncService`.
- Modify: `tether_ddns/scheduler.py` — thin `Scheduler(ctx, sync, reachability)`; job bodies delegate.
- Modify: `tether_ddns/app.py` — build `SyncService`; pass it to `Scheduler`.
- Modify: `tether_ddns/api.py` — `/domains/{id}/sync` delegates to `SyncService.sync_one_now`; `/refresh` uses scheduler `check_once`.
- Test: `test/unit/test_sync_service.py` (new); migrate `test/unit/test_scheduler.py`, `test/unit/test_api.py`.

---

### Task 1: `SyncService.sync_domain`

**Files:**
- Create: `tether_ddns/services/sync.py`
- Test: `test/unit/test_sync_service.py`

**Interfaces:**
- Consumes: `AppContext`, `DispatchService`; `PROVIDER_REGISTRY` (providers/base.py); `Status`, `RuntimeState` (runtime.py); `DomainConfig` (config.py); `family_for` (hooks/base.py); `detect_public_ip`, `IPFamily` (ip_sources/base.py).
- Produces: `SyncService(ctx: AppContext, dispatch: DispatchService)` with `async sync_domain(self, domain: DomainConfig, ip: str) -> Status`.

- [ ] **Step 1: Write the failing test**

```python
"""Tests for SyncService domain sync and IP orchestration."""
from unittest.mock import AsyncMock, MagicMock

import pytest

from tether_ddns.config import AppConfig, DomainConfig
from tether_ddns.context import AppContext
from tether_ddns.providers.base import load_providers
from tether_ddns.runtime import RuntimeState
from tether_ddns.services.sync import SyncService


def _svc(cfg: AppConfig, state: RuntimeState) -> SyncService:
    """Build a SyncService with a mocked dispatcher."""
    ctx = AppContext(cfg, state, MagicMock(), MagicMock())
    dispatch = MagicMock()
    dispatch.dispatch = AsyncMock()
    return SyncService(ctx, dispatch)


@pytest.mark.asyncio
async def test_sync_domain_unknown_provider_sets_error() -> None:
    """An unknown provider leaves the domain in error."""
    domain = DomainConfig(id='d1', hostname='h', provider='nope')
    state = RuntimeState()
    state.rebuild(AppConfig(domains=[domain]))
    svc = _svc(AppConfig(domains=[domain]), state)
    result = await svc.sync_domain(domain, '1.2.3.4')
    assert result == 'error'
    assert state.domains['d1'].status == 'error'


@pytest.mark.asyncio
async def test_sync_domain_success_marks_synced() -> None:
    """A successful provider update marks the domain synced."""
    load_providers()
    domain = DomainConfig(
        id='d1', hostname='h.duckdns.org', provider='duckdns',
        provider_config={'token': 't'})
    state = RuntimeState()
    state.rebuild(AppConfig(domains=[domain]))
    svc = _svc(AppConfig(domains=[domain]), state)
    with pytest.MonkeyPatch.context() as mp:
        from tether_ddns.providers import ddns_providers  # noqa: F401
        from tether_ddns.providers.base import PROVIDER_REGISTRY
        provider = PROVIDER_REGISTRY['duckdns']
        mp.setattr(provider, 'update', AsyncMock(return_value='1.2.3.4'))
        result = await svc.sync_domain(domain, '1.2.3.4')
    assert result == 'synced'
    assert state.domains['d1'].status == 'synced'
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest test/unit/test_sync_service.py -v`
Expected: FAIL with `ModuleNotFoundError: tether_ddns.services.sync`.

- [ ] **Step 3: Write minimal implementation**

Create `tether_ddns/services/sync.py`:

```python
"""IP detection and domain-sync orchestration as a context-owning service."""
from __future__ import annotations

from tether_ddns.config import DomainConfig
from tether_ddns.context import AppContext
from tether_ddns.hooks.base import (
    DomainUpdateErrorEvent, DomainUpdatePendingEvent,
    DomainUpdateSuccessEvent, IpChangedEvent, family_for)
from tether_ddns.ip_sources.base import IPFamily, detect_public_ip
from tether_ddns.logging_setup import get_logger
from tether_ddns.providers.base import PROVIDER_REGISTRY
from tether_ddns.runtime import RuntimeState, Status
from tether_ddns.services.dispatch import DispatchService

_log = get_logger()


class SyncService:
    """Owns IP detection and per-domain sync over a shared AppContext."""

    def __init__(self, ctx: AppContext, dispatch: DispatchService) -> None:
        """Create a sync service bound to a context and dispatcher."""
        self._ctx = ctx
        self._dispatch = dispatch

    @property
    def _state(self) -> RuntimeState:
        """Return the runtime state from the context."""
        return self._ctx.runtime

    async def sync_domain(self, domain: DomainConfig, ip: str) -> Status:
        """Update a single domain, isolating provider exceptions."""
        state = self._state
        provider_cls = PROVIDER_REGISTRY.get(domain.provider)
        if provider_cls is None:
            state.set_status(
                domain.id, 'error', message=f'Unknown provider {domain.provider}')
            return 'error'
        state.set_status(domain.id, 'updating')
        try:
            config = provider_cls.ConfigModel.model_validate(domain.provider_config)
            assigned = await provider_cls().update(
                domain.hostname, domain.record_type, ip, config)
        except Exception as exc:  # noqa: BLE001 - provider errors must be contained
            _log.exception(
                'Provider %s failed for %s', domain.provider, domain.hostname)
            state.set_status(domain.id, 'error', message=str(exc))
            return 'error'
        state.set_status(domain.id, 'synced', ip=assigned or ip, message='')
        return 'synced'
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest test/unit/test_sync_service.py -v`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add tether_ddns/services/sync.py test/unit/test_sync_service.py
git commit -m "feat: add SyncService.sync_domain"
```

---

### Task 2: `SyncService.refresh_public_ips` + `sync_ips` + `_sync_one`

**Files:**
- Modify: `tether_ddns/services/sync.py`
- Test: `test/unit/test_sync_service.py`

**Interfaces:**
- Produces:
  - `async refresh_public_ips(self) -> set[IPFamily]` — detect both families, update state, dispatch `ip_changed`, return the changed set.
  - `async sync_ips(self) -> None` — no-op when offline; else refresh IPs then `_sync_one` each domain.
  - `async _sync_one(self, domain: DomainConfig, changed: set[IPFamily]) -> None` — freshness/retry/enabled rules + dispatch on transition.

- [ ] **Step 1: Write the failing test**

```python
@pytest.mark.asyncio
async def test_sync_ips_offline_is_noop() -> None:
    """When offline, sync_ips does nothing and detects no IPs."""
    state = RuntimeState()
    state.online = False
    svc = _svc(AppConfig(), state)
    await svc.sync_ips()
    assert state.public_ipv4 is None


@pytest.mark.asyncio
async def test_refresh_public_ips_dispatches_on_change() -> None:
    """A newly detected IPv4 updates state, is returned, and dispatched."""
    state = RuntimeState()
    state.online = True
    svc = _svc(AppConfig(), state)
    with pytest.MonkeyPatch.context() as mp:
        async def _detect(source: str, family: str) -> str | None:
            """Return an IPv4 only."""
            return '1.2.3.4' if family == 'ipv4' else None
        mp.setattr('tether_ddns.services.sync.detect_public_ip', _detect)
        changed = await svc.refresh_public_ips()
    assert changed == {'ipv4'}
    assert state.public_ipv4 == '1.2.3.4'
    svc._dispatch.dispatch.assert_awaited()  # noqa: SLF001
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest test/unit/test_sync_service.py -v -k "sync_ips or refresh"`
Expected: FAIL with `AttributeError: 'SyncService' object has no attribute 'refresh_public_ips'`.

- [ ] **Step 3: Implement the three methods**

Append to `SyncService` in `tether_ddns/services/sync.py`:

```python
    async def refresh_public_ips(self) -> set[IPFamily]:
        """Detect both families, update state, dispatch ip_changed; return changed."""
        state = self._state
        source = self._ctx.config.settings.ip_source
        changed: set[IPFamily] = set()
        setters = {'ipv4': state.set_public_ipv4, 'ipv6': state.set_public_ipv6}
        current: dict[IPFamily, str | None] = {
            'ipv4': state.public_ipv4, 'ipv6': state.public_ipv6}
        for family in ('ipv4', 'ipv6'):
            detected = await detect_public_ip(source, family)
            if detected is None or detected == current[family]:
                continue
            old = current[family]
            setters[family](detected)
            changed.add(family)
            await self._dispatch.dispatch(
                'ip_changed',
                IpChangedEvent(old_ip=old, new_ip=detected, family=family))
        return changed

    async def _sync_one(
        self, domain: DomainConfig, changed: set[IPFamily],
    ) -> None:
        """Apply freshness/retry/enabled rules to one domain and dispatch."""
        state = self._state
        family = family_for(domain.record_type)
        ip = state.public_ipv4 if family == 'ipv4' else state.public_ipv6
        if not domain.enabled:
            if state.set_freshness(domain.id, ip) == 'pending':
                await self._dispatch.dispatch(
                    'domain_update_pending', DomainUpdatePendingEvent(
                        domain_id=domain.id, hostname=domain.hostname,
                        record_type=domain.record_type, family=family,
                        current_ip=ip))
            return
        if ip is None:
            return
        runtime = state.domains.get(domain.id)
        needs_retry = (self._ctx.config.settings.retry_on_failure
                       and runtime is not None and runtime.status == 'error')
        is_fresh = runtime is None or runtime.status == 'pending'
        if not (family in changed or is_fresh or needs_retry):
            return
        before = runtime.status if runtime is not None else None
        terminal = await self.sync_domain(domain, ip)
        if terminal == before:
            return
        if terminal == 'synced':
            await self._dispatch.dispatch(
                'domain_update_success', DomainUpdateSuccessEvent(
                    domain_id=domain.id, hostname=domain.hostname,
                    record_type=domain.record_type, family=family, ip=ip))
        elif terminal == 'error':
            await self._dispatch.dispatch(
                'domain_update_error', DomainUpdateErrorEvent(
                    domain_id=domain.id, hostname=domain.hostname,
                    record_type=domain.record_type, family=family, ip=ip,
                    message=state.domains[domain.id].message))

    async def sync_ips(self) -> None:
        """When online, refresh both IP families and sync every domain."""
        if not self._state.online:
            return
        changed = await self.refresh_public_ips()
        for domain in self._ctx.config.domains:
            await self._sync_one(domain, changed)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest test/unit/test_sync_service.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tether_ddns/services/sync.py test/unit/test_sync_service.py
git commit -m "feat: add SyncService refresh_public_ips/sync_ips/_sync_one"
```

---

### Task 3: `SyncService.sync_one_now`

**Files:**
- Modify: `tether_ddns/services/sync.py`
- Test: `test/unit/test_sync_service.py`

**Interfaces:**
- Produces: `async sync_one_now(self, domain: DomainConfig) -> None` — ensures a public IP for the domain's family (from runtime, else `detect_public_ip`, mutating runtime), raising `HTTPException(503, 'public IP unknown')` if none; then calls `self.sync_domain(domain, ip)`.

- [ ] **Step 1: Write the failing test**

```python
@pytest.mark.asyncio
async def test_sync_one_now_raises_when_no_ip() -> None:
    """sync_one_now raises 503 when no public IP can be determined."""
    from fastapi import HTTPException
    domain = DomainConfig(id='d1', hostname='h', provider='duckdns')
    state = RuntimeState()
    state.rebuild(AppConfig(domains=[domain]))
    svc = _svc(AppConfig(domains=[domain]), state)
    with pytest.MonkeyPatch.context() as mp:
        async def _none(source: str, family: str) -> str | None:
            """Return no IP."""
            return None
        mp.setattr('tether_ddns.services.sync.detect_public_ip', _none)
        with pytest.raises(HTTPException) as exc:
            await svc.sync_one_now(domain)
    assert exc.value.status_code == 503


@pytest.mark.asyncio
async def test_sync_one_now_uses_runtime_ip() -> None:
    """sync_one_now uses the runtime IP without detecting when present."""
    load_providers()
    domain = DomainConfig(
        id='d1', hostname='h.duckdns.org', provider='duckdns',
        provider_config={'token': 't'})
    state = RuntimeState()
    state.rebuild(AppConfig(domains=[domain]))
    state.public_ipv4 = '5.5.5.5'
    svc = _svc(AppConfig(domains=[domain]), state)
    with pytest.MonkeyPatch.context() as mp:
        from tether_ddns.providers.base import PROVIDER_REGISTRY
        mp.setattr(
            PROVIDER_REGISTRY['duckdns'], 'update', AsyncMock(return_value='5.5.5.5'))
        await svc.sync_one_now(domain)
    assert state.domains['d1'].status == 'synced'
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest test/unit/test_sync_service.py -v -k sync_one_now`
Expected: FAIL with `AttributeError: ... 'sync_one_now'`.

- [ ] **Step 3: Implement `sync_one_now`**

Add the `HTTPException` import (alphabetical, `from fastapi import HTTPException`) and append the method to `SyncService`:

```python
    async def sync_one_now(self, domain: DomainConfig) -> None:
        """Ensure a public IP for the domain's family, then sync it once."""
        state = self._state
        family = family_for(domain.record_type)
        ip = state.public_ipv4 if family == 'ipv4' else state.public_ipv6
        if not ip:
            ip = await detect_public_ip(self._ctx.config.settings.ip_source, family)
            if not ip:
                raise HTTPException(status_code=503, detail='public IP unknown')
            if family == 'ipv4':
                state.set_public_ipv4(ip)
            else:
                state.set_public_ipv6(ip)
        await self.sync_domain(domain, ip)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest test/unit/test_sync_service.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tether_ddns/services/sync.py test/unit/test_sync_service.py
git commit -m "feat: add SyncService.sync_one_now for manual sync"
```

---

### Task 4: Thin `Scheduler` delegating to `SyncService`

**Files:**
- Modify: `tether_ddns/scheduler.py`
- Modify: `tether_ddns/app.py`
- Test: migrate `test/unit/test_scheduler.py`

**Interfaces:**
- Consumes: `AppContext`, `SyncService`, `ReachabilityService`.
- Produces: `Scheduler(ctx: AppContext, sync: SyncService, reachability: ReachabilityService)` with unchanged `start`/`reschedule_sync`/`run_startup_check`/`shutdown`/`_publish_next_check` semantics; `check_reachability`/`sync_ips`/`check_once` delegate to `sync` and `reachability`. `Scheduler` no longer defines module-level `sync_domain` or `_family_for` (moved to `SyncService`/`family_for`).

- [ ] **Step 1: Migrate scheduler tests to the new shape**

In `test/unit/test_scheduler.py`, replace direct `scheduler.sync_domain(domain, '1.2.3.4', state)` calls (module-level) with `SyncService(...).sync_domain(domain, '1.2.3.4')` using the `_svc`-style helper (import from a shared fixture or inline). Replace `Scheduler()` construction with `Scheduler(ctx, sync, reachability)`. For transition-dispatch assertions, assert on the injected `DispatchService.dispatch` `AsyncMock` rather than patching module functions.

- [ ] **Step 2: Run migrated tests to verify they fail**

Run: `pytest test/unit/test_scheduler.py -v`
Expected: FAIL (old module-level `sync_domain`/`Scheduler()` gone).

- [ ] **Step 3: Reshape `scheduler.py`**

Rewrite the `Scheduler` class methods to delegate and update `__init__`:

```python
    def __init__(
        self, ctx: AppContext, sync: SyncService,
        reachability: ReachabilityService,
    ) -> None:
        """Create an unstarted scheduler bound to context, sync, reachability."""
        self._scheduler = AsyncIOScheduler()
        self._ctx = ctx
        self._sync = sync
        self._reachability = reachability
```

`start`/`reschedule_sync`/`run_startup_check` change their job args to take no `cfg`/`state` (bound via `self`) — register jobs against `self.check_reachability`, `self.sync_ips`, `self.check_once` with empty `args`. Read the interval from `self._ctx.config.settings.check_interval`.

```python
    async def check_reachability(self) -> None:
        """Run the DNS-quorum check; fire reachability_changed on transition."""
        state = self._ctx.runtime
        was_online = state.online
        reach = await self._reachability.check()
        if state.record_reachability(reach):
            await self._sync._dispatch.dispatch(  # pyright: ignore[reportPrivateUsage]  # noqa: SLF001
                'reachability_changed',
                ReachabilityChangedEvent(online=reach.online, was_online=was_online))

    async def sync_ips(self) -> None:
        """Delegate to SyncService, then republish the next fire time."""
        await self._sync.sync_ips()
        self._publish_next_check(self._ctx.runtime)

    async def check_once(self) -> None:
        """Run reachability then, if online, an IP sync (startup/refresh)."""
        await self.check_reachability()
        if self._ctx.runtime.online:
            await self.sync_ips()
```

Note: reachability dispatch reaches through `self._sync._dispatch`. If preferred, inject `dispatch` directly into `Scheduler` instead — but keep a single wiring choice. (Chosen: reach through sync to avoid a fourth constructor arg.) Delete the now-unused `sync_domain`, `_family_for`, and `dispatch_*` remnants and imports.

- [ ] **Step 4: Update `app.py` composition root**

In `tether_ddns/app.py` lifespan, build the sync service and reshape the scheduler:

```python
        from tether_ddns.services.sync import SyncService
        ctx = AppContext(config, runtime, resolved_store, manager)
        dispatch = DispatchService(ctx)
        sync = SyncService(ctx, dispatch)
        scheduler = Scheduler(ctx, sync, ReachabilityService())
```

Add `from tether_ddns.reachability import ReachabilityService` to imports (alphabetical). Update `scheduler.start(config, runtime)` and `scheduler.run_startup_check(config, runtime)` calls to `scheduler.start()` / `scheduler.run_startup_check()` (no args). Keep `app.state.sync = sync` alongside the others.

- [ ] **Step 5: Update `put_settings` and `/refresh` in `api.py`**

In `tether_ddns/api.py`, `put_settings` calls `app.state.scheduler.reschedule_sync(app.state.config, app.state.runtime)` — change to `app.state.scheduler.reschedule_sync()`. `refresh` calls `app.state.scheduler.check_once(app.state.config, app.state.runtime)` — change to `app.state.scheduler.check_once()`.

- [ ] **Step 6: Run scheduler tests**

Run: `pytest test/unit/test_scheduler.py test/unit/test_runtime.py -v`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add tether_ddns/scheduler.py tether_ddns/app.py tether_ddns/api.py test/unit/test_scheduler.py
git commit -m "refactor: thin Scheduler delegating to SyncService"
```

---

### Task 5: Route `/domains/{id}/sync` through `SyncService.sync_one_now`

**Files:**
- Modify: `tether_ddns/api.py`
- Test: migrate `test/unit/test_api.py`

**Interfaces:**
- Consumes: `app.state.sync: SyncService`, `find_or_404`.
- Produces: `/domains/{id}/sync` route body reduced to lookup + `sync_one_now` + `{'ok': True}`.

- [ ] **Step 1: Migrate the sync endpoint test**

In `test/unit/test_api.py`, the sync test patches `tether_ddns.scheduler.dispatch_domain_update_*`. Repoint: assert against `app.state.sync` behavior (patch `app.state.sync.sync_one_now` with an `AsyncMock`, or drive the real service with a patched provider). Verify a 404 for an unknown id and a 503 path when no IP is available.

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest test/unit/test_api.py -v -k sync`
Expected: FAIL (old patch targets / inline logic gone once Step 3 lands) — confirms test targets new API.

- [ ] **Step 3: Simplify the route**

Replace the `sync_now` route in `tether_ddns/api.py` with:

```python
    @router.post('/domains/{domain_id}/sync')
    async def sync_now(domain_id: str) -> dict[str, bool]:
        _, domain = find_or_404(
            app.state.config.domains, domain_id, 'domain not found')
        await app.state.sync.sync_one_now(domain)
        return {'ok': True}
```

Remove the now-unused local imports (`detect_public_ip`, `IPFamily`, `sync_domain`) from that function.

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest test/unit/test_api.py -v`
Expected: PASS.

- [ ] **Step 5: Run the full gate suite**

Run:
```bash
pytest test/ --cov=tether_ddns --cov-fail-under=90
flake8 test/ tether_ddns/ && ruff check .
mypy . && pyright
```
Expected: all pass; coverage ≥ 90%.

- [ ] **Step 6: Manual smoke**

Run: boot `uvicorn tether_ddns.app:create_app --factory --port 8099`; `curl -X POST localhost:8099/api/domains/<id>/sync` for a configured domain (expect `{"ok": true}` or `503` if no IP); `curl -X POST localhost:8099/api/refresh` (expect `{"ok": true}`); confirm the scheduler still fires (check `/api/state` `next_check_at`).

- [ ] **Step 7: Commit (Tier 2 complete)**

```bash
git add -A
git commit -m "refactor: route manual sync through SyncService.sync_one_now"
```

---

## Self-Review

- **Spec coverage:** SyncService with sync_domain/refresh_public_ips/sync_ips/_sync_one (Tasks 1–2) ✓; sync_one_now for the manual endpoint (Task 3) ✓; thin Scheduler delegating, no shims (Task 4) ✓; concrete DispatchService injected into SyncService (Task 1 constructor) ✓; DAG Scheduler→SyncService→DispatchService→AppContext ✓; composition root in app.py (Task 4) ✓.
- **Type consistency:** `SyncService(ctx, dispatch)` used identically in tests and app.py. `sync_domain(domain, ip)`, `sync_ips()`, `sync_one_now(domain)` signatures consistent across tasks. `Scheduler(ctx, sync, reachability)` matches app.py wiring.
- **Boundary preserved:** live `sync_ips`/`_sync_one` build transition events inline; `from_context` remains only in `DispatchService.run_hook_now` (Tier 1).
- **Behavior parity:** freshness/retry/enabled rules in `_sync_one` copied verbatim from the original `Scheduler.sync_ips`; provider exception isolation preserved in `sync_domain`.
