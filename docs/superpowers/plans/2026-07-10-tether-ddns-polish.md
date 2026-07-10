# Tether DDNS Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply five focused hardening fixes to the Tether DDNS app identified in final review.

**Architecture:** Small, localized edits to existing modules; no new endpoints or UI. TDD where behavior changes.

**Tech Stack:** Python 3.12 (FastAPI, pydantic, aiodns); React + TypeScript + Vite, Vitest.

## Global Constraints

- Python `>=3.12`. Backend passes strict gates: flake8 (pep257 docstrings, alphabetical import order, single quotes, naming), mypy (`mypy .`), pyright strict (`pyright tether_ddns`), ruff. New/edited code needs docstrings + full annotations.
- Backend coverage gate: `pytest test/` must pass with `--cov-fail-under=90`.
- Frontend: strict TS; `tsc --noEmit` clean; Vitest + coverage thresholds pass; Playwright e2e passes.
- Secrets remain write-only/masked (do not regress).
- Do not weaken mypy.ini / pyrightconfig.json. Scope any `# noqa` / `# pyright: ignore` narrowly.
- Do not commit artifacts (node_modules, tether_ddns/static, coverage, playwright-report/test-results).
- Venv at `.venv` (`source .venv/bin/activate`; project uses `uv`). Backend unit tests in `test/unit/`.

---

## Task 1: Non-deprecated aiodns call — reachability

**Files:**
- Modify: `tether_ddns/reachability.py`
- Test: `test/unit/test_reachability.py` (extend)

**Interfaces:**
- No signature changes. `_query_one` now calls `resolver.query_dns(self._query_host, 'A')` instead of the deprecated `resolver.query(...)`. Verified against aiodns 4.0.4: `query_dns(host: str, qtype: str, qclass: str | None = None)`.

- [ ] **Step 1: Change the call**

In `tether_ddns/reachability.py`, `_query_one`, replace:
```python
            await asyncio.wait_for(
                resolver.query(self._query_host, 'A'), timeout=self._timeout)
```
with:
```python
            await asyncio.wait_for(
                resolver.query_dns(self._query_host, 'A'), timeout=self._timeout)
```

- [ ] **Step 2: Add a focused test that `_query_one` uses query_dns**

Append to `test/unit/test_reachability.py`:
```python
@pytest.mark.asyncio
async def test_query_one_uses_query_dns(monkeypatch: pytest.MonkeyPatch) -> None:
    """_query_one calls the non-deprecated query_dns and reports ok on success."""
    service = ReachabilityService(resolvers=['1.1.1.1'])

    class _FakeResolver:
        def __init__(self, nameservers: list[str]) -> None:
            self.nameservers = nameservers

        async def query_dns(self, host: str, qtype: str) -> object:
            return object()

    monkeypatch.setattr('tether_ddns.reachability.aiodns.DNSResolver', _FakeResolver)
    ip, status = await service._query_one('1.1.1.1')
    assert (ip, status) == ('1.1.1.1', 'ok')
```
(If `_query_one` is name-mangled/private, calling it directly is fine in-package. Ensure `pytest`/`asyncio_mode=auto` handles the coroutine; the file already imports `pytest`.)

- [ ] **Step 3: Verify**

Run: `python -m pytest test/unit/test_reachability.py -v` → PASS.
Lint: `ruff check tether_ddns/reachability.py test/unit/test_reachability.py`, `flake8 ...`, `mypy tether_ddns/reachability.py`. Fix violations.

- [ ] **Step 4: Commit**

```bash
git add tether_ddns/reachability.py test/unit/test_reachability.py
git commit -m "fix: use non-deprecated aiodns query_dns"
```

---

## Task 2: Provider EmptyConfig default

**Files:**
- Modify: `tether_ddns/providers/base.py`
- Test: `test/unit/test_provider_registry.py` (extend)

**Interfaces:**
- Add `class EmptyConfig(BaseModel)` and change `DDNSProvider.ConfigModel` default from `BaseModel` to `EmptyConfig`. Behavior-preserving; DuckDNS overrides `ConfigModel`.

- [ ] **Step 1: Add EmptyConfig and use it as the default**

In `tether_ddns/providers/base.py`, after `UpdateResult` (before `DDNSProvider`), add:
```python
class EmptyConfig(BaseModel):
    """Default provider config model for providers without configuration."""
```
Then change:
```python
    ConfigModel: type[BaseModel] = BaseModel
```
to:
```python
    ConfigModel: type[BaseModel] = EmptyConfig
```

- [ ] **Step 2: Add a test that a config-less provider validates to an empty model**

Append to `test/unit/test_provider_registry.py`:
```python
def test_default_config_model_is_empty_config() -> None:
    """Providers that omit ConfigModel default to EmptyConfig, not bare BaseModel."""
    @base.register_provider
    class _NoConfig(base.DDNSProvider):
        key = 'noconfig'
        display_name = 'NoConfig'

        async def update(
            self, hostname: str, record_type: str, ip: str, config: BaseModel,
        ) -> base.UpdateResult:
            return base.UpdateResult(success=True, ip=ip)

    assert _NoConfig.ConfigModel is base.EmptyConfig
    validated = _NoConfig.ConfigModel.model_validate({})
    assert isinstance(validated, base.EmptyConfig)
```
Ensure `BaseModel` is imported in the test file (it is, from Task 12 fixes; if not, add `from pydantic import BaseModel`).

- [ ] **Step 3: Verify**

Run: `python -m pytest test/unit/test_provider_registry.py test/unit/test_duckdns.py -v` → PASS (DuckDNS unaffected).
Lint: `ruff check`, `flake8`, `mypy tether_ddns/providers/base.py`. Fix violations.

- [ ] **Step 4: Commit**

```bash
git add tether_ddns/providers/base.py test/unit/test_provider_registry.py
git commit -m "refactor: default provider ConfigModel to EmptyConfig for consistency"
```

---

## Task 3: Strict settings validation — PUT /api/settings

**Files:**
- Modify: `tether_ddns/api.py`
- Test: `test/unit/test_api.py` (extend)

**Interfaces:**
- New model `SettingsUpdate(BaseModel)` with all `AppSettings` fields optional and `model_config = ConfigDict(extra='forbid')`. `put_settings(payload: SettingsUpdate)` applies `payload.model_dump(exclude_unset=True)` onto current settings via `AppSettings(**{**current.model_dump(), **set_fields})`, persists, returns the dump. FastAPI returns 422 on bad type or unknown key automatically.

- [ ] **Step 1: Add the SettingsUpdate model**

In `tether_ddns/api.py`, update the pydantic import to include `ConfigDict`:
```python
from pydantic import BaseModel, ConfigDict
```
Add, near `HookInput`:
```python
class SettingsUpdate(BaseModel):
    """Partial settings update; rejects unknown keys and bad types."""

    model_config = ConfigDict(extra='forbid')

    check_interval: int | None = None
    ip_source: str | None = None
    update_on_startup: bool | None = None
    retry_on_failure: bool | None = None
    notify: bool | None = None
```

- [ ] **Step 2: Rewrite put_settings**

Replace the existing `put_settings` handler with:
```python
    @router.put('/settings')
    def put_settings(payload: SettingsUpdate) -> dict[str, object]:
        current = app.state.config.settings
        set_fields = payload.model_dump(exclude_unset=True)
        merged = AppSettings(**{**current.model_dump(), **set_fields})
        app.state.config.settings = merged
        _persist(app)
        dumped: dict[str, object] = merged.model_dump()
        return dumped
```
Remove the now-unused `Any` import if nothing else uses it. Check the file: `get_state`/others may still use `Any`? Search — if `from typing import Any` becomes unused after this change, remove it to satisfy ruff/flake8; if still used, keep it.

- [ ] **Step 3: Add tests**

Append to `test/unit/test_api.py`:
```python
def test_settings_update_valid_partial(tmp_path: Path) -> None:
    """A valid partial settings update round-trips."""
    with _client(tmp_path) as client:
        resp: Any = client.put('/api/settings', json={'check_interval': 120})
        assert resp.status_code == 200
        assert resp.json()['check_interval'] == 120
        assert client.get('/api/settings').json()['check_interval'] == 120


def test_settings_update_bad_type_returns_422(tmp_path: Path) -> None:
    """A wrong-typed settings value is rejected with 422, not 500."""
    with _client(tmp_path) as client:
        resp: Any = client.put('/api/settings', json={'check_interval': 'soon'})
    assert resp.status_code == 422


def test_settings_update_unknown_key_returns_422(tmp_path: Path) -> None:
    """An unknown settings key is rejected with 422."""
    with _client(tmp_path) as client:
        resp: Any = client.put('/api/settings', json={'nope': 1})
    assert resp.status_code == 422
```
(If an existing `test_settings_update_round_trips` test posts multiple fields, keep it; it should still pass with the new model. If it posted an unknown key, update it to only send valid fields.)

- [ ] **Step 4: Verify**

Run: `python -m pytest test/unit/test_api.py -v` → PASS.
Lint: `ruff check tether_ddns/api.py test/unit/test_api.py`, `flake8 ...`, `mypy tether_ddns/api.py`, `pyright tether_ddns/api.py`. Fix violations (esp. unused `Any` import).

- [ ] **Step 5: Commit**

```bash
git add tether_ddns/api.py test/unit/test_api.py
git commit -m "fix: validate PUT /api/settings, reject bad types and unknown keys (422)"
```

---

## Task 4: Forced sync detects IP first — POST /api/domains/{id}/sync

**Files:**
- Modify: `tether_ddns/api.py`
- Test: `test/unit/test_api.py` (extend)

**Interfaces:**
- `sync_now` no longer passes an empty IP. If `runtime.public_ip` is falsy, it calls `detect_public_ip(config.settings.ip_source)`; on success updates runtime and uses it; on failure raises `HTTPException(503, detail='public IP unknown')`.

- [ ] **Step 1: Rewrite sync_now**

Replace the `sync_now` handler with:
```python
    @router.post('/domains/{domain_id}/sync')
    async def sync_now(domain_id: str) -> dict[str, bool]:
        from tether_ddns.ip_sources.base import detect_public_ip
        from tether_ddns.scheduler import sync_domain
        for d in app.state.config.domains:
            if d.id == domain_id:
                runtime = app.state.runtime
                ip = runtime.public_ip
                if not ip:
                    ip = await detect_public_ip(app.state.config.settings.ip_source)
                    if not ip:
                        raise HTTPException(
                            status_code=503, detail='public IP unknown')
                    runtime.set_public_ip(ip)
                await sync_domain(d, ip, runtime)
                return {'ok': True}
        raise HTTPException(status_code=404, detail='domain not found')
```

- [ ] **Step 2: Add tests**

Append to `test/unit/test_api.py` (module already imports `AsyncMock`, `patch`):
```python
def test_sync_detects_ip_when_unknown(tmp_path: Path) -> None:
    """Forced sync with no known IP detects one, then syncs the domain."""
    with _client(tmp_path) as client:
        created: Any = client.post('/api/domains', json={
            'hostname': 'home.example.com', 'provider': 'duckdns',
            'provider_config': {'token': 'x', 'domain': 'home'},
        }).json()
        with patch(
            'tether_ddns.ip_sources.base.detect_public_ip',
            new=AsyncMock(return_value='203.0.113.9'),
        ), patch(
            'tether_ddns.providers.ddns_providers.duckdns.DuckDNSProvider.update',
            new=AsyncMock(return_value=None),
        ) as upd:
            resp: Any = client.post(f'/api/domains/{created["id"]}/sync')
        assert resp.status_code == 200
        assert upd.await_args.args[2] == '203.0.113.9'


def test_sync_returns_503_when_ip_undetectable(tmp_path: Path) -> None:
    """Forced sync returns 503 when no public IP can be determined."""
    with _client(tmp_path) as client:
        created: Any = client.post('/api/domains', json={
            'hostname': 'home.example.com', 'provider': 'duckdns',
            'provider_config': {'token': 'x', 'domain': 'home'},
        }).json()
        with patch(
            'tether_ddns.ip_sources.base.detect_public_ip',
            new=AsyncMock(return_value=None),
        ):
            resp: Any = client.post(f'/api/domains/{created["id"]}/sync')
    assert resp.status_code == 503
```
Note: `DuckDNSProvider.update` returning `None` — `sync_domain` treats a provider returning falsy result carefully; check the real `sync_domain`. If `sync_domain` expects an `UpdateResult`, mock the update to return `UpdateResult(success=True, ip=...)` instead of `None`. Read `tether_ddns/scheduler.py` `sync_domain` and match the expected return type. The KEY assertion is that `update` (or `sync_domain`) is invoked with the detected IP `'203.0.113.9'`, not an empty string. Adjust the mock's return to whatever keeps the call non-erroring, and assert the IP passed through.

- [ ] **Step 3: Verify**

Run: `python -m pytest test/unit/test_api.py -v` → PASS.
Lint: `ruff check tether_ddns/api.py test/unit/test_api.py`, `flake8 ...`, `mypy tether_ddns/api.py`, `pyright tether_ddns/api.py`. Fix violations.

- [ ] **Step 4: Commit**

```bash
git add tether_ddns/api.py test/unit/test_api.py
git commit -m "fix: forced sync detects public IP first, 503 when unknown"
```

---

## Task 5: WebSocket scheme + dead ref — useLiveState

**Files:**
- Modify: `frontend/src/useLiveState.ts`
- Test: `frontend/src/useLiveState.test.tsx` (extend)

**Interfaces:**
- The socket URL scheme is derived: `wss:` on HTTPS pages, else `ws:`. The unused `wsRef` is removed.

- [ ] **Step 1: Update the hook**

Rewrite `frontend/src/useLiveState.ts`:
```tsx
import { useEffect, useState } from 'react';
import type { StateSnapshot, LogEntry } from './types';

export function useLiveState(): { snapshot: StateSnapshot | null; logs: LogEntry[] } {
  const [snapshot, setSnapshot] = useState<StateSnapshot | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);

  useEffect(() => {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/api/ws`);
    ws.onmessage = (e: MessageEvent) => {
      const { kind, payload } = JSON.parse(e.data);
      if (kind === 'state') setSnapshot(payload as StateSnapshot);
      else if (kind === 'log') setLogs((prev) => [...prev.slice(-499), payload as LogEntry]);
    };
    return () => ws.close();
  }, []);

  return { snapshot, logs };
}
```

- [ ] **Step 2: Add a Vitest case for the scheme**

The existing `FakeWS` in `frontend/src/useLiveState.test.tsx` records the constructed instance and its `url`. Add a test that stubs `location.protocol` to `https:` and asserts the URL starts with `wss://`, and (existing or new) that it uses `ws://` otherwise. Example:
```tsx
it('uses wss:// when the page is served over https', () => {
  const original = window.location;
  Object.defineProperty(window, 'location', {
    value: { ...original, protocol: 'https:', host: 'example.com' },
    writable: true,
  });
  try {
    renderHook(() => useLiveState());
    expect(lastInstance!.url).toBe('wss://example.com/api/ws');
  } finally {
    Object.defineProperty(window, 'location', { value: original, writable: true });
  }
});
```
Adapt `lastInstance`/`FakeWS` to the actual test file's helper names (read the file first). Keep the existing tests passing (they assert `ws://` under the default jsdom `http:` protocol).

- [ ] **Step 3: Verify**

Run: `cd frontend && npx vitest run src/useLiveState.test.tsx` → PASS.
Run: `cd frontend && npx tsc --noEmit` → clean.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/useLiveState.ts frontend/src/useLiveState.test.tsx
git commit -m "fix: derive ws/wss scheme from page protocol and drop dead wsRef"
```

---

## Task 6: Full gate + e2e verification

**Files:** none new — run the whole suite.

- [ ] **Step 1: Backend gate**

Run: `source .venv/bin/activate && pytest test/ -q` → all pass, coverage ≥ 90, flake8/mypy/pyright/ruff linter tests green. Fix anything red.

- [ ] **Step 2: Frontend + e2e**

Run: `cd frontend && npx tsc --noEmit && npx vitest run --coverage && npx playwright test` → all pass (e2e webServer builds the SPA and serves it). Fix anything red.

- [ ] **Step 3: Commit any fixes**

```bash
git add -A
git commit -m "chore: verify polish changes pass full backend + frontend gates"
```
(Only if fixes were needed; otherwise skip.)

---

## Self-Review Notes

- **Spec coverage:** aiodns query_dns (T1), provider EmptyConfig (T2), strict settings 422 (T3), sync IP detection + 503 (T4), ws/wss scheme + dead ref (T5), full-gate verification (T6). All five spec items mapped.
- **Type consistency:** `SettingsUpdate`, `EmptyConfig`, `detect_public_ip`, `set_public_ip`, `sync_domain` referenced against their real signatures (implementers must read `scheduler.sync_domain` return type before finalizing the T4 mock).
- **Placeholders:** none — each code step is concrete; T4/T5 explicitly instruct reading the real `sync_domain` and the test-file helper names to match exact shapes.
