# Hook-Declared Supported Events — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each hook declares which event types it supports; the API surfaces only those (with labels), validates configs against them, and the scheduler never invokes a hook for an unsupported event.

**Architecture:** Add `supported_events` to `Hook` and an `EVENT_LABELS` map; `/hooks` returns per-hook `{key,label}` events; `create_hook`/`update_hook` validate; `dispatch_hooks` guards; the frontend renders labels and toggles by key.

**Tech Stack:** Python 3.12, FastAPI, pydantic v2, React + TypeScript + Vitest.

## Global Constraints

- Docstrings on all public Python functions (flake8 pep257); single quotes; alphabetical imports.
- Must pass: `flake8`, `ruff check`, `mypy .`, `pyright tether_ddns`, `pytest --cov-fail-under=90`; frontend `npm run lint`, `npm run typecheck`, `npm test`.
- No new dependencies. Existing stored hook configs are left untouched (the scheduler guard makes pruning unnecessary).

---

### Task 1: `supported_events` + `EVENT_LABELS` on the hook base

**Files:**
- Modify: `tether_ddns/hooks/base.py`
- Modify: `tether_ddns/hooks/registered_hooks/log_hook.py`
- Modify: `tether_ddns/hooks/registered_hooks/router_firewall.py`
- Test: `test/unit/test_hook_registry.py` (create if absent)

**Interfaces:**
- Produces: `Hook.supported_events: tuple[str, ...]` (defaults to `SUPPORTED_EVENTS`);
  `EVENT_LABELS: dict[str, str]` in `tether_ddns/hooks/base.py`.
- `RouterFirewallHook.supported_events == ('ip_changed',)`; `LogHook.supported_events == SUPPORTED_EVENTS`.

- [ ] **Step 1: Write the failing test**

Create or append to `test/unit/test_hook_registry.py`:

```python
"""Tests for hook supported-event declarations."""
from tether_ddns.hooks.base import EVENT_LABELS, SUPPORTED_EVENTS, load_hooks
from tether_ddns.hooks.registered_hooks.log_hook import LogHook
from tether_ddns.hooks.registered_hooks.router_firewall import RouterFirewallHook


def test_router_firewall_supports_only_ip_changed() -> None:
    """The router firewall hook only handles ip_changed events."""
    assert RouterFirewallHook.supported_events == ('ip_changed',)


def test_log_hook_supports_all_events() -> None:
    """The log hook handles every supported event type."""
    assert set(LogHook.supported_events) == set(SUPPORTED_EVENTS)


def test_event_labels_cover_supported_events() -> None:
    """Every supported event has a human label."""
    for event in SUPPORTED_EVENTS:
        assert event in EVENT_LABELS
    assert EVENT_LABELS['ip_changed'] == 'IP Changed'
    assert EVENT_LABELS['reachability_changed'] == 'Reachability Changed'
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest test/unit/test_hook_registry.py -v -o addopts=""`
Expected: FAIL with `ImportError`/`AttributeError` for `EVENT_LABELS` / `supported_events`.

- [ ] **Step 3: Implement base changes**

In `tether_ddns/hooks/base.py`, after `SUPPORTED_EVENTS`:

```python
SUPPORTED_EVENTS: tuple[str, ...] = ('reachability_changed', 'ip_changed')
EVENT_LABELS: dict[str, str] = {
    'ip_changed': 'IP Changed',
    'reachability_changed': 'Reachability Changed',
}
```

Add the class attribute to `Hook` (near `key`/`display_name`):

```python
class Hook(ABC):
    """Base class for hook plugins."""

    key: str = ''
    display_name: str = ''
    supported_events: tuple[str, ...] = SUPPORTED_EVENTS
    ConfigModel: type[BaseModel] = EmptyConfig
```

In `tether_ddns/hooks/registered_hooks/log_hook.py`, import `SUPPORTED_EVENTS` and set it:

```python
from tether_ddns.hooks.base import (
    EmptyConfig,
    Hook,
    HookEvent,
    SUPPORTED_EVENTS,
    register_hook,
)
```
and inside the class:
```python
    key = 'log'
    display_name = 'Log Event'
    supported_events = SUPPORTED_EVENTS
    ConfigModel = EmptyConfig
```

In `tether_ddns/hooks/registered_hooks/router_firewall.py`, in `RouterFirewallHook`:

```python
    key = 'router_firewall'
    display_name = 'Router Firewall (ZTE)'
    supported_events = ('ip_changed',)
    ConfigModel = RouterFirewallConfig
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest test/unit/test_hook_registry.py -v -o addopts=""`
Expected: all PASS.

- [ ] **Step 5: Lint and type-check**

Run:
```bash
ruff check tether_ddns/hooks test/unit/test_hook_registry.py
flake8 tether_ddns/hooks test/unit/test_hook_registry.py
mypy .
pyright tether_ddns
```
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add tether_ddns/hooks test/unit/test_hook_registry.py
git commit -m "feat(hooks): declare per-hook supported events and event labels"
```

---

### Task 2: `/hooks` returns per-hook `{key,label}` events + config validation

**Files:**
- Modify: `tether_ddns/api.py`
- Test: `test/unit/test_api.py` (append; create if absent)

**Interfaces:**
- Consumes: `Hook.supported_events`, `EVENT_LABELS` from Task 1.
- Produces: `GET /hooks` items shaped `{'key', 'display_name', 'events': [{'key','label'}...], 'schema'}`; `create_hook`/`update_hook` reject unsupported events with 400 via a shared `_validate_hook_events(hook, events)` helper.

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/test_api.py`, reusing the existing `_client(tmp_path)` helper already defined at the top of that file (it builds a `TestClient(create_app(store))` with startup checks disabled):

```python
def test_get_hooks_returns_per_hook_labeled_events(tmp_path: Path) -> None:
    """The /hooks endpoint returns each hook's own events as key/label objects."""
    with _client(tmp_path) as client:
        resp: Any = client.get('/api/hooks')
    assert resp.status_code == 200
    hooks = {h['key']: h for h in resp.json()}
    rf = hooks['router_firewall']
    assert rf['events'] == [{'key': 'ip_changed', 'label': 'IP Changed'}]


def test_create_hook_rejects_unsupported_event(tmp_path: Path) -> None:
    """Saving a hook with an unsupported event returns 400."""
    payload = {
        'hook': 'router_firewall', 'enabled': True,
        'events': ['reachability_changed'], 'config': {},
    }
    with _client(tmp_path) as client:
        resp: Any = client.post('/api/hooks-config', json=payload)
    assert resp.status_code == 400


def test_create_hook_accepts_supported_event(tmp_path: Path) -> None:
    """Saving a hook with a supported event succeeds."""
    payload = {
        'hook': 'router_firewall', 'enabled': True,
        'events': ['ip_changed'],
        'config': {'username': 'u', 'password': 'p'},
    }
    with _client(tmp_path) as client:
        resp: Any = client.post('/api/hooks-config', json=payload)
    assert resp.status_code == 200
```

(`Path` and `Any` are already imported at the top of `test/unit/test_api.py`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest test/unit/test_api.py -k hook -v -o addopts=""`
Expected: FAIL — events are the global list; unsupported event is accepted (200 not 400).

- [ ] **Step 3: Implement the endpoint + validation**

In `tether_ddns/api.py`:

Update the import from hooks:
```python
from tether_ddns.hooks.base import EVENT_LABELS, HOOK_REGISTRY
```
(Remove `SUPPORTED_EVENTS` from the import if it becomes unused.)

Replace `get_hooks`:
```python
    @router.get('/hooks')
    def get_hooks() -> list[dict[str, object]]:
        return [
            {'key': k, 'display_name': c.display_name,
             'events': [
                 {'key': e, 'label': EVENT_LABELS.get(e, e)}
                 for e in c.supported_events],
             'schema': c.config_schema()}
            for k, c in HOOK_REGISTRY.items()
        ]
```

Add a module-level helper near the other helpers (after `_hook_schema`):
```python
def _validate_hook_events(hook: str, events: list[str]) -> None:
    cls = HOOK_REGISTRY.get(hook)
    if cls is None:
        raise HTTPException(status_code=400, detail=f'unknown hook {hook}')
    for event in events:
        if event not in cls.supported_events:
            raise HTTPException(
                status_code=400,
                detail=f'unsupported event {event} for hook {hook}')
```

Call it at the top of `create_hook` and `update_hook`, before persisting:
```python
    @router.post('/hooks-config')
    def create_hook(payload: HookInput) -> dict[str, object]:
        _validate_hook_events(payload.hook, payload.events)
        hook = HookConfig(**payload.model_dump())
        ...
```
```python
    @router.put('/hooks-config/{hook_id}')
    def update_hook(hook_id: str, payload: HookInput) -> dict[str, object]:
        _validate_hook_events(payload.hook, payload.events)
        for i, h in enumerate(app.state.config.hooks):
            ...
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest test/unit/test_api.py -k hook -v -o addopts=""`
Expected: all PASS.

- [ ] **Step 5: Lint and type-check**

Run:
```bash
ruff check tether_ddns/api.py test/unit/test_api.py
flake8 tether_ddns/api.py test/unit/test_api.py
mypy .
pyright tether_ddns
```
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add tether_ddns/api.py test/unit/test_api.py
git commit -m "feat(api): per-hook labeled events and hook-config event validation"
```

---

### Task 3: Scheduler guard against unsupported events

**Files:**
- Modify: `tether_ddns/scheduler.py`
- Test: `test/unit/test_scheduler.py` (append; create if absent)

**Interfaces:**
- Consumes: `Hook.supported_events`, `HOOK_REGISTRY`.

- [ ] **Step 1: Write the failing test**

Append to `test/unit/test_scheduler.py`. This registers a temporary spy hook, points a config at it, and asserts it is only called for supported+enabled events:

```python
import pytest

from tether_ddns.config import AppConfig, HookConfig
from tether_ddns.hooks.base import HOOK_REGISTRY, Hook, HookEvent, register_hook
from tether_ddns.scheduler import dispatch_hooks


@pytest.mark.asyncio
async def test_dispatch_skips_unsupported_event(monkeypatch) -> None:
    """A hook is not invoked for an event it does not support, even if enabled."""
    calls: list[str] = []

    @register_hook
    class _SpyHook(Hook):
        key = '_spy'
        display_name = 'Spy'
        supported_events = ('ip_changed',)

        async def handle(self, event: HookEvent, config) -> None:  # type: ignore[override]
            calls.append(event.type)

    try:
        cfg = AppConfig(
            hooks=[HookConfig(
                hook='_spy', enabled=True,
                events=['ip_changed', 'reachability_changed'], config={})])
        await dispatch_hooks(
            HookEvent(type='reachability_changed', old='offline', new='online'), cfg)
        assert calls == []
        await dispatch_hooks(
            HookEvent(type='ip_changed', old='a', new='b'), cfg)
        assert calls == ['ip_changed']
    finally:
        HOOK_REGISTRY.pop('_spy', None)
```

Note: confirm `AppConfig`/`HookConfig` constructor fields by reading `tether_ddns/config.py`
and adjust the kwargs if needed (e.g. whether `config` is required).

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest test/unit/test_scheduler.py::test_dispatch_skips_unsupported_event -v -o addopts=""`
Expected: FAIL — the reachability event currently invokes the hook (`calls == ['reachability_changed']`).

- [ ] **Step 3: Implement the guard**

In `tether_ddns/scheduler.py`, rewrite `dispatch_hooks` to resolve the class first and check `supported_events`:

```python
async def dispatch_hooks(event: HookEvent, cfg: AppConfig) -> None:
    """Invoke every matching enabled hook, isolating exceptions."""
    for hook_cfg in cfg.hooks:
        hook_cls = HOOK_REGISTRY.get(hook_cfg.hook)
        if hook_cls is None:
            _log.warning('Unknown hook %s', hook_cfg.hook)
            continue
        if (not hook_cfg.enabled
                or event.type not in hook_cfg.events
                or event.type not in hook_cls.supported_events):
            continue
        try:
            config = hook_cls.ConfigModel.model_validate(hook_cfg.config)
            await hook_cls().handle(event, config)
        except Exception:  # noqa: BLE001 - hook errors must be contained
            _log.exception('Hook %s failed on %s', hook_cfg.hook, event.type)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest test/unit/test_scheduler.py::test_dispatch_skips_unsupported_event -v -o addopts=""`
Expected: PASS.

- [ ] **Step 5: Lint and type-check**

Run:
```bash
ruff check tether_ddns/scheduler.py test/unit/test_scheduler.py
flake8 tether_ddns/scheduler.py test/unit/test_scheduler.py
mypy .
pyright tether_ddns
```
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add tether_ddns/scheduler.py test/unit/test_scheduler.py
git commit -m "feat(scheduler): guard hooks against unsupported event types"
```

---

### Task 4: Frontend renders labeled events

**Files:**
- Modify: `frontend/src/types.ts`
- Modify: `frontend/src/components/HookModal.tsx`
- Test: `frontend/src/components/HookModal.test.tsx`

**Interfaces:**
- Consumes: `/hooks` events shaped `{key,label}`.
- Produces: `HookEventDef { key: string; label: string }`; `HookDef.events: HookEventDef[]`.

- [ ] **Step 1: Write the failing test**

Read the existing `frontend/src/components/HookModal.test.tsx` to match its render/setup
helpers, then add a test that passes a `HookDef` whose `events` are `{key,label}` objects and
asserts the label text is rendered and toggling includes the event key. Example (adapt prop
names to the existing tests):

```typescript
  it('renders event labels and toggles by key', () => {
    const hooks = [{
      key: 'router_firewall', display_name: 'Router Firewall (ZTE)',
      events: [{ key: 'ip_changed', label: 'IP Changed' }],
      schema: { properties: {} },
    }];
    const onSave = vi.fn();
    render(
      <HookModal open hooks={hooks} editing={null} onClose={vi.fn()} onSave={onSave} />,
    );
    expect(screen.getByText('IP Changed')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('IP Changed'));
    fireEvent.click(screen.getByText('Add Hook'));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ events: ['ip_changed'] }));
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/components/HookModal.test.tsx`
Expected: FAIL — current code renders `event` string directly and TS types don't match `{key,label}`.

- [ ] **Step 3: Update types and modal**

In `frontend/src/types.ts`, replace the `HookDef` line:

```typescript
export interface HookEventDef { key: string; label: string; }
export interface HookDef { key: string; display_name: string; events: HookEventDef[]; schema: Record<string, unknown>; }
```

In `frontend/src/components/HookModal.tsx`, the `availableEvents` is now `HookEventDef[]`. Update the events render block:

```typescript
            {availableEvents.map((event) => (
              <label className="switch-row" key={event.key} style={{ cursor: 'pointer' }}>
                <div className="sr-text"><div className="t">{event.label}</div></div>
                <input
                  type="checkbox"
                  aria-label={event.label}
                  checked={form.events.includes(event.key)}
                  onChange={() => toggleEvent(event.key)}
                />
              </label>
            ))}
```

(`form.events` stays `string[]` of keys; `toggleEvent` is unchanged.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/components/HookModal.test.tsx`
Expected: PASS.

- [ ] **Step 5: Lint and type-check the frontend**

Run: `cd frontend && npm run lint && npm run typecheck`
Expected: no errors. If `App.tsx` references `h.events` from a `HookDef` anywhere as strings, update it to use `.label`/`.key` (the hook-row display uses `HookConfig.events`, which remains `string[]`, so it is unaffected — verify with typecheck).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/types.ts frontend/src/components/HookModal.tsx frontend/src/components/HookModal.test.tsx
git commit -m "feat(frontend): render hook events as labeled, key-toggled options"
```

---

## Final Verification (after all tasks)

- [ ] Backend: `python -m pytest` → all pass, coverage ≥ 90%.
- [ ] Frontend: `cd frontend && npm test` → all pass.
- [ ] Manual: open the Add Hook modal for Router Firewall; only "IP Changed" is offered; attempting to save a reachability event via the API returns 400.
