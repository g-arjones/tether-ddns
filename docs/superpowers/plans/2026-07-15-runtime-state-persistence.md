# Runtime State Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist the app's live runtime state (domain statuses, public IPs, change timestamps, reachability history) to a JSON file so it survives restarts.

**Architecture:** Convert `RuntimeState` into a pydantic `BaseModel` so it serializes itself; add a pure-I/O `StateStore` mirroring `ConfigStore`; wire glue through `AppContext.persist_state()`; write on a periodic scheduler job plus a flush folded into `Scheduler.shutdown()`; restore the snapshot before `rebuild()` on startup, fail-soft on any load problem.

**Tech Stack:** Python 3, pydantic v2, FastAPI, APScheduler, pytest.

## Global Constraints

- All gates must stay green: `pytest` including `test/test_ruff.py`, `test/test_mypy.py`, `test/test_pyright.py`, `test/test_flake8.py`.
- Full type annotations on all new functions/methods; strict mypy + pyright compliance.
- Follow existing `ConfigStore` conventions verbatim for path resolution and atomic writes.
- State file is disposable: a missing, corrupt, or schema-incompatible file must NEVER block startup.
- The `reachability_history` deque MUST remain bounded at `REACHABILITY_HISTORY_SIZE` (60) after a restore.
- Persistence payload (`model_dump`) stays decoupled from the frontend payload (`snapshot()`); do not change `snapshot()` output shape.
- Docstrings on all public classes/methods (codebase style: imperative one-liners).

---

### Task 1: Convert `RuntimeState` to a pydantic `BaseModel`

**Files:**
- Modify: `tether_ddns/runtime.py`
- Test: `test/unit/test_runtime.py`

**Interfaces:**
- Consumes: `CheckRecord`, `DomainRuntime`, `REACHABILITY_HISTORY_SIZE` (existing).
- Produces: `RuntimeState` as a `pydantic.BaseModel` with fields:
  - `public_ipv4: str | None = None`, `public_ipv6: str | None = None`
  - `online: bool = False`
  - `domains: dict[str, DomainRuntime] = {}`
  - `reachability_started_at: float` (default_factory `time.time`)
  - `reachability_checks: int = 0`, `reachability_online: int = 0`
  - `reachability_history: deque[CheckRecord]` (default empty bounded deque; validator re-wraps to `maxlen=REACHABILITY_HISTORY_SIZE`)
  - `reachability_latest: list[ResolverProbe] = []` — `Field(exclude=True)`
  - `next_check_at: float | None = None` — `Field(exclude=True)`
  - `ipv4_changed_at: float | None = None`, `ipv6_changed_at: float | None = None`
  - `_listeners: list[Listener]` — `PrivateAttr(default_factory=list)`
  - `_configs: dict[str, DomainConfig]` — `PrivateAttr(default_factory=dict)`
  - All existing methods (`add_listener`, `remove_listener`, `rebuild`, `set_*`, `record_reachability`, `set_freshness`, `snapshot`, `_emit`) unchanged in behavior.
  - Model config: `arbitrary_types_allowed=True` (for `deque`/`ResolverProbe`), assignment validation left OFF (default) so plain attribute assignment in mutators works.

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/test_runtime.py`:

```python
def test_model_dump_excludes_ephemeral_fields() -> None:
    """Persisted payload omits listeners, configs, latest, and next_check_at."""
    state = RuntimeState()
    state.set_next_check_at(123.0)
    dumped = state.model_dump()
    assert 'reachability_latest' not in dumped
    assert 'next_check_at' not in dumped
    assert '_listeners' not in dumped
    assert '_configs' not in dumped
    assert dumped['reachability_started_at'] == state.reachability_started_at


def test_model_round_trip_preserves_persisted_state() -> None:
    """A dumped-then-validated model keeps IPs, domains, and history."""
    state = RuntimeState()
    state.set_public_ipv4('1.2.3.4')
    state.record_reachability(
        ReachabilityResult(online=True, successes=3, total=3, probes=[]))
    payload = state.model_dump()
    restored = RuntimeState.model_validate(payload)
    assert restored.public_ipv4 == '1.2.3.4'
    assert restored.reachability_checks == 1
    assert restored.reachability_online == 1
    assert len(restored.reachability_history) == 1


def test_history_is_bounded_deque_after_validate() -> None:
    """CRITICAL: history round-trips into a deque capped at the history size."""
    state = RuntimeState()
    for _ in range(REACHABILITY_HISTORY_SIZE + 10):
        state.record_reachability(
            ReachabilityResult(online=True, successes=1, total=1, probes=[]))
    restored = RuntimeState.model_validate(state.model_dump())
    assert isinstance(restored.reachability_history, deque)
    assert restored.reachability_history.maxlen == REACHABILITY_HISTORY_SIZE
    # Appending beyond the cap must not grow the buffer.
    for _ in range(20):
        restored.record_reachability(
            ReachabilityResult(online=True, successes=1, total=1, probes=[]))
    assert len(restored.reachability_history) == REACHABILITY_HISTORY_SIZE


def test_listeners_survive_model_construction() -> None:
    """Listeners still fire after the BaseModel conversion."""
    state = RuntimeState()
    seen: list[dict[str, object]] = []
    state.add_listener(seen.append)
    state.set_online(True)
    assert seen and seen[-1]['online'] is True
```

Confirm the `ReachabilityResult` constructor signature matches (`online`, `successes`, `total`, `probes`); adjust the test kwargs if the real signature differs.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pytest test/unit/test_runtime.py::test_model_dump_excludes_ephemeral_fields test/unit/test_runtime.py::test_history_is_bounded_deque_after_validate -v`
Expected: FAIL (`RuntimeState` has no `model_dump` / is not a BaseModel).

- [ ] **Step 3: Rewrite `RuntimeState` as a `BaseModel`**

Replace the `class RuntimeState:` definition and its `__init__` in `tether_ddns/runtime.py`. Add imports at the top: `from pydantic import BaseModel, ConfigDict, Field, PrivateAttr, field_validator`.

```python
class RuntimeState(BaseModel):
    """Holds live application state and notifies listeners of changes."""

    model_config = ConfigDict(arbitrary_types_allowed=True)

    public_ipv4: str | None = None
    public_ipv6: str | None = None
    online: bool = False
    domains: dict[str, DomainRuntime] = Field(default_factory=dict)
    reachability_started_at: float = Field(default_factory=time.time)
    reachability_checks: int = 0
    reachability_online: int = 0
    reachability_history: deque[CheckRecord] = Field(
        default_factory=lambda: deque(maxlen=REACHABILITY_HISTORY_SIZE))
    reachability_latest: list[ResolverProbe] = Field(
        default_factory=list, exclude=True)
    next_check_at: float | None = Field(default=None, exclude=True)
    ipv4_changed_at: float | None = None
    ipv6_changed_at: float | None = None

    _listeners: list[Listener] = PrivateAttr(default_factory=list)
    _configs: dict[str, DomainConfig] = PrivateAttr(default_factory=dict)

    @field_validator('reachability_history', mode='before')
    @classmethod
    def _bound_history(cls, value: object) -> 'deque[CheckRecord]':
        """Re-wrap any incoming sequence into a bounded history deque."""
        if isinstance(value, deque) and value.maxlen == REACHABILITY_HISTORY_SIZE:
            return value
        items = value if isinstance(value, (list, tuple, deque)) else []
        records = [
            v if isinstance(v, CheckRecord) else CheckRecord.model_validate(v)
            for v in items
        ]
        return deque(records, maxlen=REACHABILITY_HISTORY_SIZE)
```

Delete the old `__init__`. Keep every method (`add_listener` through `_emit`) exactly as-is — they operate on `self.<attr>` and work unchanged on a model instance.

- [ ] **Step 4: Run the runtime tests to verify they pass**

Run: `pytest test/unit/test_runtime.py -v`
Expected: PASS (all new + all pre-existing runtime tests).

- [ ] **Step 5: Run type/lint gates**

Run: `pytest test/test_mypy.py test/test_pyright.py test/test_ruff.py test/test_flake8.py -q`
Expected: PASS. If pyright flags the `deque` default or validator return, add precise annotations; do not use `type: ignore` unless mirroring an existing codebase pattern.

- [ ] **Step 6: Commit**

```bash
git add tether_ddns/runtime.py test/unit/test_runtime.py
git commit -m "refactor: make RuntimeState a pydantic BaseModel for serialization"
```

---

### Task 2: Add `RuntimeState.restore()`

**Files:**
- Modify: `tether_ddns/runtime.py`
- Test: `test/unit/test_runtime.py`

**Interfaces:**
- Consumes: `RuntimeState` (BaseModel from Task 1), `AppConfig`, `DomainConfig`.
- Produces: `RuntimeState.restore(self, other: RuntimeState, cfg: AppConfig) -> None` — copies persisted fields from `other` into `self` and seeds `self._configs` from `cfg.domains` so a subsequent `rebuild(cfg)` preserves unchanged domains' restored status.

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/test_runtime.py`:

```python
def test_restore_then_rebuild_preserves_unchanged_domain() -> None:
    """A restored, config-unchanged domain keeps its status through rebuild."""
    cfg = AppConfig(domains=[
        DomainConfig(id='a', hostname='a.example.com', provider='duckdns')])
    saved = RuntimeState()
    saved.rebuild(cfg)
    saved.set_status('a', 'synced', ip='1.2.3.4')

    fresh = RuntimeState()
    restored = RuntimeState.model_validate(saved.model_dump())
    fresh.restore(restored, cfg)
    fresh.rebuild(cfg)
    assert fresh.domains['a'].status == 'synced'
    assert fresh.domains['a'].ip == '1.2.3.4'


def test_restore_then_rebuild_resets_changed_domain() -> None:
    """A domain whose config changed resets to pending after rebuild."""
    cfg = AppConfig(domains=[
        DomainConfig(id='a', hostname='a.example.com', provider='duckdns')])
    saved = RuntimeState()
    saved.rebuild(cfg)
    saved.set_status('a', 'synced', ip='1.2.3.4')

    cfg2 = AppConfig(domains=[
        DomainConfig(id='a', hostname='a.example.com', provider='cloudflare')])
    fresh = RuntimeState()
    fresh.restore(RuntimeState.model_validate(saved.model_dump()), cfg2)
    fresh.rebuild(cfg2)
    assert fresh.domains['a'].status == 'pending'


def test_restore_copies_public_ips_and_history() -> None:
    """Restore brings over IPs, change timestamps, and reachability counters."""
    saved = RuntimeState()
    saved.set_public_ipv4('9.9.9.9')
    saved.record_reachability(
        ReachabilityResult(online=True, successes=2, total=3, probes=[]))
    cfg = AppConfig()
    fresh = RuntimeState()
    fresh.restore(RuntimeState.model_validate(saved.model_dump()), cfg)
    assert fresh.public_ipv4 == '9.9.9.9'
    assert fresh.ipv4_changed_at is not None
    assert fresh.reachability_checks == 1
    assert len(fresh.reachability_history) == 1
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest test/unit/test_runtime.py::test_restore_then_rebuild_preserves_unchanged_domain -v`
Expected: FAIL (`RuntimeState` has no attribute `restore`).

- [ ] **Step 3: Implement `restore()`**

Add this method to `RuntimeState` (place it just before `rebuild`):

```python
    def restore(self, other: 'RuntimeState', cfg: AppConfig) -> None:
        """Load persisted state from ``other`` and seed configs from ``cfg``.

        Copies persisted fields into this instance and populates ``_configs``
        from the current configuration so a following :meth:`rebuild` keeps the
        status of domains whose config is unchanged.
        """
        self.public_ipv4 = other.public_ipv4
        self.public_ipv6 = other.public_ipv6
        self.online = other.online
        self.ipv4_changed_at = other.ipv4_changed_at
        self.ipv6_changed_at = other.ipv6_changed_at
        self.reachability_started_at = other.reachability_started_at
        self.reachability_checks = other.reachability_checks
        self.reachability_online = other.reachability_online
        self.reachability_history = deque(
            other.reachability_history, maxlen=REACHABILITY_HISTORY_SIZE)
        self.domains = dict(other.domains)
        self._configs = {d.id: d for d in cfg.domains}
```

Note: seeding `_configs` from `cfg` (not from `other`) is the Option-A mechanism that makes `rebuild`'s change-detection preserve unchanged restored domains.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest test/unit/test_runtime.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tether_ddns/runtime.py test/unit/test_runtime.py
git commit -m "feat: add RuntimeState.restore for persisted state hydration"
```

---

### Task 3: Create the pure-I/O `StateStore`

**Files:**
- Create: `tether_ddns/state_store.py`
- Test: `test/unit/test_state_store.py`

**Interfaces:**
- Consumes: `RuntimeState` (BaseModel).
- Produces:
  - `StateStore(path: Path | None = None)`; `.path` property; `StateStore.resolve_path() -> Path` (env `TETHER_DDNS_STATE_PATH` else `Path.cwd() / 'tether-ddns.state.json'`).
  - `save(state: RuntimeState) -> None` — atomic write (tempfile + `os.replace`).
  - `load() -> RuntimeState | None` — returns `None` when the file is missing, unreadable, or fails validation (logs a warning on corruption).
  - Module constants: `ENV_VAR = 'TETHER_DDNS_STATE_PATH'`, `DEFAULT_FILENAME = 'tether-ddns.state.json'`.

- [ ] **Step 1: Write the failing tests**

Create `test/unit/test_state_store.py`:

```python
"""Tests for the runtime StateStore."""
import logging
from pathlib import Path

import pytest

from tether_ddns.reachability import ReachabilityResult
from tether_ddns.runtime import RuntimeState
from tether_ddns.state_store import StateStore


def test_resolve_path_uses_env(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """resolve_path honours TETHER_DDNS_STATE_PATH."""
    target = tmp_path / 'state.json'
    monkeypatch.setenv('TETHER_DDNS_STATE_PATH', str(target))
    assert StateStore.resolve_path() == target


def test_resolve_path_falls_back_to_cwd(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Without the env var, the default state file in cwd is used."""
    monkeypatch.delenv('TETHER_DDNS_STATE_PATH', raising=False)
    monkeypatch.chdir(tmp_path)
    assert StateStore.resolve_path() == tmp_path / 'tether-ddns.state.json'


def test_load_missing_returns_none(tmp_path: Path) -> None:
    """Loading a missing state file yields None (fresh start)."""
    store = StateStore(tmp_path / 'nope.json')
    assert store.load() is None


def test_save_then_load_round_trips(tmp_path: Path) -> None:
    """Saved state is read back with IPs and reachability counters intact."""
    store = StateStore(tmp_path / 'state.json')
    state = RuntimeState()
    state.set_public_ipv4('1.2.3.4')
    state.record_reachability(
        ReachabilityResult(online=True, successes=3, total=3, probes=[]))
    store.save(state)
    loaded = store.load()
    assert loaded is not None
    assert loaded.public_ipv4 == '1.2.3.4'
    assert loaded.reachability_checks == 1


def test_load_corrupt_returns_none_and_warns(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """A corrupt state file is discarded fail-soft with a warning."""
    path = tmp_path / 'state.json'
    path.write_text('{ not valid json', encoding='utf-8')
    store = StateStore(path)
    with caplog.at_level(logging.WARNING):
        assert store.load() is None
    assert any(r.levelno >= logging.WARNING for r in caplog.records)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pytest test/unit/test_state_store.py -v`
Expected: FAIL (`tether_ddns.state_store` does not exist).

- [ ] **Step 3: Create `tether_ddns/state_store.py`**

```python
"""JSON-backed persistence for the live runtime state.

The state file is machine-written and fully regenerable, so loading is
fail-soft: a missing, unreadable, or invalid file yields ``None`` and the
application starts with fresh state.
"""
from __future__ import annotations

import logging
import os
import tempfile
from pathlib import Path

from pydantic import ValidationError

from tether_ddns.runtime import RuntimeState

ENV_VAR = 'TETHER_DDNS_STATE_PATH'
DEFAULT_FILENAME = 'tether-ddns.state.json'

logger = logging.getLogger(__name__)


class StateStore:
    """Loads and saves :class:`RuntimeState` as JSON on disk."""

    def __init__(self, path: Path | None = None) -> None:
        """Create a store bound to a path (resolved if omitted)."""
        self._path = path if path is not None else self.resolve_path()

    @property
    def path(self) -> Path:
        """Return the state file path."""
        return self._path

    @staticmethod
    def resolve_path() -> Path:
        """Resolve the state path from the env var or cwd fallback."""
        env = os.environ.get(ENV_VAR)
        return Path(env) if env else Path.cwd() / DEFAULT_FILENAME

    def load(self) -> RuntimeState | None:
        """Load persisted state, or None when absent/corrupt (fail-soft)."""
        if not self._path.exists():
            return None
        try:
            return RuntimeState.model_validate_json(
                self._path.read_text('utf-8'))
        except (OSError, ValidationError, ValueError) as exc:
            logger.warning(
                'Discarding unreadable runtime state at %s: %s',
                self._path, exc)
            return None

    def save(self, state: RuntimeState) -> None:
        """Persist runtime state atomically."""
        self._path.parent.mkdir(parents=True, exist_ok=True)
        data = state.model_dump_json(indent=2)
        fd, tmp = tempfile.mkstemp(dir=self._path.parent, suffix='.tmp')
        try:
            with os.fdopen(fd, 'w', encoding='utf-8') as fh:
                fh.write(data)
            os.replace(tmp, self._path)
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pytest test/unit/test_state_store.py -v`
Expected: PASS.

- [ ] **Step 5: Run type/lint gates**

Run: `pytest test/test_mypy.py test/test_pyright.py test/test_ruff.py test/test_flake8.py -q`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add tether_ddns/state_store.py test/unit/test_state_store.py
git commit -m "feat: add StateStore for fail-soft runtime state persistence"
```

---

### Task 4: Add `state_store` + `persist_state()` to `AppContext`

**Files:**
- Modify: `tether_ddns/context.py`
- Test: `test/unit/test_context.py`

**Interfaces:**
- Consumes: `StateStore` (Task 3), `RuntimeState`.
- Produces: `AppContext` gains field `state_store: StateStore` (added after `store`) and method `persist_state(self) -> None` doing `self.state_store.save(self.runtime)`.
- NOTE: `AppContext` is a `@dataclass`; adding a non-default field changes the positional constructor. All construction sites must pass `state_store` (Task 5 covers `app.py`; tests updated in Tasks 4 & 6).

- [ ] **Step 1: Write the failing test**

Add to `test/unit/test_context.py` (create the file if it does not exist, matching the imports used by other unit tests):

```python
from pathlib import Path

from tether_ddns.config import AppConfig, ConfigStore
from tether_ddns.context import AppContext
from tether_ddns.runtime import RuntimeState
from tether_ddns.state_store import StateStore
from tether_ddns.ws import ConnectionManager


def test_persist_state_writes_runtime(tmp_path: Path) -> None:
    """persist_state saves the current runtime via the state store."""
    runtime = RuntimeState()
    runtime.set_public_ipv4('5.6.7.8')
    state_store = StateStore(tmp_path / 'state.json')
    ctx = AppContext(
        config=AppConfig(),
        runtime=runtime,
        store=ConfigStore(tmp_path / 'cfg.json'),
        state_store=state_store,
        manager=ConnectionManager(),
    )
    ctx.persist_state()
    loaded = state_store.load()
    assert loaded is not None
    assert loaded.public_ipv4 == '5.6.7.8'
```

If `test/unit/test_context.py` already exists, add only the test function and any missing imports.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pytest test/unit/test_context.py::test_persist_state_writes_runtime -v`
Expected: FAIL (`AppContext` has no `state_store` / `persist_state`).

- [ ] **Step 3: Update `AppContext`**

In `tether_ddns/context.py`, add the import and field + method:

```python
from tether_ddns.state_store import StateStore
```

```python
@dataclass
class AppContext:
    """Bundles shared mutable state for controllers and the scheduler."""

    config: AppConfig
    runtime: RuntimeState
    store: ConfigStore
    state_store: StateStore
    manager: ConnectionManager

    def persist(self) -> None:
        """Save the current configuration to disk."""
        self.store.save(self.config)

    def persist_state(self) -> None:
        """Save the current runtime state to disk."""
        self.state_store.save(self.runtime)

    def rebuild(self) -> None:
        """Persist configuration, then rebuild runtime from it."""
        self.persist()
        self.runtime.rebuild(self.config)
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pytest test/unit/test_context.py -v`
Expected: PASS.

- [ ] **Step 5: Fix every other `AppContext(...)` construction site**

Adding a non-default field breaks all positional callers. Update each to insert `state_store` in the 4th position (between `store` and `manager`). Known sites:

- `tether_ddns/app.py:50` — handled in Task 5 (leave for now; suite may be red until then, so run the targeted test in Step 4 rather than the full suite here).
- `test/unit/test_context.py:15` — existing helper returns a tuple:
  ```python
  return AppContext(cfg, runtime, store, manager), store, manager
  ```
  becomes (add `from tether_ddns.state_store import StateStore` and a tmp/mocked store):
  ```python
  return AppContext(cfg, runtime, store, MagicMock(), manager), store, manager
  ```
  Use `MagicMock()` for `state_store` here since this helper's callers don't persist; import `from unittest.mock import MagicMock` if not already present.
- `test/unit/test_event_from_context.py:12`:
  ```python
  return AppContext(cfg, runtime, store=None, manager=None)  # type: ignore[arg-type]
  ```
  becomes:
  ```python
  return AppContext(cfg, runtime, store=None, state_store=None, manager=None)  # type: ignore[arg-type]
  ```
- `test/unit/test_sync_service.py:16`:
  ```python
  ctx = AppContext(cfg, state, MagicMock(), MagicMock())
  ```
  becomes:
  ```python
  ctx = AppContext(cfg, state, MagicMock(), MagicMock(), MagicMock())
  ```
- `test/unit/test_dispatch_service.py:15`:
  ```python
  return AppContext(cfg, RuntimeState(), MagicMock(), MagicMock())
  ```
  becomes:
  ```python
  return AppContext(cfg, RuntimeState(), MagicMock(), MagicMock(), MagicMock())
  ```
- `test/unit/test_scheduler.py:24` — handled in Task 6 Step 1.

- [ ] **Step 6: Run the affected test modules**

Run: `pytest test/unit/test_context.py test/unit/test_event_from_context.py test/unit/test_sync_service.py test/unit/test_dispatch_service.py -v`
Expected: PASS. (`test_scheduler.py` and the app are fixed in Tasks 6 and 5.)

- [ ] **Step 7: Commit**

```bash
git add tether_ddns/context.py test/unit/test_context.py test/unit/test_event_from_context.py test/unit/test_sync_service.py test/unit/test_dispatch_service.py
git commit -m "feat: add state_store and persist_state to AppContext"
```

---

### Task 5: Wire startup restore + injectable `StateStore` in `app.py`

**Files:**
- Modify: `tether_ddns/app.py`
- Test: `test/unit/test_main.py` (or `test/unit/test_app.py` — use whichever already exercises `create_app`)

**Interfaces:**
- Consumes: `StateStore` (Task 3), `AppContext` with `state_store` (Task 4), `RuntimeState.restore` (Task 2).
- Produces: `create_app(store: ConfigStore | None = None, state_store: StateStore | None = None) -> FastAPI`. Lifespan: build `resolved_state_store`; after `runtime = RuntimeState()`, load snapshot and `runtime.restore(snapshot, config)` if non-None, BEFORE `runtime.rebuild(config)`; pass `state_store` into `AppContext`; expose `app.state.state_store`.

- [ ] **Step 1: Write the failing test**

Add to the test module that constructs the app (e.g. `test/unit/test_main.py`). Use FastAPI's `TestClient` as a context manager so the lifespan runs:

```python
def test_restores_domain_status_on_startup(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A persisted synced domain is restored (not reset to pending) on boot."""
    from fastapi.testclient import TestClient

    from tether_ddns.app import create_app
    from tether_ddns.config import AppConfig, ConfigStore, DomainConfig
    from tether_ddns.runtime import RuntimeState
    from tether_ddns.state_store import StateStore

    cfg_path = tmp_path / 'cfg.json'
    state_path = tmp_path / 'state.json'
    config = AppConfig(domains=[
        DomainConfig(id='a', hostname='a.example.com', provider='duckdns')])
    ConfigStore(cfg_path).save(config)

    # Pre-seed a persisted synced state for domain 'a'.
    seeded = RuntimeState()
    seeded.rebuild(config)
    seeded.set_status('a', 'synced', ip='1.2.3.4')
    StateStore(state_path).save(seeded)

    store = ConfigStore(cfg_path)
    state_store = StateStore(state_path)
    # Avoid real network checks on startup.
    monkeypatch.setattr(
        'tether_ddns.config.AppSettings.update_on_startup', False, raising=False)
    app = create_app(store=store, state_store=state_store)
    with TestClient(app):
        runtime = app.state.runtime
        assert runtime.domains['a'].status == 'synced'
        assert runtime.domains['a'].ip == '1.2.3.4'
```

Adjust the `update_on_startup` suppression to match how existing app tests disable the startup check (check neighbours in the same file and copy their approach). The key assertion is that status is `synced`, not `pending`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pytest test/unit/test_main.py::test_restores_domain_status_on_startup -v`
Expected: FAIL (`create_app` has no `state_store` param / domain resets to `pending`).

- [ ] **Step 3: Update `create_app`**

In `tether_ddns/app.py`:

```python
from tether_ddns.state_store import StateStore
```

```python
def create_app(
    store: ConfigStore | None = None,
    state_store: StateStore | None = None,
) -> FastAPI:
    """Create the configured FastAPI application."""
    resolved_store = store if store is not None else ConfigStore()
    resolved_state_store = (
        state_store if state_store is not None else StateStore())
```

Inside the lifespan, change the runtime setup block:

```python
        config = resolved_store.load()
        runtime = RuntimeState()
        persisted = resolved_state_store.load()
        if persisted is not None:
            runtime.restore(persisted, config)
        runtime.rebuild(config)
        manager = ConnectionManager()
        handler.add_listener(lambda rec: manager.sync_broadcast('log', rec))
        runtime.add_listener(lambda snap: manager.sync_broadcast('state', snap))
        ctx = AppContext(config, runtime, resolved_store, resolved_state_store, manager)
```

Add to the `app.state` assignments:

```python
        app.state.state_store = resolved_state_store
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pytest test/unit/test_main.py -v`
Expected: PASS.

- [ ] **Step 5: Run the full suite to catch broken construction sites**

Run: `pytest -q`
Expected: PASS. Any failure from `AppContext(...)` missing `state_store` reveals a construction site to fix (Task 6 covers scheduler tests; fix any others by passing a tmp-path `StateStore`).

- [ ] **Step 6: Commit**

```bash
git add tether_ddns/app.py test/unit/test_main.py
git commit -m "feat: restore persisted runtime state on startup"
```

---

### Task 6: Scheduler periodic flush + flush on shutdown

**Files:**
- Modify: `tether_ddns/scheduler.py`
- Test: `test/unit/test_scheduler.py`

**Interfaces:**
- Consumes: `AppContext.persist_state()` (Task 4).
- Produces:
  - Module constant `STATE_FLUSH_INTERVAL_SECONDS = 30`.
  - `Scheduler.flush_state(self) -> None` calling `self._ctx.persist_state()`.
  - `start()` registers an interval job `id='state-flush'` calling `self.flush_state`.
  - `shutdown()` calls `self._ctx.persist_state()` FIRST, then stops the scheduler.

- [ ] **Step 1: Update the existing `_ctx` helper and write the failing tests**

`test/unit/test_scheduler.py` currently builds the context with a positional helper:

```python
def _ctx(cfg: AppConfig, state: RuntimeState) -> AppContext:
    """Build an AppContext for dispatch tests."""
    return AppContext(cfg, state, MagicMock(), MagicMock())
```

Adding the `state_store` field (Task 4) shifts `manager` to the 5th position, so this helper is now missing an argument. It is shared by `_disp` and `_sched`, so update it to build (and expose) a real tmp-path `StateStore`. Add `from pathlib import Path` and `from tether_ddns.state_store import StateStore` to the imports, and change the helper to accept an optional path:

```python
def _ctx(
    cfg: AppConfig, state: RuntimeState, state_store: StateStore | None = None,
) -> AppContext:
    """Build an AppContext for dispatch tests."""
    store = state_store if state_store is not None else MagicMock()
    return AppContext(cfg, state, MagicMock(), store, MagicMock())
```

Existing callers pass no `state_store`, so they get a `MagicMock()` — harmless for tests that never persist. Now add the two flush tests (which DO pass a real store):

```python
def test_shutdown_flushes_state(tmp_path: Path) -> None:
    """shutdown persists runtime state before stopping the scheduler."""
    cfg = AppConfig()
    state = RuntimeState()
    state.set_public_ipv4('4.3.2.1')
    ss = StateStore(tmp_path / 'state.json')
    ctx = _ctx(cfg, state, ss)
    sched = scheduler.Scheduler(
        ctx, SyncService(ctx, AsyncMock()), AsyncMock(), ReachabilityProbe())
    sched.shutdown()
    loaded = ss.load()
    assert loaded is not None
    assert loaded.public_ipv4 == '4.3.2.1'


def test_flush_state_writes(tmp_path: Path) -> None:
    """flush_state persists the current runtime snapshot."""
    cfg = AppConfig()
    state = RuntimeState()
    state.set_public_ipv6('2001:db8::1')
    ss = StateStore(tmp_path / 'state.json')
    ctx = _ctx(cfg, state, ss)
    sched = scheduler.Scheduler(
        ctx, SyncService(ctx, AsyncMock()), AsyncMock(), ReachabilityProbe())
    sched.flush_state()
    loaded = ss.load()
    assert loaded is not None
    assert loaded.public_ipv6 == '2001:db8::1'
```

Do NOT call `sched.start()` in these tests (avoids a live event loop); exercise `flush_state`/`shutdown` directly. `shutdown()` is safe on an unstarted scheduler because it guards on `self._scheduler.running`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pytest test/unit/test_scheduler.py::test_shutdown_flushes_state test/unit/test_scheduler.py::test_flush_state_writes -v`
Expected: FAIL (`flush_state` missing; `shutdown` does not persist).

- [ ] **Step 3: Update `scheduler.py`**

Add the constant near `REACHABILITY_INTERVAL_SECONDS`:

```python
STATE_FLUSH_INTERVAL_SECONDS = 30
```

In `start()`, after the existing job registrations and before `self._scheduler.start()`:

```python
        self._scheduler.add_job(  # pyright: ignore[reportUnknownMemberType]
            self.flush_state, 'interval',
            seconds=STATE_FLUSH_INTERVAL_SECONDS,
            args=[], id='state-flush', replace_existing=True,
        )
```

Add the method (place it near `sync_ips`):

```python
    def flush_state(self) -> None:
        """Persist the current runtime state to disk."""
        self._ctx.persist_state()
```

Update `shutdown()` to flush first:

```python
    def shutdown(self) -> None:
        """Flush runtime state, then stop the scheduler."""
        self._ctx.persist_state()
        if self._scheduler.running:
            self._scheduler.shutdown(wait=False)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pytest test/unit/test_scheduler.py -v`
Expected: PASS.

- [ ] **Step 5: Run type/lint gates**

Run: `pytest test/test_mypy.py test/test_pyright.py test/test_ruff.py test/test_flake8.py -q`
Expected: PASS. `flush_state` is registered as an APScheduler job — if pyright wants the same `reportUnknownMemberType` ignore as the sibling `add_job` calls, mirror it.

- [ ] **Step 6: Commit**

```bash
git add tether_ddns/scheduler.py test/unit/test_scheduler.py
git commit -m "feat: flush runtime state periodically and on shutdown"
```

---

### Task 7: Full-suite verification + manual smoke

**Files:** none (verification only).

- [ ] **Step 1: Run the entire test suite and all gates**

Run: `pytest -q`
Expected: PASS (all unit tests + `test_ruff`, `test_mypy`, `test_pyright`, `test_flake8`).

- [ ] **Step 2: Manual smoke test**

```bash
# In a scratch dir so the real config/state files are untouched:
export TETHER_DDNS_CONFIG_PATH=/tmp/td-smoke/config.json
export TETHER_DDNS_STATE_PATH=/tmp/td-smoke/state.json
mkdir -p /tmp/td-smoke
# Start the app, add/sync a domain until it shows 'synced', then stop (Ctrl-C).
python -m tether_ddns
# Confirm the state file was written:
cat /tmp/td-smoke/state.json
# Restart and confirm the domain shows 'synced' (not 'pending') in the UI/API:
python -m tether_ddns
```

Expected: `state.json` exists after first run; after restart the previously-synced domain shows `synced` and reachability history/`*_changed_at` are retained.

- [ ] **Step 3: Fail-soft check**

```bash
echo 'garbage{' > /tmp/td-smoke/state.json
python -m tether_ddns   # must start cleanly, logging a warning, domain 'pending'
```

Expected: app boots without error; a warning about discarding unreadable state is logged.

- [ ] **Step 4: Final commit (if any docs/cleanup changed)**

```bash
git add -A
git commit -m "chore: runtime state persistence verification" || true
```

---

## Self-Review

**Spec coverage:**
- BaseModel conversion (no separate snapshot) → Task 1.
- deque `maxlen` round-trip (critical) → Task 1 Step 1 (`test_history_is_bounded_deque_after_validate`) + validator in Step 3.
- Excluded fields (`_listeners`, `_configs`, `reachability_latest`, `next_check_at`) → Task 1 (`PrivateAttr` / `Field(exclude=True)`), asserted in `test_model_dump_excludes_ephemeral_fields`.
- `restore()` before `rebuild()` + seed `_configs` (Option A) → Task 2.
- Pure `StateStore` mirroring `ConfigStore` + fail-soft load (Option A) → Task 3.
- `AppContext.persist_state()` glue → Task 4.
- Startup restore + injectable store → Task 5.
- Option-3 cadence (periodic job + shutdown flush, flush-first) → Task 6.
- Trust-as-is restored state (Option A) → no reconciliation code added; verified by Task 5's `synced` assertion and Task 7 smoke.
- Verification + fail-soft smoke → Task 7.

**Placeholder scan:** No TBD/TODO; every code step contains full code. Test helper `_make_scheduler` in Task 6 is explicitly described with a fallback construction if absent.

**Type consistency:** `StateStore.save(state: RuntimeState)`, `load() -> RuntimeState | None`, `AppContext.persist_state()`, `Scheduler.flush_state()`, `RuntimeState.restore(other, cfg)`, `create_app(store, state_store)` — names/signatures match across all consuming tasks.

**Note for implementer:** Verify the real `ReachabilityResult` constructor kwargs (`online`, `successes`, `total`, `probes`) before running Task 1/3 tests; adjust test construction to the actual signature if it differs. Likewise confirm how existing app tests disable the startup check and mirror that in Task 5.
