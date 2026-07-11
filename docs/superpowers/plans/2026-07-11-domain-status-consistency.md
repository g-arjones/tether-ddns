# Domain Status Consistency Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the domain status badge always reflect freshness (`synced`/`pending`/`error`/`updating`) regardless of auto-update state, by removing the `paused` status, computing freshness for disabled domains, and preserving runtime history across config rebuilds.

**Architecture:** The backend owns freshness. `RuntimeState` drops the `paused` status, gains a `freshness()` helper and a `set_freshness()` method that only toggles `synced`↔`pending` (never clobbering `error`/`updating`), and `rebuild()` preserves runtime for surviving domain ids. The scheduler recomputes disabled domains' freshness instead of skipping them. The frontend stops overriding the badge with `paused` and renders the real status; the play/pause button remains the sole enabled/disabled indicator.

**Tech Stack:** Python 3, Pydantic v2, pytest, pytest-asyncio; React 19 + TypeScript, Vitest + Testing Library.

## Global Constraints

- `Status` becomes `Literal['synced', 'pending', 'error', 'updating']` — `'paused'` is removed entirely.
- Freshness = compare last-known assigned IP (`runtime.ip`) to current public IP for the domain's family: known and equal → `synced`, else `pending`. No network calls, no provider reads.
- `set_freshness()` must NOT overwrite `error` or `updating`.
- Enabled-domain push behavior in `sync_ips` is unchanged; only the disabled branch changes (freshness recompute, never a push).
- `rebuild()` preserves `ip`/`updated`/`status` for domain ids that still exist; brand-new ids start at `pending`.
- No change to persisted config format. No hook changes (separate spec).
- Python style: `from __future__ import annotations`, single-quoted strings, existing noqa conventions. Frontend style: match surrounding TSX.
- Run `pytest test/unit -q` (backend tasks) and `npm test` in `frontend/` (frontend task) before each commit.

---

### Task 1: Runtime freshness model

**Files:**
- Modify: `tether_ddns/runtime.py`
- Test: `test/unit/test_runtime.py`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `Status = Literal['synced', 'pending', 'error', 'updating']` (no `'paused'`).
  - `freshness(assigned_ip: str | None, current_ip: str | None) -> Status` (module-level).
  - `RuntimeState.set_freshness(self, domain_id: str, current_ip: str | None) -> None`.
  - `RuntimeState.rebuild` now preserves surviving runtimes.

- [ ] **Step 1: Update the failing tests**

In `test/unit/test_runtime.py`, replace `test_rebuild_initialises_domain_statuses`:
```python
def test_rebuild_initialises_domain_statuses() -> None:
    """Disabled domains start paused; enabled domains start pending."""
    cfg = AppConfig(
        domains=[
            DomainConfig(id='a', hostname='a.example.com', provider='duckdns', enabled=True),
            DomainConfig(id='b', hostname='b.example.com', provider='duckdns', enabled=False),
        ],
    )
    state = RuntimeState()
    state.rebuild(cfg)
    assert state.domains['a'].status == 'pending'
    assert state.domains['b'].status == 'paused'
```
with:
```python
def test_rebuild_starts_new_domains_pending() -> None:
    """Every brand-new domain starts pending regardless of enabled flag."""
    cfg = AppConfig(
        domains=[
            DomainConfig(id='a', hostname='a.example.com', provider='duckdns', enabled=True),
            DomainConfig(id='b', hostname='b.example.com', provider='duckdns', enabled=False),
        ],
    )
    state = RuntimeState()
    state.rebuild(cfg)
    assert state.domains['a'].status == 'pending'
    assert state.domains['b'].status == 'pending'


def test_rebuild_preserves_surviving_runtime() -> None:
    """A surviving domain keeps its ip/updated/status across rebuild."""
    cfg = AppConfig(domains=[
        DomainConfig(id='a', hostname='a.example.com', provider='duckdns')])
    state = RuntimeState()
    state.rebuild(cfg)
    state.set_status('a', 'synced', ip='1.2.3.4')
    prior_updated = state.domains['a'].updated
    # Simulate a config edit adding a second domain; 'a' must survive intact.
    cfg2 = AppConfig(domains=[
        DomainConfig(id='a', hostname='a.example.com', provider='duckdns'),
        DomainConfig(id='c', hostname='c.example.com', provider='duckdns')])
    state.rebuild(cfg2)
    assert state.domains['a'].status == 'synced'
    assert state.domains['a'].ip == '1.2.3.4'
    assert state.domains['a'].updated == prior_updated
    assert state.domains['c'].status == 'pending'


def test_freshness_matches_current_ip() -> None:
    """freshness() is synced only when assigned equals current and is known."""
    from tether_ddns.runtime import freshness
    assert freshness('1.2.3.4', '1.2.3.4') == 'synced'
    assert freshness('1.2.3.4', '9.9.9.9') == 'pending'
    assert freshness(None, '1.2.3.4') == 'pending'
    assert freshness('1.2.3.4', None) == 'pending'
    assert freshness(None, None) == 'pending'


def test_set_freshness_toggles_synced_pending() -> None:
    """set_freshness flips synced<->pending based on the current IP."""
    cfg = AppConfig(domains=[
        DomainConfig(id='a', hostname='a.example.com', provider='duckdns')])
    state = RuntimeState()
    state.rebuild(cfg)
    state.set_status('a', 'synced', ip='1.2.3.4')
    state.set_freshness('a', '9.9.9.9')
    assert state.domains['a'].status == 'pending'
    state.set_freshness('a', '1.2.3.4')
    assert state.domains['a'].status == 'synced'


def test_set_freshness_preserves_error_and_updating() -> None:
    """set_freshness never overwrites error or updating."""
    cfg = AppConfig(domains=[
        DomainConfig(id='a', hostname='a.example.com', provider='duckdns'),
        DomainConfig(id='b', hostname='b.example.com', provider='duckdns')])
    state = RuntimeState()
    state.rebuild(cfg)
    state.set_status('a', 'error', message='boom')
    state.set_status('b', 'updating')
    state.set_freshness('a', '1.2.3.4')
    state.set_freshness('b', '1.2.3.4')
    assert state.domains['a'].status == 'error'
    assert state.domains['b'].status == 'updating'
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest test/unit/test_runtime.py -q`
Expected: FAIL (`freshness`/`set_freshness` undefined; `test_rebuild_starts_new_domains_pending` asserts `'pending'` for 'b' while code still yields `'paused'`).

- [ ] **Step 3: Update `tether_ddns/runtime.py`**

Change the `Status` alias:
```python
Status = Literal['synced', 'pending', 'error', 'paused', 'updating']
```
to:
```python
Status = Literal['synced', 'pending', 'error', 'updating']
```

Add a module-level `freshness` function immediately after the `Listener` type alias (before `class DomainRuntime`):
```python
def freshness(assigned_ip: str | None, current_ip: str | None) -> Status:
    """Return 'synced' when the assigned IP matches the current public IP."""
    if assigned_ip is not None and assigned_ip == current_ip:
        return 'synced'
    return 'pending'
```

Replace `rebuild`:
```python
    def rebuild(self, cfg: AppConfig) -> None:
        """Reset domain runtimes from configuration."""
        self.domains = {
            d.id: DomainRuntime(id=d.id, status='pending' if d.enabled else 'paused')
            for d in cfg.domains
        }
        self._emit()
```
with:
```python
    def rebuild(self, cfg: AppConfig) -> None:
        """Reset domain runtimes from configuration, preserving history."""
        previous = self.domains
        self.domains = {
            d.id: previous.get(d.id) or DomainRuntime(id=d.id, status='pending')
            for d in cfg.domains
        }
        self._emit()
```

Add `set_freshness` immediately after `set_status`:
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

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest test/unit/test_runtime.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tether_ddns/runtime.py test/unit/test_runtime.py
git commit -m "feat(runtime): freshness model and history-preserving rebuild"
```

---

### Task 2: Scheduler recomputes disabled domains

**Files:**
- Modify: `tether_ddns/scheduler.py`
- Test: `test/unit/test_scheduler.py`

**Interfaces:**
- Consumes: `RuntimeState.set_freshness` from Task 1.
- Produces: `sync_ips` recomputes freshness for disabled domains instead of skipping them.

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/test_scheduler.py` (imports `AppConfig`, `DomainConfig`, `RuntimeState`, `scheduler`, `load_providers`, `AsyncMock`, `patch`, `pytest` are already present in the file):
```python
@pytest.mark.asyncio
async def test_sync_ips_marks_disabled_domain_pending_on_ip_change() -> None:
    """A disabled domain whose assigned IP no longer matches becomes pending."""
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
    update = AsyncMock()
    with patch(
        'tether_ddns.scheduler.ReachabilityService.check',
        new=AsyncMock(return_value=_online(True)),
    ), patch(
        'tether_ddns.scheduler.detect_public_ip',
        new=AsyncMock(return_value='2.2.2.2'),
    ), patch(
        'tether_ddns.providers.ddns_providers.duckdns.DuckDNSProvider.update',
        new=update,
    ):
        await sched.check_once(cfg, state)
    assert state.domains['a'].status == 'pending'
    update.assert_not_called()


@pytest.mark.asyncio
async def test_sync_ips_keeps_disabled_domain_synced_when_matching() -> None:
    """A disabled domain still matching the current IP stays synced."""
    load_providers()
    domain = DomainConfig(
        id='a', hostname='myhost', provider='duckdns',
        provider_config={'token': 'x', 'domain': 'myhost'}, enabled=False)
    cfg = AppConfig(domains=[domain])
    state = RuntimeState()
    state.rebuild(cfg)
    state.online = True
    state.set_status('a', 'synced', ip='9.9.9.9')
    sched = scheduler.Scheduler()
    update = AsyncMock()
    with patch(
        'tether_ddns.scheduler.ReachabilityService.check',
        new=AsyncMock(return_value=_online(True)),
    ), patch(
        'tether_ddns.scheduler.detect_public_ip',
        new=AsyncMock(return_value='9.9.9.9'),
    ), patch(
        'tether_ddns.providers.ddns_providers.duckdns.DuckDNSProvider.update',
        new=update,
    ):
        await sched.check_once(cfg, state)
    assert state.domains['a'].status == 'synced'
    update.assert_not_called()
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest test/unit/test_scheduler.py -k disabled_domain -q`
Expected: FAIL (`status` stays `synced` in the first test because disabled domains are currently skipped, so the IP-change→pending transition never happens).

- [ ] **Step 3: Update `sync_ips` in `tether_ddns/scheduler.py`**

Replace the domain loop:
```python
        for domain in cfg.domains:
            if not domain.enabled:
                continue
            family = _family_for(domain.record_type)
            ip = by_family[family]
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

- [ ] **Step 4: Run the full unit suite to verify it passes**

Run: `pytest test/unit -q`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add tether_ddns/scheduler.py test/unit/test_scheduler.py
git commit -m "feat(scheduler): recompute freshness for disabled domains"
```

---

### Task 3: Frontend renders real status

**Files:**
- Modify: `frontend/src/components/DomainCard.tsx`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/styles.css`
- Test: `frontend/src/components/DomainCard.test.tsx`

**Interfaces:**
- Consumes: backend now emits real status for all domains (Tasks 1-2).
- Produces: badge and stats read `runtime.status` directly; no `paused` override anywhere.

- [ ] **Step 1: Add a failing test**

In `frontend/src/components/DomainCard.test.tsx`, add a second test inside the `describe` block:
```javascript
  it('shows real status for a disabled domain (not Paused)', () => {
    render(<DomainCard
      domain={{ id: 'a', hostname: 'home.example.com', provider: 'duckdns', record_type: 'A', enabled: false }}
      runtime={{ id: 'a', status: 'pending', ip: '1.2.3.4', updated: Date.now() / 1000, message: '' }}
      onSync={vi.fn()} onEdit={vi.fn()} onDelete={vi.fn()} onToggle={vi.fn()} />);
    expect(screen.getByText(/pending/i)).toBeInTheDocument();
    expect(screen.queryByText(/paused/i)).not.toBeInTheDocument();
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from `frontend/`): `npm test -- DomainCard`
Expected: FAIL (badge currently reads `Paused` for a disabled domain).

- [ ] **Step 3: Update `DomainCard.tsx`**

Replace:
```javascript
  const status = domain.enabled ? runtime.status : 'paused';
  const meta = STATUS_META[status] ?? STATUS_META.synced;
```
with:
```javascript
  const status = runtime.status;
  const meta = STATUS_META[status] ?? STATUS_META.synced;
```

Remove the `paused` entry from `STATUS_META`:
```javascript
const STATUS_META: Record<string, { cls: string; label: string }> = {
  synced: { cls: 'st-synced', label: 'Synced' },
  pending: { cls: 'st-pending', label: 'Pending' },
  error: { cls: 'st-error', label: 'Error' },
  paused: { cls: 'st-paused', label: 'Paused' },
  updating: { cls: 'st-updating', label: 'Updating' },
};
```
becomes:
```javascript
const STATUS_META: Record<string, { cls: string; label: string }> = {
  synced: { cls: 'st-synced', label: 'Synced' },
  pending: { cls: 'st-pending', label: 'Pending' },
  error: { cls: 'st-error', label: 'Error' },
  updating: { cls: 'st-updating', label: 'Updating' },
};
```

- [ ] **Step 4: Update the stats calc in `App.tsx`**

Replace:
```javascript
    for (const d of domains) {
      const rt = runtimeById.get(d.id);
      const status = d.enabled ? rt?.status ?? 'pending' : 'paused';
      if (status === 'synced') synced += 1;
      else if (status === 'pending' || status === 'error') pending += 1;
    }
```
with:
```javascript
    for (const d of domains) {
      const rt = runtimeById.get(d.id);
      const status = rt?.status ?? 'pending';
      if (status === 'synced') synced += 1;
      else if (status === 'pending' || status === 'error') pending += 1;
    }
```

- [ ] **Step 5: Remove the `.st-paused` rules from `styles.css`**

Delete these two lines:
```css
.st-paused { background: var(--muted-soft); color: var(--muted-status); }
.st-paused .s-dot { background: var(--muted-status); }
```

- [ ] **Step 6: Run the frontend suite to verify it passes**

Run (from `frontend/`): `npm test`
Expected: PASS (all tests).

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/DomainCard.tsx frontend/src/App.tsx frontend/src/styles.css frontend/src/components/DomainCard.test.tsx
git commit -m "feat(ui): status badge always reflects freshness, not paused"
```

---

### Task 4: Rebuild frontend bundle and static checks

**Files:**
- Modify: `tether_ddns/static/**` (generated), verify `tether_ddns/` and `test/`.

- [ ] **Step 1: Rebuild the frontend production bundle**

Run (from `frontend/`): `npm run build`
Expected: build succeeds; regenerated assets land in `tether_ddns/static/`.

- [ ] **Step 2: Confirm no stale `paused` references remain in source**

Run: `grep -rn "paused\|st-paused" tether_ddns/runtime.py tether_ddns/scheduler.py frontend/src`
Expected: no matches (the generated `tether_ddns/static/` bundle is not source and may be ignored).

- [ ] **Step 3: Run the backend lint/type gate**

Run: `pytest test/test_ruff.py test/test_mypy.py test/test_pyright.py test/test_flake8.py -q`
Expected: PASS. Fix any findings inline and re-run.

- [ ] **Step 4: Run both suites once more**

Run: `pytest test/unit -q`
Expected: PASS.
Run (from `frontend/`): `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: rebuild static bundle for status badge change"
```

---

## Self-Review

- **Spec coverage:** remove `paused` + `freshness()` + `set_freshness()` (Task 1) ✓; history-preserving `rebuild()` (Task 1) ✓; scheduler recomputes disabled domains (Task 2) ✓; frontend renders real status + stats + CSS (Task 3) ✓; bundle rebuild + lint gate (Task 4) ✓.
- **Placeholder scan:** every code step shows complete code; no TBD/TODO.
- **Type consistency:** `Status` union, `freshness(assigned_ip, current_ip)`, `set_freshness(domain_id, current_ip)`, `runtime.status` used consistently across tasks.
