# Domain-Update Hook Events Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three per-domain, status-transition hook events — `domain_update_pending`, `domain_update_success`, `domain_update_error` — with typed payloads and per-event `on_*` methods, fired by the scheduler on real transitions and by "Run hook now" from current state.

**Architecture:** Three distinct payload classes and three `EVENT_SPECS` entries extend the existing hook registry (the 3-point pattern). `RuntimeState.set_status`/`set_freshness` return the resulting `Status` (or `None` when unchanged) so the scheduler can detect transitions; runtime imports nothing from hooks. `sync_domain` returns its terminal status but never dispatches — dispatch lives only in `sync_ips`, keeping the manual `/domains/{id}/sync` path silent. `run_hook_now` fires, per domain, only the event matching that domain's current runtime status.

**Tech Stack:** Python 3, Pydantic v2, pytest, pytest-asyncio.

## Global Constraints

- **This plan depends on the domain-status-consistency fix being implemented first.** It assumes `runtime.py` already has `freshness()`, `set_freshness()` (currently returning `None`), a history-preserving `rebuild()`, and `Status = Literal['synced', 'pending', 'error', 'updating']`.
- Event key strings are exactly `'domain_update_pending'`, `'domain_update_success'`, `'domain_update_error'`.
- `/api/hooks` response shape is unchanged and auto-derives events from `EVENT_SPECS`.
- Firing rules:
  - Scheduler fires each event only on a real status transition.
  - Disabled domains fire only `domain_update_pending`, only on transition to `pending`. Never success/error.
  - Manual `POST /domains/{id}/sync` fires no domain-update events.
  - "Run hook now" fires, per domain, the single event matching the domain's current runtime status (`pending`/`synced`/`error`); `updating` is skipped; unmatched configured events are reported in `skipped`.
- `sync_domain` must NOT dispatch events itself; only `sync_ips` dispatches.
- Success payload has no `message` field. Error payload carries `message` (re-emitting `runtime.message` on Run-now).
- Python style: `from __future__ import annotations`, single-quoted strings, existing noqa conventions.
- Run `pytest test/unit -q` before each commit.

---

### Task 1: Payloads, EVENT_SPECS, and Hook methods

**Files:**
- Modify: `tether_ddns/hooks/base.py`
- Test: `test/unit/test_hook_registry.py`

**Interfaces:**
- Consumes: existing `HookEventBase`, `EventSpec`, `EVENT_SPECS`, `Hook`.
- Produces:
  - `DomainUpdatePendingEvent(domain_id: str, hostname: str, record_type: str, family: Literal['ipv4','ipv6'], current_ip: str | None = None)`
  - `DomainUpdateSuccessEvent(domain_id: str, hostname: str, record_type: str, family: Literal['ipv4','ipv6'], ip: str)`
  - `DomainUpdateErrorEvent(domain_id: str, hostname: str, record_type: str, family: Literal['ipv4','ipv6'], ip: str | None = None, message: str)`
  - `EVENT_SPECS` entries `'domain_update_pending'|'domain_update_success'|'domain_update_error'`.
  - `Hook.on_domain_update_pending`, `on_domain_update_success`, `on_domain_update_error` no-op defaults.

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/test_hook_registry.py`:
```python
def test_domain_update_events_registered() -> None:
    """The three domain-update events are in EVENT_SPECS with labels."""
    assert base.EVENT_SPECS['domain_update_pending'].label == 'Domain Update Pending'
    assert base.EVENT_SPECS['domain_update_success'].label == 'Domain Update Success'
    assert base.EVENT_SPECS['domain_update_error'].label == 'Domain Update Error'


def test_supported_events_infers_domain_update() -> None:
    """A hook overriding one domain-update method supports only that event."""
    class _OnlyErr(base.Hook):
        key = '_onlyerr'

        async def on_domain_update_error(
                self, event: base.DomainUpdateErrorEvent,
                config: BaseModel) -> None:
            return None

    assert _OnlyErr.supported_events() == ('domain_update_error',)


def test_domain_update_payloads_construct() -> None:
    """The three payloads carry their documented fields."""
    p = base.DomainUpdatePendingEvent(
        domain_id='a', hostname='h', record_type='A', family='ipv4',
        current_ip='1.2.3.4')
    s = base.DomainUpdateSuccessEvent(
        domain_id='a', hostname='h', record_type='A', family='ipv4',
        ip='1.2.3.4')
    e = base.DomainUpdateErrorEvent(
        domain_id='a', hostname='h', record_type='A', family='ipv4',
        ip='1.2.3.4', message='boom')
    assert p.current_ip == '1.2.3.4'
    assert s.ip == '1.2.3.4'
    assert e.message == 'boom'
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest test/unit/test_hook_registry.py -k domain_update -q`
Expected: FAIL (`AttributeError`/`KeyError` — the new events and payloads don't exist).

- [ ] **Step 3: Add payloads to `tether_ddns/hooks/base.py`**

After the existing `ReachabilityChangedEvent` class, add:
```python
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
```

- [ ] **Step 4: Add the EVENT_SPECS entries**

Extend the `EVENT_SPECS` dict so it reads:
```python
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
```

- [ ] **Step 5: Add the no-op Hook methods**

After the existing `on_reachability_changed` method in `class Hook`, add:
```python
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
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pytest test/unit/test_hook_registry.py -q`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add tether_ddns/hooks/base.py test/unit/test_hook_registry.py
git commit -m "feat(hooks): add domain-update event payloads and methods"
```

---

### Task 2: Runtime returns transitions

**Files:**
- Modify: `tether_ddns/runtime.py`
- Test: `test/unit/test_runtime.py`

**Interfaces:**
- Consumes: `set_status`, `set_freshness`, `freshness` (from the consistency fix).
- Produces:
  - `set_status(...) -> Status | None` — returns the new status when it changed from the prior status (including `updating`), else `None`.
  - `set_freshness(...) -> Status | None` — returns `pending`/`synced` on change, else `None`.

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/test_runtime.py`:
```python
def test_set_status_returns_transition() -> None:
    """set_status returns the new status on change and None otherwise."""
    cfg = AppConfig(domains=[
        DomainConfig(id='a', hostname='a.example.com', provider='duckdns')])
    state = RuntimeState()
    state.rebuild(cfg)  # starts 'pending'
    assert state.set_status('a', 'synced', ip='1.2.3.4') == 'synced'
    assert state.set_status('a', 'synced', ip='1.2.3.4') is None
    assert state.set_status('missing', 'synced') is None


def test_set_freshness_returns_transition() -> None:
    """set_freshness returns the new status on change and None otherwise."""
    cfg = AppConfig(domains=[
        DomainConfig(id='a', hostname='a.example.com', provider='duckdns')])
    state = RuntimeState()
    state.rebuild(cfg)
    state.set_status('a', 'synced', ip='1.2.3.4')
    assert state.set_freshness('a', '9.9.9.9') == 'pending'
    assert state.set_freshness('a', '9.9.9.9') is None
    assert state.set_freshness('a', '1.2.3.4') == 'synced'
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest test/unit/test_runtime.py -k returns_transition -q`
Expected: FAIL (`set_status`/`set_freshness` return `None` unconditionally).

- [ ] **Step 3: Update `set_status` in `tether_ddns/runtime.py`**

Replace the current method:
```python
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
```
with:
```python
    def set_status(
        self, domain_id: str, status: Status, *, ip: str | None = None, message: str = '',
    ) -> Status | None:
        """Update a domain's status; return the new status if it changed."""
        current = self.domains.get(domain_id)
        if current is None:
            return None
        changed = current.status != status
        current.status = status
        if ip is not None:
            current.ip = ip
        current.message = message
        current.updated = time.time()
        self._emit()
        return status if changed else None
```

- [ ] **Step 4: Update `set_freshness` to return the transition**

Replace the `set_freshness` method (added by the consistency fix):
```python
    def set_freshness(self, domain_id: str, current_ip: str | None) -> None:
        """Recompute a domain's status from freshness, preserving ip/updated.

        Only toggles between 'synced' and 'pending'; never clobbers 'error'
        or 'updating'. Emits only when the status actually changes.
        """
        current = self.domains.get(domain_id)
        if current is None or current.status in ('error', 'updating'):
            return
        new_status = freshness(current.ip, current_ip)
        if new_status == current.status:
            return
        current.status = new_status
        self._emit()
```
with:
```python
    def set_freshness(self, domain_id: str, current_ip: str | None) -> Status | None:
        """Recompute a domain's status from freshness, preserving ip/updated.

        Only toggles between 'synced' and 'pending'; never clobbers 'error'
        or 'updating'. Returns the new status when it changes, else None.
        """
        current = self.domains.get(domain_id)
        if current is None or current.status in ('error', 'updating'):
            return None
        new_status = freshness(current.ip, current_ip)
        if new_status == current.status:
            return None
        current.status = new_status
        self._emit()
        return new_status
```

- [ ] **Step 5: Run the full unit suite to verify it passes**

Run: `pytest test/unit -q`
Expected: PASS (existing callers ignore the new return value).

- [ ] **Step 6: Commit**

```bash
git add tether_ddns/runtime.py test/unit/test_runtime.py
git commit -m "feat(runtime): return status transitions from set_status/set_freshness"
```

---

### Task 3: Scheduler dispatches domain-update events

**Files:**
- Modify: `tether_ddns/scheduler.py`
- Test: `test/unit/test_scheduler.py`

**Interfaces:**
- Consumes: transition-returning `set_status`/`set_freshness` (Task 2); the new payloads and `_dispatch` (Task 1).
- Produces:
  - `sync_domain(...) -> Status | None` — returns its terminal status.
  - `dispatch_domain_update_pending/success/error(event, cfg)` helpers.
  - `sync_ips` dispatches events on transitions.

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/test_scheduler.py` (add `DomainUpdatePendingEvent`, `DomainUpdateSuccessEvent`, `DomainUpdateErrorEvent` to the existing `from tether_ddns.hooks.base import (...)` line):
```python
@pytest.mark.asyncio
async def test_sync_ips_fires_success_on_transition() -> None:
    """An enabled domain going pending->synced fires domain_update_success."""
    load_providers()
    load_hooks()
    domain = DomainConfig(
        id='a', hostname='myhost', provider='duckdns',
        provider_config={'token': 'x', 'domain': 'myhost'})
    cfg = AppConfig(domains=[domain], hooks=[HookConfig(
        id='h', hook='log', enabled=True,
        events=['domain_update_success'], config={})])
    state = RuntimeState()
    state.rebuild(cfg)
    state.online = True
    sched = scheduler.Scheduler()
    seen: list[object] = []

    async def _capture(event: object, _cfg: object) -> None:
        seen.append(event)

    with patch(
        'tether_ddns.scheduler.ReachabilityService.check',
        new=AsyncMock(return_value=_online(True)),
    ), patch(
        'tether_ddns.scheduler.detect_public_ip',
        new=AsyncMock(return_value='9.9.9.9'),
    ), patch(
        'tether_ddns.providers.ddns_providers.duckdns.DuckDNSProvider.update',
        new=AsyncMock(return_value=_ok_result('9.9.9.9')),
    ), patch(
        'tether_ddns.scheduler.dispatch_domain_update_success', new=_capture,
    ):
        await sched.check_once(cfg, state)
    assert len(seen) == 1
    from tether_ddns.hooks.base import DomainUpdateSuccessEvent
    assert isinstance(seen[0], DomainUpdateSuccessEvent)
    assert seen[0].ip == '9.9.9.9'


@pytest.mark.asyncio
async def test_sync_ips_fires_error_on_transition() -> None:
    """An enabled domain going pending->error fires domain_update_error."""
    load_providers()
    domain = DomainConfig(
        id='a', hostname='myhost', provider='duckdns',
        provider_config={'token': 'x', 'domain': 'myhost'})
    cfg = AppConfig(domains=[domain])
    state = RuntimeState()
    state.rebuild(cfg)
    state.online = True
    sched = scheduler.Scheduler()
    seen: list[object] = []

    async def _capture(event: object, _cfg: object) -> None:
        seen.append(event)

    with patch(
        'tether_ddns.scheduler.ReachabilityService.check',
        new=AsyncMock(return_value=_online(True)),
    ), patch(
        'tether_ddns.scheduler.detect_public_ip',
        new=AsyncMock(return_value='9.9.9.9'),
    ), patch(
        'tether_ddns.providers.ddns_providers.duckdns.DuckDNSProvider.update',
        new=AsyncMock(side_effect=RuntimeError('boom')),
    ), patch(
        'tether_ddns.scheduler.dispatch_domain_update_error', new=_capture,
    ):
        await sched.check_once(cfg, state)
    assert len(seen) == 1
    from tether_ddns.hooks.base import DomainUpdateErrorEvent
    assert isinstance(seen[0], DomainUpdateErrorEvent)
    assert 'boom' in seen[0].message


@pytest.mark.asyncio
async def test_sync_ips_fires_pending_for_disabled_transition() -> None:
    """A disabled domain going synced->pending fires domain_update_pending."""
    load_providers()
    domain = DomainConfig(
        id='a', hostname='myhost', provider='duckdns',
        provider_config={'token': 'x', 'domain': 'myhost'}, enabled=False)
    cfg = AppConfig(domains=[domain])
    state = RuntimeState()
    state.rebuild(cfg)
    state.online = True
    state.set_status('a', 'synced', ip='1.1.1.1')
    sched = scheduler.Scheduler()
    seen: list[object] = []

    async def _capture(event: object, _cfg: object) -> None:
        seen.append(event)

    with patch(
        'tether_ddns.scheduler.ReachabilityService.check',
        new=AsyncMock(return_value=_online(True)),
    ), patch(
        'tether_ddns.scheduler.detect_public_ip',
        new=AsyncMock(return_value='2.2.2.2'),
    ), patch(
        'tether_ddns.scheduler.dispatch_domain_update_pending', new=_capture,
    ):
        await sched.check_once(cfg, state)
    assert len(seen) == 1
    from tether_ddns.hooks.base import DomainUpdatePendingEvent
    assert isinstance(seen[0], DomainUpdatePendingEvent)
    assert seen[0].current_ip == '2.2.2.2'


@pytest.mark.asyncio
async def test_sync_ips_no_event_without_transition() -> None:
    """A re-confirmed synced domain fires no domain-update event."""
    load_providers()
    domain = DomainConfig(
        id='a', hostname='myhost', provider='duckdns',
        provider_config={'token': 'x', 'domain': 'myhost'})
    cfg = AppConfig(domains=[domain])
    state = RuntimeState()
    state.rebuild(cfg)
    state.online = True
    state.set_public_ipv4('9.9.9.9')
    state.set_status('a', 'synced', ip='9.9.9.9')
    sched = scheduler.Scheduler()
    seen: list[object] = []

    async def _capture(event: object, _cfg: object) -> None:
        seen.append(event)

    with patch(
        'tether_ddns.scheduler.ReachabilityService.check',
        new=AsyncMock(return_value=_online(True)),
    ), patch(
        'tether_ddns.scheduler.detect_public_ip',
        new=AsyncMock(return_value='9.9.9.9'),
    ), patch(
        'tether_ddns.providers.ddns_providers.duckdns.DuckDNSProvider.update',
        new=AsyncMock(return_value=_ok_result('9.9.9.9')),
    ), patch(
        'tether_ddns.scheduler.dispatch_domain_update_success', new=_capture,
    ):
        await sched.check_once(cfg, state)
    assert seen == []
```

Add these helpers near the top of `test/unit/test_scheduler.py` (after `_online`):
```python
def _ok_result(ip: str) -> object:
    from tether_ddns.providers.base import UpdateResult
    return UpdateResult(success=True, ip=ip, message='ok')
```

- [ ] **Step 2: Verify the helper import path**

Run: `python -c "from tether_ddns.providers.base import UpdateResult; print(UpdateResult(success=True, ip='1.1.1.1', message='ok'))"`
Expected: prints an `UpdateResult`. If the class name or fields differ, read `tether_ddns/providers/base.py` and adjust `_ok_result` to match the real result type returned by `DuckDNSProvider.update` before proceeding.

- [ ] **Step 3: Run tests to verify they fail**

Run: `pytest test/unit/test_scheduler.py -k "fires_success or fires_error or fires_pending or without_transition" -q`
Expected: FAIL (`dispatch_domain_update_*` don't exist; `sync_ips` doesn't dispatch).

- [ ] **Step 4: Add the dispatch helpers and `sync_domain` return in `tether_ddns/scheduler.py`**

Update the import from `tether_ddns.hooks.base`:
```python
from tether_ddns.hooks.base import (
    HOOK_REGISTRY, IpChangedEvent, ReachabilityChangedEvent)
```
to:
```python
from tether_ddns.hooks.base import (
    HOOK_REGISTRY, DomainUpdateErrorEvent, DomainUpdatePendingEvent,
    DomainUpdateSuccessEvent, IpChangedEvent, ReachabilityChangedEvent)
```

Add `Status` to the runtime import:
```python
from tether_ddns.runtime import RuntimeState
```
becomes:
```python
from tether_ddns.runtime import RuntimeState, Status
```

Change `sync_domain` to return its terminal status. Replace:
```python
async def sync_domain(domain: DomainConfig, ip: str, state: RuntimeState) -> None:
    """Update a single domain, isolating provider exceptions."""
    provider_cls = PROVIDER_REGISTRY.get(domain.provider)
    if provider_cls is None:
        state.set_status(domain.id, 'error', message=f'Unknown provider {domain.provider}')
        return
    state.set_status(domain.id, 'updating')
    try:
        config = provider_cls.ConfigModel.model_validate(domain.provider_config)
        result = await provider_cls().update(domain.hostname, domain.record_type, ip, config)
    except Exception as exc:  # noqa: BLE001 - provider errors must be contained
        _log.exception('Provider %s failed for %s', domain.provider, domain.hostname)
        state.set_status(domain.id, 'error', message=str(exc))
        return
    if result.success:
        state.set_status(domain.id, 'synced', ip=result.ip or ip, message=result.message)
    else:
        state.set_status(domain.id, 'error', message=result.message)
```
with:
```python
async def sync_domain(domain: DomainConfig, ip: str, state: RuntimeState) -> Status:
    """Update a single domain, isolating provider exceptions.

    Returns the terminal status ('synced' or 'error'). Does not dispatch
    hook events; the scheduler decides whether a transition occurred.
    """
    provider_cls = PROVIDER_REGISTRY.get(domain.provider)
    if provider_cls is None:
        state.set_status(domain.id, 'error', message=f'Unknown provider {domain.provider}')
        return 'error'
    state.set_status(domain.id, 'updating')
    try:
        config = provider_cls.ConfigModel.model_validate(domain.provider_config)
        result = await provider_cls().update(domain.hostname, domain.record_type, ip, config)
    except Exception as exc:  # noqa: BLE001 - provider errors must be contained
        _log.exception('Provider %s failed for %s', domain.provider, domain.hostname)
        state.set_status(domain.id, 'error', message=str(exc))
        return 'error'
    if result.success:
        state.set_status(domain.id, 'synced', ip=result.ip or ip, message=result.message)
        return 'synced'
    state.set_status(domain.id, 'error', message=result.message)
    return 'error'
```

Add the three dispatch helpers after `dispatch_reachability_changed`:
```python
async def dispatch_domain_update_pending(
        event: DomainUpdatePendingEvent, cfg: AppConfig) -> None:
    """Dispatch a domain_update_pending event to matching hooks."""
    await _dispatch('domain_update_pending', event, cfg)


async def dispatch_domain_update_success(
        event: DomainUpdateSuccessEvent, cfg: AppConfig) -> None:
    """Dispatch a domain_update_success event to matching hooks."""
    await _dispatch('domain_update_success', event, cfg)


async def dispatch_domain_update_error(
        event: DomainUpdateErrorEvent, cfg: AppConfig) -> None:
    """Dispatch a domain_update_error event to matching hooks."""
    await _dispatch('domain_update_error', event, cfg)
```

- [ ] **Step 5: Wire dispatch into `sync_ips`**

Replace the domain loop (as updated by the consistency fix):
```python
        for domain in cfg.domains:
            family = _family_for(domain.record_type)
            ip = by_family[family]
            if not domain.enabled:
                state.set_freshness(domain.id, ip)
                continue
            if ip is None:
                continue
            runtime = state.domains.get(domain.id)
            needs_retry = (cfg.settings.retry_on_failure and runtime is not None
                           and runtime.status == 'error')
            is_fresh = runtime is None or runtime.status == 'pending'
            if family in changed or is_fresh or needs_retry:
                await sync_domain(domain, ip, state)
```
with:
```python
        for domain in cfg.domains:
            family = _family_for(domain.record_type)
            ip = by_family[family]
            if not domain.enabled:
                if state.set_freshness(domain.id, ip) == 'pending':
                    await dispatch_domain_update_pending(
                        DomainUpdatePendingEvent(
                            domain_id=domain.id, hostname=domain.hostname,
                            record_type=domain.record_type, family=family,
                            current_ip=ip), cfg)
                continue
            if ip is None:
                continue
            runtime = state.domains.get(domain.id)
            needs_retry = (cfg.settings.retry_on_failure and runtime is not None
                           and runtime.status == 'error')
            is_fresh = runtime is None or runtime.status == 'pending'
            if not (family in changed or is_fresh or needs_retry):
                continue
            before = runtime.status if runtime is not None else None
            terminal = await sync_domain(domain, ip, state)
            if terminal == before:
                continue
            if terminal == 'synced':
                await dispatch_domain_update_success(
                    DomainUpdateSuccessEvent(
                        domain_id=domain.id, hostname=domain.hostname,
                        record_type=domain.record_type, family=family,
                        ip=ip), cfg)
            elif terminal == 'error':
                message = state.domains[domain.id].message
                await dispatch_domain_update_error(
                    DomainUpdateErrorEvent(
                        domain_id=domain.id, hostname=domain.hostname,
                        record_type=domain.record_type, family=family,
                        ip=ip, message=message), cfg)
```

Note: `before` is the status captured before `sync_domain` ran (`updating` is set inside `sync_domain`, so `before` reflects the pre-sync `pending`/`synced`/`error`). Comparing `terminal` to `before` suppresses re-confirmation with no net change.

- [ ] **Step 6: Run the full unit suite to verify it passes**

Run: `pytest test/unit -q`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add tether_ddns/scheduler.py test/unit/test_scheduler.py
git commit -m "feat(scheduler): fire domain-update events on status transitions"
```

---

### Task 4: `run_hook_now` fires per current status

**Files:**
- Modify: `tether_ddns/scheduler.py`
- Test: `test/unit/test_scheduler.py`

**Interfaces:**
- Consumes: the new payloads and dispatch mechanics from Tasks 1 & 3.
- Produces: `run_hook_now` builds `domain_update_*` jobs from each domain's current runtime status.

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/test_scheduler.py`:
```python
@pytest.mark.asyncio
async def test_run_hook_now_domain_update_error_matches_state() -> None:
    """Run-now for domain_update_error fires only for error domains, with message."""
    from tether_ddns.hooks.base import HOOK_REGISTRY, Hook, register_hook

    seen: list[tuple[str, str]] = []

    @register_hook
    class _SpyErr(Hook):
        key = '_spyerr'
        display_name = 'SpyErr'

        async def on_domain_update_error(
                self, event: object, config: object) -> None:
            seen.append((event.domain_id, event.message))  # type: ignore[attr-defined]

    try:
        cfg = AppConfig(
            domains=[
                DomainConfig(id='a', hostname='a.example.com', provider='duckdns'),
                DomainConfig(id='b', hostname='b.example.com', provider='duckdns'),
            ],
            hooks=[HookConfig(
                id='h', hook='_spyerr', enabled=True,
                events=['domain_update_error'], config={})])
        state = RuntimeState()
        state.rebuild(cfg)
        state.set_status('a', 'error', ip='1.1.1.1', message='provider down')
        state.set_status('b', 'synced', ip='2.2.2.2')
        result = await scheduler.run_hook_now(cfg.hooks[0], cfg, state)
        assert result['ran'] == 1
        assert seen == [('a', 'provider down')]
    finally:
        HOOK_REGISTRY.pop('_spyerr', None)


@pytest.mark.asyncio
async def test_run_hook_now_domain_update_success_matches_state() -> None:
    """Run-now for domain_update_success fires only for synced domains with ip."""
    from tether_ddns.hooks.base import HOOK_REGISTRY, Hook, register_hook

    seen: list[str] = []

    @register_hook
    class _SpyOk(Hook):
        key = '_spyok'
        display_name = 'SpyOk'

        async def on_domain_update_success(
                self, event: object, config: object) -> None:
            seen.append(event.ip)  # type: ignore[attr-defined]

    try:
        cfg = AppConfig(
            domains=[
                DomainConfig(id='a', hostname='a.example.com', provider='duckdns'),
                DomainConfig(id='b', hostname='b.example.com', provider='duckdns'),
            ],
            hooks=[HookConfig(
                id='h', hook='_spyok', enabled=True,
                events=['domain_update_success'], config={})])
        state = RuntimeState()
        state.rebuild(cfg)
        state.set_status('a', 'synced', ip='9.9.9.9')
        # 'b' stays pending -> should not fire success
        result = await scheduler.run_hook_now(cfg.hooks[0], cfg, state)
        assert result['ran'] == 1
        assert seen == ['9.9.9.9']
    finally:
        HOOK_REGISTRY.pop('_spyok', None)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest test/unit/test_scheduler.py -k run_hook_now_domain_update -q`
Expected: FAIL (`run_hook_now` doesn't handle the domain-update keys; `ran` is 0).

- [ ] **Step 3: Extend the `run_hook_now` job-building loop**

In `run_hook_now`, after the `elif event_key == 'ip_changed':` block and before the `ran = 0` line, add a branch that maps each domain's current status to its event:
```python
        elif event_key in (
                'domain_update_pending', 'domain_update_success',
                'domain_update_error'):
            status_for_key = {
                'domain_update_pending': 'pending',
                'domain_update_success': 'synced',
                'domain_update_error': 'error',
            }[event_key]
            matched = False
            for domain in cfg.domains:
                runtime = state.domains.get(domain.id)
                if runtime is None or runtime.status != status_for_key:
                    continue
                family = _family_for(domain.record_type)
                if event_key == 'domain_update_pending':
                    current_ip = (state.public_ipv4 if family == 'ipv4'
                                  else state.public_ipv6)
                    jobs.append((event_key, DomainUpdatePendingEvent(
                        domain_id=domain.id, hostname=domain.hostname,
                        record_type=domain.record_type, family=family,
                        current_ip=current_ip)))
                    matched = True
                elif event_key == 'domain_update_success':
                    if runtime.ip is None:
                        continue
                    jobs.append((event_key, DomainUpdateSuccessEvent(
                        domain_id=domain.id, hostname=domain.hostname,
                        record_type=domain.record_type, family=family,
                        ip=runtime.ip)))
                    matched = True
                else:  # domain_update_error
                    jobs.append((event_key, DomainUpdateErrorEvent(
                        domain_id=domain.id, hostname=domain.hostname,
                        record_type=domain.record_type, family=family,
                        ip=runtime.ip, message=runtime.message)))
                    matched = True
            if not matched:
                skipped.append(event_key)
```

- [ ] **Step 4: Run the full unit suite to verify it passes**

Run: `pytest test/unit -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tether_ddns/scheduler.py test/unit/test_scheduler.py
git commit -m "feat(scheduler): run-now fires domain-update events per current status"
```

---

### Task 5: README, static checks, and cleanup

**Files:**
- Modify: `README.md`
- Verify: `tether_ddns/`, `test/`.

- [ ] **Step 1: Mention the new events in `README.md`**

In the "Add a hook" section, immediately after the code block showing the
`on_ip_changed`/`on_reachability_changed` example, add:
```markdown
Hooks may also override `on_domain_update_pending`, `on_domain_update_success`,
and `on_domain_update_error` to react to a specific domain's update outcome.
```

- [ ] **Step 2: Run the lint/type gate**

Run: `pytest test/test_ruff.py test/test_mypy.py test/test_pyright.py test/test_flake8.py -q`
Expected: PASS. Fix any findings inline (e.g. unused imports, line length, a needed `# type: ignore` for the spy-hook `event` attribute access in tests) and re-run.

- [ ] **Step 3: Run the full suite once more**

Run: `pytest test/unit -q`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "docs: document domain-update hook events"
```

---

## Self-Review

- **Spec coverage:** three payloads + EVENT_SPECS + Hook methods (Task 1) ✓; runtime returns transitions (Task 2) ✓; scheduler `sync_domain` return + dispatch helpers + `sync_ips` transition firing, disabled→pending, no-transition suppression, manual `/sync` silent because it ignores the return (Tasks 2-3) ✓; run-now per current status with `skipped` reporting (Task 4) ✓; docs (Task 5) ✓.
- **Placeholder scan:** every code step shows complete code; Step 2 of Task 3 verifies the `UpdateResult` shape before use.
- **Type consistency:** `DomainUpdatePendingEvent(current_ip)`, `DomainUpdateSuccessEvent(ip)`, `DomainUpdateErrorEvent(ip, message)`, `sync_domain -> Status`, `set_status/set_freshness -> Status | None`, `dispatch_domain_update_pending/success/error` used consistently across tasks.
- **Cross-spec dependency:** Global Constraints explicitly require the consistency fix first; Task 2/3 edits reference the exact post-fix method bodies.
