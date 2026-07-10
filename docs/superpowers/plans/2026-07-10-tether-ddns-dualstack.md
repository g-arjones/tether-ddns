# Tether DDNS Dual-Stack & Dashboard Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add dual-stack IPv4/IPv6, split reachability onto a fixed 30s job, and fix three UI issues (interval units, dual IP display, count-badge alignment).

**Architecture:** Bottom-up backend changes (IP sources → runtime → scheduler → api) then frontend (types → header pills → settings/dashboard units → CSS). TDD; strict gates.

**Tech Stack:** Python 3.12 (FastAPI, pydantic, APScheduler, aiohttp); React + TypeScript + Vite, Vitest.

## Global Constraints

- Python `>=3.12`. Strict gates: flake8 (pep257 docstrings, alphabetical import order, single quotes, naming), mypy (`mypy .`), pyright strict (`pyright tether_ddns`), ruff. Docstrings + full annotations on new/changed code.
- Backend coverage gate: `pytest test/` must pass with `--cov-fail-under=90`.
- Frontend: strict TS; `tsc --noEmit` clean; Vitest + coverage thresholds pass; Playwright e2e passes.
- `check_interval` is canonical **seconds** everywhere in the backend/API; only the UI converts to minutes for display.
- Reachability interval is the module constant `REACHABILITY_INTERVAL_SECONDS = 30` — no magic numbers.
- Do not weaken mypy.ini / pyrightconfig.json. Scope `# noqa` / `# pyright: ignore` narrowly.
- No artifacts committed (node_modules, tether_ddns/static, coverage, playwright-report/test-results).
- Venv at `.venv` (`source .venv/bin/activate`; project uses `uv`). Backend unit tests in `test/unit/`.

---

## Task 1: Dual-family IP sources

**Files:**
- Modify: `tether_ddns/ip_sources/base.py`, `tether_ddns/ip_sources/registered_sources/http_sources.py`
- Test: `test/unit/test_ip_sources.py` (update)

**Interfaces:**
- `IPFamily = Literal['ipv4', 'ipv6']` exported from `ip_sources/base.py`.
- `IPSource.detect(self, family: IPFamily) -> str | None` (abstract).
- `detect_public_ip(source_key: str, family: IPFamily) -> str | None` — no default for `source_key`; both args required.
- HTTP sources fetch per-family endpoints.

- [ ] **Step 1: Update the base**

In `tether_ddns/ip_sources/base.py`:
- Add import `from typing import Literal` (respect import order) and define near the top:
```python
IPFamily = Literal['ipv4', 'ipv6']
```
- Change the abstract method:
```python
    @abstractmethod
    async def detect(self, family: 'IPFamily') -> str | None:
        """Return the detected public IP for the family, or None on failure."""
        raise NotImplementedError
```
- Change the module function:
```python
async def detect_public_ip(source_key: str, family: 'IPFamily') -> str | None:
    """Detect the public IP for a family via the named source, or None."""
    cls = IP_SOURCE_REGISTRY.get(source_key)
    if cls is None:
        _log.warning('Unknown IP source %s', source_key)
        return None
    try:
        return await cls().detect(family)
    except Exception:  # noqa: BLE001 - detection failure must not raise
        _log.exception('IP source %s failed for %s', source_key, family)
        return None
```

- [ ] **Step 2: Update HTTP sources**

Replace `tether_ddns/ip_sources/registered_sources/http_sources.py` with:
```python
"""HTTP-based public IP sources."""
from __future__ import annotations

import aiohttp

from tether_ddns.ip_sources.base import IPFamily, IPSource, register_ip_source


async def _fetch(url: str) -> str | None:
    async with aiohttp.ClientSession() as session:
        async with session.get(url) as resp:
            return (await resp.text()).strip()


@register_ip_source
class IpifySource(IPSource):
    """Detects the public IP via ipify."""

    key = 'ipify'
    display_name = 'ipify.org'
    _URLS = {'ipv4': 'https://api.ipify.org', 'ipv6': 'https://api6.ipify.org'}

    async def detect(self, family: IPFamily) -> str | None:
        """Return the public IP from ipify for the family."""
        return await _fetch(self._URLS[family])


@register_ip_source
class IcanhazipSource(IPSource):
    """Detects the public IP via icanhazip."""

    key = 'icanhazip'
    display_name = 'icanhazip.com'
    _URLS = {'ipv4': 'https://ipv4.icanhazip.com', 'ipv6': 'https://ipv6.icanhazip.com'}

    async def detect(self, family: IPFamily) -> str | None:
        """Return the public IP from icanhazip for the family."""
        return await _fetch(self._URLS[family])
```

- [ ] **Step 3: Update tests**

In `test/unit/test_ip_sources.py`, update calls to pass a family. Replace the detect/ipify tests so they pass `'ipv4'`, and add an ipv6 assertion. Example additions/edits:
```python
@pytest.mark.asyncio
async def test_detect_public_ip_uses_source() -> None:
    """detect_public_ip returns the source's detected IP for a family."""
    base.load_ip_sources()
    with patch.object(
        base.IP_SOURCE_REGISTRY['ipify'], 'detect',
        new=AsyncMock(return_value='203.0.113.9'),
    ):
        assert await base.detect_public_ip('ipify', 'ipv4') == '203.0.113.9'


@pytest.mark.asyncio
async def test_detect_public_ip_unknown_source_returns_none() -> None:
    """An unknown source key yields None rather than raising."""
    assert await base.detect_public_ip('nope', 'ipv4') is None


@pytest.mark.asyncio
async def test_ipify_source_reads_ipv6_endpoint() -> None:
    """The ipify source fetches the v6 endpoint for the ipv6 family."""
    base.load_ip_sources()
    source = base.IP_SOURCE_REGISTRY['ipify']()
    with patch(
        'tether_ddns.ip_sources.registered_sources.http_sources._fetch',
        new=AsyncMock(return_value='2001:db8::1'),
    ) as fetch:
        assert await source.detect('ipv6') == '2001:db8::1'
        fetch.assert_awaited_once_with('https://api6.ipify.org')
```
Adapt the existing `test_ipify_source_reads_http_body`-style test to the new signature (pass `'ipv4'`, expect the v4 URL). Ensure `patch`/`AsyncMock` are imported.

- [ ] **Step 4: Verify**

Run: `python -m pytest test/unit/test_ip_sources.py -v` → PASS.
Lint: `ruff check`, `flake8`, `mypy tether_ddns/ip_sources`. Fix violations.

- [ ] **Step 5: Commit**

```bash
git add tether_ddns/ip_sources test/unit/test_ip_sources.py
git commit -m "feat: dual-family (IPv4/IPv6) IP source detection"
```

---

## Task 2: Runtime dual IP fields

**Files:**
- Modify: `tether_ddns/runtime.py`
- Test: `test/unit/test_runtime.py` (update)

**Interfaces:**
- `RuntimeState.public_ipv4: str | None`, `RuntimeState.public_ipv6: str | None`.
- `set_public_ipv4(ip: str | None) -> None`, `set_public_ipv6(ip: str | None) -> None` (each emits).
- `snapshot()` includes `public_ipv4`, `public_ipv6` (drop `public_ip`).

- [ ] **Step 1: Update RuntimeState**

In `tether_ddns/runtime.py`:
- In `__init__`, replace `self.public_ip: str | None = None` with:
```python
        self.public_ipv4: str | None = None
        self.public_ipv6: str | None = None
```
- Replace `set_public_ip` with two methods:
```python
    def set_public_ipv4(self, ip: str | None) -> None:
        """Update the current public IPv4 and notify listeners."""
        self.public_ipv4 = ip
        self._emit()

    def set_public_ipv6(self, ip: str | None) -> None:
        """Update the current public IPv6 and notify listeners."""
        self.public_ipv6 = ip
        self._emit()
```
- In `snapshot()` replace the `'public_ip'` entry:
```python
        return {
            'public_ipv4': self.public_ipv4,
            'public_ipv6': self.public_ipv6,
            'online': self.online,
            'domains': [d.model_dump() for d in self.domains.values()],
        }
```

- [ ] **Step 2: Update tests**

In `test/unit/test_runtime.py`, update any `public_ip`/`set_public_ip` usage and snapshot assertions to the new fields. Add a focused test:
```python
def test_set_public_ipv4_and_ipv6_emit_snapshot() -> None:
    """Setting each family updates state and emits a snapshot."""
    state = RuntimeState()
    seen: list[dict[str, object]] = []
    state.add_listener(seen.append)
    state.set_public_ipv4('203.0.113.4')
    state.set_public_ipv6('2001:db8::4')
    assert state.public_ipv4 == '203.0.113.4'
    assert state.public_ipv6 == '2001:db8::4'
    assert seen[-1]['public_ipv6'] == '2001:db8::4'
    assert 'public_ip' not in seen[-1]
```

- [ ] **Step 3: Verify**

Run: `python -m pytest test/unit/test_runtime.py -v` → PASS.
Lint: `ruff check`, `flake8`, `mypy tether_ddns/runtime.py`. Fix violations.

- [ ] **Step 4: Commit**

```bash
git add tether_ddns/runtime.py test/unit/test_runtime.py
git commit -m "feat: runtime holds separate public IPv4 and IPv6"
```

---

## Task 3: Scheduler — reachability split + dual-stack syncs

**Files:**
- Modify: `tether_ddns/scheduler.py`
- Test: `test/unit/test_scheduler.py` (update)

**Interfaces:**
- Module constant `REACHABILITY_INTERVAL_SECONDS = 30`.
- Helper `def _family_for(record_type: str) -> IPFamily` → `'ipv6'` if `record_type == 'AAAA'` else `'ipv4'` (import `IPFamily` from `ip_sources.base`).
- `Scheduler.start(cfg, state)` registers two jobs: `check_reachability` (id `reachability`, `REACHABILITY_INTERVAL_SECONDS`) and `sync_ips` (id `sync`, `cfg.settings.check_interval`).
- `async def check_reachability(self, cfg, state) -> None` — runs reachability, sets `state.online` on change, fires `reachability_changed` on transition only.
- `async def sync_ips(self, cfg, state) -> None` — if `state.online`: detect both families, per family that changed set runtime + fire `ip_changed`, sync enabled domains by record-type family, then `retry_on_failure`.
- `async def check_once(self, cfg, state) -> None` — `await self.check_reachability(...)`; if `state.online`, `await self.sync_ips(...)`. (Used by startup + refresh.)

- [ ] **Step 1: Write/adjust the failing tests**

Update `test/unit/test_scheduler.py`. Keep the existing exception-isolation tests for `sync_domain`/`dispatch_hooks` (they are unaffected). Add:
```python
@pytest.mark.asyncio
async def test_reachability_transition_fires_hook_only_on_change() -> None:
    """check_reachability fires reachability_changed only on an online transition."""
    load_hooks()
    cfg = AppConfig(hooks=[HookConfig(id='h', hook='log', events=['reachability_changed'])])
    state = RuntimeState()
    sched = scheduler.Scheduler()
    with patch.object(
        sched, '_reachability',
    ) as reach:
        reach.check = AsyncMock(return_value=ReachabilityResult(online=True, successes=3, total=3))
        with patch('tether_ddns.scheduler.dispatch_hooks', new=AsyncMock()) as dh:
            await sched.check_reachability(cfg, state)
            assert state.online is True
            dh.assert_awaited_once()
            dh.reset_mock()
            await sched.check_reachability(cfg, state)  # no transition
            dh.assert_not_awaited()


@pytest.mark.asyncio
async def test_sync_ips_updates_families_and_syncs_by_record_type() -> None:
    """sync_ips detects both families and syncs A from v4, AAAA from v6."""
    load_providers()
    cfg = AppConfig(domains=[
        DomainConfig(id='a', hostname='a', provider='duckdns', record_type='A',
                     provider_config={'token': 'x', 'domain': 'a'}),
        DomainConfig(id='b', hostname='b', provider='duckdns', record_type='AAAA',
                     provider_config={'token': 'x', 'domain': 'b'}),
    ])
    state = RuntimeState()
    state.online = True
    sched = scheduler.Scheduler()
    async def _detect(source: str, family: str) -> str:
        return '203.0.113.5' if family == 'ipv4' else '2001:db8::5'
    with patch('tether_ddns.scheduler.detect_public_ip', new=AsyncMock(side_effect=_detect)), \
         patch('tether_ddns.scheduler.sync_domain', new=AsyncMock()) as sd:
        await sched.sync_ips(cfg, state)
    assert state.public_ipv4 == '203.0.113.5'
    assert state.public_ipv6 == '2001:db8::5'
    calls = {c.args[0].id: c.args[1] for c in sd.await_args_list}
    assert calls['a'] == '203.0.113.5'
    assert calls['b'] == '2001:db8::5'
```
(Match the real import names already present at the top of the test file — `scheduler`, `AppConfig`, `DomainConfig`, `HookConfig`, `RuntimeState`, `ReachabilityResult`, `load_hooks`, `load_providers`. Add any missing imports.)

- [ ] **Step 2: Run to verify they fail**

Run: `python -m pytest test/unit/test_scheduler.py -k "reachability_transition or sync_ips" -v`
Expected: FAIL (methods not present yet).

- [ ] **Step 3: Rewrite scheduler**

Replace the imports/constant region and the `Scheduler` methods. Add near the top (after existing imports):
```python
from tether_ddns.ip_sources.base import IPFamily, detect_public_ip
```
(remove the old `detect_public_ip`-only import line; combine as above respecting order). Add the constant after `_log`:
```python
REACHABILITY_INTERVAL_SECONDS = 30


def _family_for(record_type: str) -> IPFamily:
    """Return the IP family a record type resolves against."""
    return 'ipv6' if record_type == 'AAAA' else 'ipv4'
```
Replace the `Scheduler` methods `start`, `check_once`, and add `check_reachability`/`sync_ips` (keep `run_startup_check`/`shutdown`):
```python
    def start(self, cfg: AppConfig, state: RuntimeState) -> None:
        """Schedule the reachability and IP-sync jobs and start."""
        self._scheduler.add_job(  # pyright: ignore[reportUnknownMemberType]
            self.check_reachability, 'interval',
            seconds=REACHABILITY_INTERVAL_SECONDS,
            args=[cfg, state], id='reachability', replace_existing=True,
        )
        self._scheduler.add_job(  # pyright: ignore[reportUnknownMemberType]
            self.sync_ips, 'interval', seconds=cfg.settings.check_interval,
            args=[cfg, state], id='sync', replace_existing=True,
        )
        self._scheduler.start()

    async def check_reachability(self, cfg: AppConfig, state: RuntimeState) -> None:
        """Run the DNS-quorum check; fire reachability_changed on transition."""
        reach = await self._reachability.check()
        if reach.online != state.online:
            old = 'online' if state.online else 'offline'
            new = 'online' if reach.online else 'offline'
            state.set_online(reach.online)
            await dispatch_hooks(
                HookEvent(type='reachability_changed', old=old, new=new), cfg)

    async def sync_ips(self, cfg: AppConfig, state: RuntimeState) -> None:
        """When online, refresh both IP families and sync domains."""
        if not state.online:
            return
        ipv4 = await detect_public_ip(cfg.settings.ip_source, 'ipv4')
        ipv6 = await detect_public_ip(cfg.settings.ip_source, 'ipv6')
        if ipv4 is not None and ipv4 != state.public_ipv4:
            old = state.public_ipv4
            state.set_public_ipv4(ipv4)
            await dispatch_hooks(HookEvent(type='ip_changed', old=old, new=ipv4), cfg)
        if ipv6 is not None and ipv6 != state.public_ipv6:
            old6 = state.public_ipv6
            state.set_public_ipv6(ipv6)
            await dispatch_hooks(HookEvent(type='ip_changed', old=old6, new=ipv6), cfg)
        by_family = {'ipv4': state.public_ipv4, 'ipv6': state.public_ipv6}
        for domain in cfg.domains:
            if not domain.enabled:
                continue
            ip = by_family[_family_for(domain.record_type)]
            runtime = state.domains.get(domain.id)
            needs_retry = (cfg.settings.retry_on_failure and runtime is not None
                           and runtime.status == 'error')
            if ip is not None and (runtime is None or runtime.status != 'synced'
                                   or needs_retry):
                await sync_domain(domain, ip, state)

    async def check_once(self, cfg: AppConfig, state: RuntimeState) -> None:
        """Run reachability then, if online, an IP sync (startup/refresh)."""
        await self.check_reachability(cfg, state)
        if state.online:
            await self.sync_ips(cfg, state)
```
Notes for the implementer: the `sync_ips` domain loop replaces the old ip-change + retry loops. It syncs a domain when its family IP is known and the domain is not already `synced` (covers first sync + retry). If you find this over/under-syncs versus the existing tests, adjust so that: (a) on a family IP change all enabled domains of that family sync, and (b) `retry_on_failure` re-syncs `error` domains. Keep behavior exception-isolated. Read the existing scheduler tests and make them pass; update assertions that referenced `check_once`'s old single-IP flow.

- [ ] **Step 4: Verify**

Run: `python -m pytest test/unit/test_scheduler.py -v` → PASS.
Lint: `ruff check tether_ddns/scheduler.py`, `flake8 ...`, `mypy tether_ddns/scheduler.py`, `pyright tether_ddns/scheduler.py`. Fix violations.

- [ ] **Step 5: Commit**

```bash
git add tether_ddns/scheduler.py test/unit/test_scheduler.py
git commit -m "feat: 30s reachability job split from dual-stack IP sync"
```

---

## Task 4: API — dual-stack sync + snapshot

**Files:**
- Modify: `tether_ddns/api.py`
- Test: `test/unit/test_api.py` (update)

**Interfaces:**
- `GET /api/state` already returns `snapshot()` (now dual). No code change beyond tests.
- `POST /api/domains/{id}/sync`: choose family from `record_type`; use the runtime IP for that family; if unknown, `detect_public_ip(ip_source, family)`, set the matching runtime field; on failure 503; else `sync_domain`.

- [ ] **Step 1: Rewrite sync_now**

Replace the `sync_now` handler:
```python
    @router.post('/domains/{domain_id}/sync')
    async def sync_now(domain_id: str) -> dict[str, bool]:
        from tether_ddns.ip_sources.base import detect_public_ip
        from tether_ddns.scheduler import _family_for, sync_domain
        for d in app.state.config.domains:
            if d.id == domain_id:
                runtime = app.state.runtime
                family = _family_for(d.record_type)
                ip = runtime.public_ipv4 if family == 'ipv4' else runtime.public_ipv6
                if not ip:
                    ip = await detect_public_ip(app.state.config.settings.ip_source, family)
                    if not ip:
                        raise HTTPException(
                            status_code=503, detail='public IP unknown')
                    if family == 'ipv4':
                        runtime.set_public_ipv4(ip)
                    else:
                        runtime.set_public_ipv6(ip)
                await sync_domain(d, ip, runtime)
                return {'ok': True}
        raise HTTPException(status_code=404, detail='domain not found')
```
(If importing a name-mangled-looking `_family_for` from another module trips a linter, it's a normal module-private function import; acceptable. If preferred, inline the one-liner `family = 'ipv6' if d.record_type == 'AAAA' else 'ipv4'` and import only `sync_domain`.)

- [ ] **Step 2: Update tests**

In `test/unit/test_api.py`, existing sync tests set `runtime.public_ip` — update to the new fields. Ensure the state-snapshot test checks for `public_ipv4`/`public_ipv6`. Add:
```python
def test_sync_aaaa_uses_ipv6(tmp_path: Path) -> None:
    """Forced sync of an AAAA record detects and uses the IPv6 address."""
    with _client(tmp_path) as client:
        created: Any = client.post('/api/domains', json={
            'hostname': 'home.example.com', 'provider': 'duckdns', 'record_type': 'AAAA',
            'provider_config': {'token': 'x', 'domain': 'home'},
        }).json()
        with patch(
            'tether_ddns.ip_sources.base.detect_public_ip',
            new=AsyncMock(return_value='2001:db8::9'),
        ), patch(
            'tether_ddns.providers.ddns_providers.duckdns.DuckDNSProvider.update',
            new=AsyncMock(return_value=UpdateResult(success=True, ip='2001:db8::9')),
        ) as upd:
            resp: Any = client.post(f'/api/domains/{created["id"]}/sync')
        assert resp.status_code == 200
        assert upd.await_args is not None
        assert upd.await_args.args[2] == '2001:db8::9'
```
Update `test_state_endpoint_returns_snapshot` to assert `'public_ipv4' in body` (and `public_ipv6`). Update the existing `test_sync_detects_ip_when_unknown` / `503` tests: they use an A record by default, so they exercise the ipv4 path — keep them, just confirm the mock target is still `tether_ddns.ip_sources.base.detect_public_ip` (it is).

- [ ] **Step 3: Verify**

Run: `python -m pytest test/unit/test_api.py -v` → PASS.
Lint: `ruff check`, `flake8`, `mypy tether_ddns/api.py`, `pyright tether_ddns/api.py`. Fix violations.

- [ ] **Step 4: Commit**

```bash
git add tether_ddns/api.py test/unit/test_api.py
git commit -m "feat: dual-stack forced sync picks family by record type"
```

---

## Task 5: Frontend — dual IP pills + types

**Files:**
- Modify: `frontend/src/types.ts`, `frontend/src/App.tsx`
- Test: `frontend/src/useLiveState.test.tsx` (update snapshot fixture)

**Interfaces:**
- `StateSnapshot` replaces `public_ip: string | null` with `public_ipv4: string | null` and `public_ipv6: string | null`.
- Header renders two pills.

- [ ] **Step 1: Update the type**

In `frontend/src/types.ts`, change the `StateSnapshot` interface:
```ts
export interface StateSnapshot { public_ipv4: string | null; public_ipv6: string | null; online: boolean; domains: DomainState[]; settings: Settings; logs: LogEntry[]; }
```

- [ ] **Step 2: Update the header pills**

In `frontend/src/App.tsx`, replace the single `ip-pill` block with two:
```tsx
          <div className="ip-pill" title="Detected public IPv4">
            <span className={`dot${snapshot && !snapshot.online ? ' offline' : ''}`} />
            <span className="label">IPv4</span>
            <span className="val">{snapshot?.public_ipv4 ?? 'N/A'}</span>
          </div>
          <div className="ip-pill" title="Detected public IPv6">
            <span className={`dot${snapshot && !snapshot.online ? ' offline' : ''}`} />
            <span className="label">IPv6</span>
            <span className="val">{snapshot?.public_ipv6 ?? 'N/A'}</span>
          </div>
```

- [ ] **Step 3: Fix the test snapshot fixture**

In `frontend/src/useLiveState.test.tsx` update the `snapshot` fixture object: replace `public_ip: '203.0.113.5'` with `public_ipv4: '203.0.113.5', public_ipv6: '2001:db8::5'`. Keep the state-message assertion (`toEqual(snapshot)`).

- [ ] **Step 4: Verify**

Run: `cd frontend && npx vitest run src/useLiveState.test.tsx` → PASS.
Run: `cd frontend && npx tsc --noEmit` → clean (this will flag any other `public_ip` use — fix them).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/types.ts frontend/src/App.tsx frontend/src/useLiveState.test.tsx
git commit -m "feat: show separate IPv4 and IPv6 pills in the header"
```

---

## Task 6: Frontend — interval units (settings + dashboard)

**Files:**
- Modify: `frontend/src/App.tsx`
- Test: `frontend/src/App.interval.test.tsx` (new, small)

**Interfaces:**
- A pure helper `formatInterval(seconds: number): string` (exported) → `'5m'` for 300, `'1h'` for 3600, `'30m'` for 1800.
- Settings modal converts seconds↔minutes for the chips.

- [ ] **Step 1: Add and use `formatInterval`**

In `frontend/src/App.tsx`, add an exported helper near the top (after imports):
```tsx
export function formatInterval(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  return `${Math.round(seconds / 60)}m`;
}
```
Change the dashboard stat value from:
```tsx
            <div className="stat-value">{settings ? `${settings.check_interval}m` : '—'}</div>
```
to:
```tsx
            <div className="stat-value">{settings ? formatInterval(settings.check_interval) : '—'}</div>
```

- [ ] **Step 2: Convert units in the Settings modal**

In `SettingsModal`, the `interval` state holds **minutes** (chip values). On load, convert seconds→minutes; on save, minutes→seconds.
- In the `useEffect` that seeds from `settings`, change:
```tsx
      setIntervalMinutes(settings.check_interval);
```
to:
```tsx
      setIntervalMinutes(Math.max(1, Math.round(settings.check_interval / 60)));
```
- In the Save `onClick`, change `check_interval: interval` to:
```tsx
              check_interval: interval * 60,
```

- [ ] **Step 3: Write a focused test**

Create `frontend/src/App.interval.test.tsx`:
```tsx
import { describe, it, expect } from 'vitest';
import { formatInterval } from './App';

describe('formatInterval', () => {
  it('formats seconds as minutes', () => {
    expect(formatInterval(300)).toBe('5m');
    expect(formatInterval(1800)).toBe('30m');
  });

  it('formats whole hours as hours', () => {
    expect(formatInterval(3600)).toBe('1h');
  });
});
```

- [ ] **Step 4: Verify**

Run: `cd frontend && npx vitest run src/App.interval.test.tsx` → PASS.
Run: `cd frontend && npx tsc --noEmit` → clean.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/App.tsx frontend/src/App.interval.test.tsx
git commit -m "fix: render interval in minutes/hours; convert settings chips to seconds"
```

---

## Task 7: Frontend — count-badge alignment (CSS)

**Files:**
- Modify: `frontend/src/styles.css`

**Interfaces:** none (visual).

- [ ] **Step 1: Adjust `.section-head`**

The badge should align vertically with the `<h2>` text. The current `align-items: center` combined with a tall button makes the badge look off relative to the heading. Change `.section-head` to align items to the heading and give the badge a matching line box. Replace the `.section-head` rule with:
```css
.section-head {
  display: flex; align-items: baseline; gap: 14px;
  margin: 8px 0 18px;
  flex-wrap: wrap;
}
```
And ensure the button/spacer still sit correctly — the primary button uses its own box; with `align-items: baseline` the badge aligns to the `<h2>` text baseline. If the Add button looks vertically off with `baseline`, instead keep `align-items: center` but wrap the heading + badge in alignment by giving `.count-badge` `align-self: center` and confirming the row height is driven by the heading, not the button. Pick whichever yields the badge visually aligned with the heading text; verify in the browser (see Step 2).

- [ ] **Step 2: Verify visually**

Build and open the app, or use the Playwright/browser tooling to screenshot the Domains and Hooks section headers; confirm the count badge is vertically aligned with the heading text in both. Run: `cd frontend && npm run build` to ensure CSS compiles and the bundle builds.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/styles.css
git commit -m "fix: vertically align section count-badge with heading"
```

---

## Task 8: Full gate + e2e verification

**Files:** none new.

- [ ] **Step 1: Backend gate**

Run: `source .venv/bin/activate && pytest test/ -q` → all pass, coverage ≥ 90, flake8/mypy/pyright/ruff green. Fix anything red (esp. any lingering `public_ip`/single-arg `detect_public_ip` references in tests).

- [ ] **Step 2: Frontend + e2e**

Run: `cd frontend && npx tsc --noEmit && npx vitest run --coverage && npx playwright test` → all pass. Fix anything red (the e2e add-domain flow and log viewer should be unaffected; the header now has two pills).

- [ ] **Step 3: Commit any fixes**

```bash
git add -A
git commit -m "chore: verify dual-stack + dashboard fixes pass full gates"
```

---

## Self-Review Notes

- **Spec coverage:** dual-family sources (T1), runtime dual fields (T2), scheduler 30s split + dual sync + hook cadence (T3), api family-aware sync + snapshot (T4), header dual pills + types (T5), interval units settings+dashboard (T6), count-badge alignment (T7), full verification (T8). All five requested items + the folded hook-cadence change mapped.
- **Type consistency:** `IPFamily`, `detect_public_ip(source, family)`, `set_public_ipv4/6`, `snapshot()` keys `public_ipv4/6`, `_family_for`, `formatInterval` referenced consistently across backend and frontend tasks.
- **Placeholders:** none — each step has concrete code; T3/T7 explicitly instruct the implementer to reconcile with existing tests / verify visually and adjust.
- **Behavior change flagged:** reachability_changed cadence (30s) and ip_changed keying off shared state are called out in T3 and the spec.
