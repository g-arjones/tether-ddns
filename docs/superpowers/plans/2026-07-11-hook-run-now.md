# "Run Now" Button on Hook Rows — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Run now" button on each hook row that fires the hook against current runtime state via a new endpoint.

**Architecture:** A `run_hook_now(hook_cfg, cfg, state)` helper in the scheduler fires the hook for each enabled + supported event using current IP/online values; a `POST /api/hooks-config/{id}/run` endpoint wraps it; the frontend adds a button + toast.

**Tech Stack:** Python 3.12, FastAPI, pydantic v2, React + TypeScript + Vitest.

**Depends on:** the hook-supported-events plan (`Hook.supported_events` must exist).

## Global Constraints

- Docstrings on all public Python functions (flake8 pep257); single quotes; alphabetical imports.
- Must pass: `flake8`, `ruff check`, `mypy .`, `pyright tether_ddns`, `pytest --cov-fail-under=90`; frontend `npm run lint`, `npm run typecheck`, `npm test`.
- No new dependencies.

---

### Task 1: `run_hook_now` helper in the scheduler

**Files:**
- Modify: `tether_ddns/scheduler.py`
- Test: `test/unit/test_scheduler.py`

**Interfaces:**
- Consumes: `HOOK_REGISTRY`, `Hook.supported_events`, `HookEvent`, `RuntimeState` (`public_ipv4`, `public_ipv6`, `online`).
- Produces: `async def run_hook_now(hook_cfg: HookConfig, cfg: AppConfig, state: RuntimeState) -> dict[str, object]` returning `{'ran': int, 'skipped': list[str]}`.

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/test_scheduler.py`:

```python
@pytest.mark.asyncio
async def test_run_hook_now_fires_per_known_ip_family() -> None:
    """ip_changed fires once per known IP family with current values."""
    calls: list[tuple[str, str | None, str | None]] = []

    from tether_ddns.hooks.base import HOOK_REGISTRY, Hook, register_hook

    @register_hook
    class _SpyRun(Hook):
        key = '_spyrun'
        display_name = 'SpyRun'
        supported_events = ('ip_changed', 'reachability_changed')

        async def handle(self, event, config) -> None:  # type: ignore[override]
            calls.append((event.type, event.old, event.new))

    try:
        state = RuntimeState()
        state.set_public_ipv4('1.2.3.4')
        state.set_public_ipv6('2001:db8::9')
        state.set_online(True)
        cfg = AppConfig(hooks=[HookConfig(
            id='h', hook='_spyrun', enabled=True,
            events=['ip_changed', 'reachability_changed'], config={})])
        result = await scheduler.run_hook_now(cfg.hooks[0], cfg, state)
        assert result['ran'] == 3  # v4 + v6 + reachability
        assert result['skipped'] == []
        assert ('ip_changed', '1.2.3.4', '1.2.3.4') in calls
        assert ('ip_changed', '2001:db8::9', '2001:db8::9') in calls
        assert ('reachability_changed', 'online', 'online') in calls
    finally:
        HOOK_REGISTRY.pop('_spyrun', None)


@pytest.mark.asyncio
async def test_run_hook_now_skips_ip_changed_when_no_ip() -> None:
    """ip_changed is skipped and reported when no IP is known."""
    from tether_ddns.hooks.base import HOOK_REGISTRY, Hook, register_hook

    ran: list[str] = []

    @register_hook
    class _SpyNoIp(Hook):
        key = '_spynoip'
        display_name = 'SpyNoIp'
        supported_events = ('ip_changed',)

        async def handle(self, event, config) -> None:  # type: ignore[override]
            ran.append(event.type)

    try:
        state = RuntimeState()
        cfg = AppConfig(hooks=[HookConfig(
            id='h', hook='_spynoip', enabled=True, events=['ip_changed'], config={})])
        result = await scheduler.run_hook_now(cfg.hooks[0], cfg, state)
        assert ran == []
        assert result['ran'] == 0
        assert result['skipped'] == ['ip_changed']
    finally:
        HOOK_REGISTRY.pop('_spynoip', None)


@pytest.mark.asyncio
async def test_run_hook_now_ignores_unsupported_enabled_event() -> None:
    """An enabled-but-unsupported event is neither run nor reported as skipped."""
    from tether_ddns.hooks.base import HOOK_REGISTRY, Hook, register_hook

    ran: list[str] = []

    @register_hook
    class _SpyUnsup(Hook):
        key = '_spyunsup'
        display_name = 'SpyUnsup'
        supported_events = ('ip_changed',)

        async def handle(self, event, config) -> None:  # type: ignore[override]
            ran.append(event.type)

    try:
        state = RuntimeState()
        state.set_online(True)
        cfg = AppConfig(hooks=[HookConfig(
            id='h', hook='_spyunsup', enabled=True,
            events=['reachability_changed'], config={})])
        result = await scheduler.run_hook_now(cfg.hooks[0], cfg, state)
        assert ran == []
        assert result == {'ran': 0, 'skipped': []}
    finally:
        HOOK_REGISTRY.pop('_spyunsup', None)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest test/unit/test_scheduler.py -k run_hook_now -v -o addopts=""`
Expected: FAIL with `AttributeError: module 'tether_ddns.scheduler' has no attribute 'run_hook_now'`.

- [ ] **Step 3: Implement `run_hook_now`**

In `tether_ddns/scheduler.py`, add after `dispatch_hooks`:

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
    events: list[HookEvent] = []
    skipped: list[str] = []
    for event_type in hook_cfg.events:
        if event_type not in hook_cls.supported_events:
            continue
        if event_type == 'reachability_changed':
            value = 'online' if state.online else 'offline'
            events.append(HookEvent(
                type='reachability_changed', old=value, new=value))
        elif event_type == 'ip_changed':
            ips = [ip for ip in (state.public_ipv4, state.public_ipv6) if ip]
            if not ips:
                skipped.append('ip_changed')
            for ip in ips:
                events.append(HookEvent(type='ip_changed', old=ip, new=ip))
    ran = 0
    for event in events:
        try:
            config = hook_cls.ConfigModel.model_validate(hook_cfg.config)
            await hook_cls().handle(event, config)
        except Exception:  # noqa: BLE001 - hook errors must be contained
            _log.exception('Hook %s failed on %s', hook_cfg.hook, event.type)
        ran += 1
    return {'ran': ran, 'skipped': skipped}
```

Ensure `HookConfig` is imported in `scheduler.py` (it already imports from `tether_ddns.config`; add `HookConfig` to that import if absent):

```python
from tether_ddns.config import AppConfig, DomainConfig, HookConfig
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest test/unit/test_scheduler.py -k run_hook_now -v -o addopts=""`
Expected: all PASS.

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
git commit -m "feat(scheduler): add run_hook_now manual trigger helper"
```

---

### Task 2: `POST /api/hooks-config/{id}/run` endpoint

**Files:**
- Modify: `tether_ddns/api.py`
- Test: `test/unit/test_api.py`

**Interfaces:**
- Consumes: `run_hook_now` from Task 1.
- Produces: `POST /api/hooks-config/{hook_id}/run` → `{'ran': int, 'skipped': list[str]}`; 404 unknown id.

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/test_api.py` (reuses `_client(tmp_path)`):

```python
def test_run_hook_endpoint_invokes_supported_events(tmp_path: Path) -> None:
    """POST /hooks-config/{id}/run fires the hook and returns a run count."""
    with _client(tmp_path) as client:
        created: Any = client.post('/api/hooks-config', json={
            'hook': 'log', 'enabled': True, 'events': ['ip_changed'], 'config': {},
        }).json()
        # Give the runtime a known IPv4 so ip_changed can fire.
        client.app.state.runtime.set_public_ipv4('1.2.3.4')
        resp: Any = client.post(f"/api/hooks-config/{created['id']}/run")
    assert resp.status_code == 200
    body: dict[str, object] = resp.json()
    assert body['ran'] == 1
    assert body['skipped'] == []


def test_run_hook_endpoint_404_for_unknown_id(tmp_path: Path) -> None:
    """Running an unknown hook id returns 404."""
    with _client(tmp_path) as client:
        resp: Any = client.post('/api/hooks-config/does-not-exist/run')
    assert resp.status_code == 404
```

Note: `client.app.state.runtime` is available because the TestClient context enters the app
lifespan. If accessing `client.app` triggers a type complaint, cast via `getattr(client, 'app')`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest test/unit/test_api.py -k run_hook -v -o addopts=""`
Expected: FAIL with 404/405 (route does not exist).

- [ ] **Step 3: Implement the endpoint**

In `tether_ddns/api.py`, add the route inside `register_routes` near the other hook-config
routes (after `delete_hook`):

```python
    @router.post('/hooks-config/{hook_id}/run')
    async def run_hook(hook_id: str) -> dict[str, object]:
        from tether_ddns.scheduler import run_hook_now
        for h in app.state.config.hooks:
            if h.id == hook_id:
                return await run_hook_now(h, app.state.config, app.state.runtime)
        raise HTTPException(status_code=404, detail='hook not found')
```

(The local import mirrors the existing pattern used by `sync_now`, avoiding a module-level
import cycle.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest test/unit/test_api.py -k run_hook -v -o addopts=""`
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
git commit -m "feat(api): POST /hooks-config/{id}/run to trigger a hook manually"
```

---

### Task 3: Frontend "Run now" button + toast

**Files:**
- Modify: `frontend/src/api.ts`
- Modify: `frontend/src/App.tsx`
- Test: `frontend/src/App.runhook.test.tsx` (create)

**Interfaces:**
- Consumes: `POST /api/hooks-config/{id}/run`.
- Produces: `runHook(id: string): Promise<{ ran: number; skipped: string[] }>`.

- [ ] **Step 1: Add the API function**

In `frontend/src/api.ts`, after `deleteHook`:

```typescript
export const runHook = (id: string) => json<{ ran: number; skipped: string[] }>(`/api/hooks-config/${id}/run`, { method: 'POST' });
```

- [ ] **Step 2: Write the failing test**

Create `frontend/src/App.runhook.test.tsx`. Model the mock/render setup on the existing
`frontend/src/App.interval.test.tsx` (read it first for the `vi.mock('./api', ...)` shape and
how `App` is rendered/awaited). The test mocks `api.getHooksConfig` to return one hook and
`api.runHook` to resolve `{ ran: 2, skipped: [] }`, clicks "Run now", and asserts `runHook`
was called with the hook id:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import App from './App';
import * as api from './api';

vi.mock('./api');

describe('App run hook', () => {
  beforeEach(() => {
    vi.mocked(api.getState).mockResolvedValue({
      public_ipv4: '1.2.3.4', public_ipv6: null, online: true,
      domains: [], settings: {
        check_interval: 300, ip_source: 'ipify', update_on_startup: true,
        retry_on_failure: true, notify: true,
      }, logs: [],
    } as never);
    vi.mocked(api.getDomains).mockResolvedValue([] as never);
    vi.mocked(api.getHooksConfig).mockResolvedValue([
      { id: 'h1', hook: 'log', events: ['ip_changed'], config: {} },
    ] as never);
    vi.mocked(api.getSettings).mockResolvedValue({} as never);
    vi.mocked(api.getProviders).mockResolvedValue([] as never);
    vi.mocked(api.getHooks).mockResolvedValue([] as never);
    vi.mocked(api.getIpSources).mockResolvedValue([] as never);
    vi.mocked(api.runHook).mockResolvedValue({ ran: 2, skipped: [] });
  });

  it('calls runHook and shows a success toast', async () => {
    render(<App />);
    const btn = await screen.findByRole('button', { name: /run now/i });
    fireEvent.click(btn);
    await waitFor(() => expect(api.runHook).toHaveBeenCalledWith('h1'));
    await screen.findByText(/Ran 2 action/i);
  });
});
```

Note: match the exact mocked functions to those `App` calls on mount (read `App.tsx` /
`App.interval.test.tsx`); include every `api.*` used during initial load so the mock is
complete.

- [ ] **Step 3: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/App.runhook.test.tsx`
Expected: FAIL — no "Run now" button exists.

- [ ] **Step 4: Add the button and handler**

In `frontend/src/App.tsx`, add a per-row handler (near the other `pushToast` callbacks). Add a
run handler:

```typescript
  const runHook = useCallback(
    async (id: string) => {
      try {
        const res = await api.runHook(id);
        if (res.ran > 0) {
          pushToast(`Ran ${res.ran} action${res.ran === 1 ? '' : 's'}`, 'success');
        } else {
          pushToast('Nothing to run (no enabled events or IP unknown)', 'info');
        }
      } catch {
        pushToast('Run failed', 'error');
      }
    },
    [pushToast],
  );
```

In the hook row JSX, add the button before "Edit":

```tsx
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => runHook(h.id)}>Run now</button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setEditingHook(h); setHookModalOpen(true); }}>Edit</button>
```

Ensure `api` is imported as a namespace (it already is — `import * as api from './api'` or
individual imports; match the file's existing style, adding `runHook` if using named imports).

- [ ] **Step 5: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/App.runhook.test.tsx`
Expected: PASS.

- [ ] **Step 6: Lint and type-check the frontend**

Run: `cd frontend && npm run lint && npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/api.ts frontend/src/App.tsx frontend/src/App.runhook.test.tsx
git commit -m "feat(frontend): Run now button on hook rows"
```

---

## Final Verification (after all tasks)

- [ ] Backend: `python -m pytest` → all pass, coverage ≥ 90%.
- [ ] Frontend: `cd frontend && npm test` → all pass.
- [ ] Manual: with the server running and a Router Firewall hook configured with `ip_changed`, click "Run now" and confirm a toast appears and the router firewall re-applies the current IPv6 (visible in the logs).
