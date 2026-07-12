# Re-verify Domain After Config Change Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a domain's record-affecting config changes, `rebuild()` resets that domain's runtime to `pending` (clearing `ip`) so the next scheduler cycle re-pushes it; unchanged domains keep their runtime, and enable/disable toggles do not force a re-check.

**Architecture:** `RuntimeState` remembers each domain's `DomainConfig` (captured on `rebuild`). On the next `rebuild`, a domain is "unchanged" when `prev.model_copy(update={'enabled': new.enabled}) == new` (Pydantic value equality, ignoring `enabled`, secret-correct). Unchanged domains preserve their `DomainRuntime`; new or changed domains start fresh at `pending`. No other component changes — the scheduler's existing `is_fresh` branch pushes a `pending` domain.

**Tech Stack:** Python 3, Pydantic v2, pytest, pytest-asyncio.

## Global Constraints

- Change detection: `prev.model_copy(update={'enabled': new.enabled}) != new` — compares every field except `enabled`.
- A changed or new domain → `DomainRuntime(id, status='pending')` (default `ip=None`). An unchanged domain → preserve the existing `DomainRuntime`.
- Enable/disable toggle alone must NOT reset a domain.
- Secrets are already resolved to real values by `merge_secrets` before `rebuild` runs; the comparison relies on that (no masked values reach `rebuild`).
- No API, config-format, or frontend changes.
- Python style: `from __future__ import annotations`, single-quoted strings, existing conventions.
- Run `pytest test/unit -q` before each commit.

---

### Task 1: `rebuild()` resets changed domains

**Files:**
- Modify: `tether_ddns/runtime.py`
- Test: `test/unit/test_runtime.py`

**Interfaces:**
- Consumes: `DomainConfig` from `tether_ddns.config`.
- Produces: `RuntimeState._configs: dict[str, DomainConfig]`; `rebuild()` resets new/changed domains and preserves unchanged ones.

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/test_runtime.py`:
```python
def test_rebuild_resets_changed_hostname() -> None:
    """A domain whose hostname changed restarts at pending with ip cleared."""
    cfg = AppConfig(domains=[
        DomainConfig(id='a', hostname='a.example.com', provider='duckdns')])
    state = RuntimeState()
    state.rebuild(cfg)
    state.set_status('a', 'synced', ip='1.2.3.4')
    cfg2 = AppConfig(domains=[
        DomainConfig(id='a', hostname='b.example.com', provider='duckdns')])
    state.rebuild(cfg2)
    assert state.domains['a'].status == 'pending'
    assert state.domains['a'].ip is None


def test_rebuild_resets_changed_provider_config() -> None:
    """A domain whose provider_config changed restarts at pending."""
    cfg = AppConfig(domains=[
        DomainConfig(id='a', hostname='a.example.com', provider='duckdns',
                     provider_config={'token': 'x', 'domain': 'a'})])
    state = RuntimeState()
    state.rebuild(cfg)
    state.set_status('a', 'synced', ip='1.2.3.4')
    cfg2 = AppConfig(domains=[
        DomainConfig(id='a', hostname='a.example.com', provider='duckdns',
                     provider_config={'token': 'y', 'domain': 'a'})])
    state.rebuild(cfg2)
    assert state.domains['a'].status == 'pending'


def test_rebuild_preserves_unchanged_domain() -> None:
    """Rebuilding with identical config preserves status/ip/updated."""
    cfg = AppConfig(domains=[
        DomainConfig(id='a', hostname='a.example.com', provider='duckdns')])
    state = RuntimeState()
    state.rebuild(cfg)
    state.set_status('a', 'synced', ip='1.2.3.4')
    prior_updated = state.domains['a'].updated
    state.rebuild(AppConfig(domains=[
        DomainConfig(id='a', hostname='a.example.com', provider='duckdns')]))
    assert state.domains['a'].status == 'synced'
    assert state.domains['a'].ip == '1.2.3.4'
    assert state.domains['a'].updated == prior_updated


def test_rebuild_enable_toggle_does_not_reset() -> None:
    """Toggling enabled alone must not reset a synced domain."""
    cfg = AppConfig(domains=[
        DomainConfig(id='a', hostname='a.example.com', provider='duckdns',
                     enabled=True)])
    state = RuntimeState()
    state.rebuild(cfg)
    state.set_status('a', 'synced', ip='1.2.3.4')
    state.rebuild(AppConfig(domains=[
        DomainConfig(id='a', hostname='a.example.com', provider='duckdns',
                     enabled=False)]))
    assert state.domains['a'].status == 'synced'
    assert state.domains['a'].ip == '1.2.3.4'
```

(The existing `test_rebuild_preserves_surviving_runtime` from the consistency
fix still holds — the second rebuild there uses identical config for the
surviving id.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest test/unit/test_runtime.py -k "changed or enable_toggle" -v`
Expected: FAIL (current `rebuild` preserves the runtime unconditionally, so a
changed hostname keeps `synced`).

- [ ] **Step 3: Update `tether_ddns/runtime.py`**

Add `DomainConfig` to the config import:
```python
from tether_ddns.config import AppConfig
```
→
```python
from tether_ddns.config import AppConfig, DomainConfig
```

Add the config store in `__init__`:
```python
        self.domains: dict[str, DomainRuntime] = {}
        self._listeners: list[Listener] = []
```
→
```python
        self.domains: dict[str, DomainRuntime] = {}
        self._configs: dict[str, DomainConfig] = {}
        self._listeners: list[Listener] = []
```

Replace `rebuild`:
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
with:
```python
    def rebuild(self, cfg: AppConfig) -> None:
        """Reset domain runtimes from configuration, preserving history.

        A domain that is new, or whose record-affecting config changed, starts
        fresh at 'pending'; an unchanged domain keeps its runtime. The
        enabled flag is excluded from the change comparison.
        """
        previous = self.domains
        prev_configs = self._configs
        self.domains = {}
        self._configs = {}
        for d in cfg.domains:
            prior_runtime = previous.get(d.id)
            prior_config = prev_configs.get(d.id)
            unchanged = (
                prior_runtime is not None
                and prior_config is not None
                and prior_config.model_copy(update={'enabled': d.enabled}) == d)
            self.domains[d.id] = (
                prior_runtime if unchanged
                else DomainRuntime(id=d.id, status='pending'))
            self._configs[d.id] = d
        self._emit()
```

- [ ] **Step 4: Run the runtime tests to verify they pass**

Run: `pytest test/unit/test_runtime.py -q`
Expected: PASS.

- [ ] **Step 5: Run the full unit suite**

Run: `pytest test/unit -q`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add tether_ddns/runtime.py test/unit/test_runtime.py
git commit -m "fix(runtime): re-verify a domain whose config changed"
```

---

### Task 2: Integration test — edited domain re-pushes

**Files:**
- Test: `test/unit/test_scheduler.py`

**Interfaces:**
- Consumes: the `rebuild` change from Task 1; existing `sync_ips`.

- [ ] **Step 1: Write the integration test**

Append to `test/unit/test_scheduler.py` (imports `AppConfig`, `DomainConfig`,
`RuntimeState`, `scheduler`, `load_providers`, `AsyncMock`, `patch`, `pytest`,
and the `_online` helper are already present):
```python
@pytest.mark.asyncio
async def test_edited_domain_repushes_without_ip_change() -> None:
    """Editing a synced domain's hostname forces a re-push next cycle."""
    load_providers()
    domain = DomainConfig(
        id='a', hostname='old.example.com', provider='duckdns',
        provider_config={'token': 'x', 'domain': 'old'})
    cfg = AppConfig(domains=[domain])
    state = RuntimeState()
    state.rebuild(cfg)
    state.online = True
    state.set_public_ipv4('9.9.9.9')
    state.set_status('a', 'synced', ip='9.9.9.9')
    # User edits the hostname; the API mutates cfg and rebuilds.
    cfg.domains[0] = DomainConfig(
        id='a', hostname='new.example.com', provider='duckdns',
        provider_config={'token': 'x', 'domain': 'old'})
    state.rebuild(cfg)
    assert state.domains['a'].status == 'pending'
    sched = scheduler.Scheduler()
    update = AsyncMock(return_value='9.9.9.9')
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
        await sched.sync_ips(cfg, state)
    update.assert_called_once()
    assert state.domains['a'].status == 'synced'
```

Note: `update` returns the IP string per the error-reporting standardization
(providers now return the assigned IP). If that work is not yet merged in this
branch, return `UpdateResult(success=True, ip='9.9.9.9')` instead and import it.

- [ ] **Step 2: Run the test to verify it passes**

Run: `pytest test/unit/test_scheduler.py -k edited_domain_repushes -q`
Expected: PASS (Task 1 makes the edited domain `pending`; `sync_ips` pushes it).

- [ ] **Step 3: Run the full unit suite and lint/type gate**

Run: `pytest test/unit -q`
Expected: PASS.
Run: `pytest test/test_ruff.py test/test_mypy.py test/test_pyright.py test/test_flake8.py -q`
Expected: PASS. Fix any findings inline.

- [ ] **Step 4: Commit**

```bash
git add test/unit/test_scheduler.py
git commit -m "test(scheduler): edited domain re-pushes without an IP change"
```

---

## Self-Review

- **Spec coverage:** `_configs` store + change-detecting `rebuild` with `enabled`
  excluded, reset-to-pending + ip clear, preserve-unchanged (Task 1) ✓;
  end-to-end re-push after edit (Task 2) ✓.
- **Placeholder scan:** every step shows complete code; the `UpdateResult`
  fallback note in Task 2 is conditional on branch ordering, with the exact
  alternative given.
- **Type consistency:** `_configs: dict[str, DomainConfig]`, `rebuild(cfg:
  AppConfig)`, `model_copy(update={'enabled': ...})`, `DomainRuntime(id,
  status='pending')` used consistently.
