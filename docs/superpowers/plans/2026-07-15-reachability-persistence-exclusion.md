# Reachability-Series Persistence Exclusion + Write-If-Changed Flush Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop persisting the reachability telemetry time-series (so uptime% stays a since-boot metric) and skip redundant state-file writes when nothing persisted has changed.

**Architecture:** Mark the four reachability telemetry fields `Field(exclude=True)` on `RuntimeState` (they stay live in memory and in `snapshot()`), and add a last-written-payload memo + write-if-changed guard in the scheduler's flush path (Option D — no dirty flag, no listener, no mutator changes).

**Tech Stack:** Python 3, pydantic v2, APScheduler, pytest.

## Global Constraints

- All gates must stay green: `pytest` including `test/test_ruff.py`, `test/test_mypy.py`, `test/test_pyright.py`, `test/test_flake8.py`.
- Full type annotations; strict mypy + pyright compliance. No `type: ignore` unless mirroring an existing pattern in the file.
- The frontend `snapshot()` output shape MUST stay identical — it still emits the full `reachability` block (`started_at`, `checks`, `online`, `history`, `latest`).
- `online`, `public_ipv4/6`, `ipv4/ipv6_changed_at`, and `domains` MUST remain persisted.
- The four reachability telemetry fields (`reachability_started_at`, `reachability_checks`, `reachability_online`, `reachability_history`) MUST be excluded from `model_dump()`.
- Each excluded reachability field carries an inline comment stating why (rationale documented in code, per the design).
- Write-if-changed comparison uses the exact serialized payload that would be written (`model_dump_json()`), so the guard matches what `save()` persists.
- Docstrings on all public methods (imperative one-liners, matching existing style).

---

### Task 1: Exclude the reachability telemetry series from persistence

**Files:**
- Modify: `tether_ddns/runtime.py`
- Test: `test/unit/test_runtime.py`

**Interfaces:**
- Consumes: existing `RuntimeState` BaseModel fields.
- Produces: `reachability_started_at`, `reachability_checks`, `reachability_online`, `reachability_history` all carry `exclude=True`. No signature or method-behavior changes. `snapshot()` unchanged.

- [ ] **Step 1: Write/extend the failing tests**

In `test/unit/test_runtime.py`, replace `test_model_dump_excludes_ephemeral_fields` with the expanded version below and add the two new tests:

```python
def test_model_dump_excludes_ephemeral_and_reachability_series() -> None:
    """Persisted payload omits ephemerals and the reachability telemetry series."""
    state = RuntimeState()
    state.set_next_check_at(123.0)
    state.set_public_ipv4('1.2.3.4')
    state.record_reachability(
        ReachabilityResult(online=True, successes=3, total=3, probes=[]))
    dumped = state.model_dump()
    # Ephemeral / derived (pre-existing exclusions).
    assert 'reachability_latest' not in dumped
    assert 'next_check_at' not in dumped
    assert '_listeners' not in dumped
    assert '_configs' not in dumped
    # Reachability telemetry series (newly excluded).
    assert 'reachability_started_at' not in dumped
    assert 'reachability_checks' not in dumped
    assert 'reachability_online' not in dumped
    assert 'reachability_history' not in dumped
    # Still persisted.
    assert dumped['public_ipv4'] == '1.2.3.4'
    assert dumped['online'] is True
    assert 'ipv4_changed_at' in dumped
    assert 'domains' in dumped


def test_snapshot_still_emits_full_reachability_block() -> None:
    """snapshot() (the frontend payload) keeps the whole reachability block."""
    state = RuntimeState()
    state.record_reachability(
        ReachabilityResult(online=True, successes=3, total=3, probes=[]))
    snap = state.snapshot()
    reach = snap['reachability']
    assert isinstance(reach, dict)
    assert set(reach) == {'started_at', 'checks', 'online', 'history', 'latest'}
    assert reach['checks'] == 1


def test_round_trip_drops_series_keeps_status() -> None:
    """After a dump/validate round-trip the series is reset but status survives."""
    state = RuntimeState()
    state.set_public_ipv4('9.9.9.9')
    state.set_online(True)
    for _ in range(5):
        state.record_reachability(
            ReachabilityResult(online=True, successes=3, total=3, probes=[]))
    restored = RuntimeState.model_validate(state.model_dump())
    # Series rebuilds from empty.
    assert restored.reachability_checks == 0
    assert restored.reachability_online == 0
    assert len(restored.reachability_history) == 0
    # Meaningful status survives.
    assert restored.public_ipv4 == '9.9.9.9'
    assert restored.online is True
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pytest test/unit/test_runtime.py::test_model_dump_excludes_ephemeral_and_reachability_series test/unit/test_runtime.py::test_round_trip_drops_series_keeps_status -v`
Expected: FAIL (the four reachability fields are still present in `model_dump()`; counters are non-zero after round-trip).

- [ ] **Step 3: Add `exclude=True` + rationale comment to the four fields**

In `tether_ddns/runtime.py`, replace the four reachability field declarations with the commented, excluded versions. Locate the current block:

```python
    reachability_started_at: float = Field(default_factory=time.time)
    reachability_checks: int = 0
    reachability_online: int = 0
    reachability_history: deque[CheckRecord] = Field(
        default_factory=lambda: deque(maxlen=REACHABILITY_HISTORY_SIZE))
    reachability_latest: list[ResolverProbe] = Field(
        default_factory=list[ResolverProbe], exclude=True)
```

Replace it with:

```python
    # Reachability telemetry is deliberately NOT persisted. It is a live,
    # per-check time-series that turns over every ~30 min, so persisting it
    # (a) rewrites the state file on every 30 s check and (b) would turn the
    # since-boot uptime% (online / checks) into a meaningless all-time figure
    # across restarts. These stay in memory and in snapshot() for the live UI;
    # the sparkline and uptime% intentionally rebuild after a restart.
    reachability_started_at: float = Field(default_factory=time.time, exclude=True)
    reachability_checks: int = Field(default=0, exclude=True)
    reachability_online: int = Field(default=0, exclude=True)
    reachability_history: deque[CheckRecord] = Field(
        default_factory=lambda: deque(maxlen=REACHABILITY_HISTORY_SIZE),
        exclude=True)
    reachability_latest: list[ResolverProbe] = Field(
        default_factory=list[ResolverProbe], exclude=True)
```

Do NOT change `next_check_at`, `_listeners`, `_configs`, `snapshot()`, `restore()`, or any mutator.

Note on `restore()`: it currently copies `reachability_started_at/checks/online/history` from the loaded model. After exclusion those load as defaults (empty/zero), so `restore()` will copy defaults — harmless and correct (the series rebuilds). No change required, but confirm the round-trip test passes.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pytest test/unit/test_runtime.py -v`
Expected: PASS (all runtime tests, including the pre-existing bounded-deque and restore tests).

- [ ] **Step 5: Run type/lint gates**

Run: `pytest test/test_mypy.py test/test_pyright.py test/test_ruff.py test/test_flake8.py -q`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add tether_ddns/runtime.py test/unit/test_runtime.py
git commit -m "feat: exclude reachability telemetry series from persistence"
```

---

### Task 2: Write-if-changed guard in the scheduler flush path

**Files:**
- Modify: `tether_ddns/scheduler.py`
- Test: `test/unit/test_scheduler.py`

**Interfaces:**
- Consumes: `AppContext.persist_state()`, `RuntimeState.model_dump_json()`.
- Produces:
  - `Scheduler.__init__` initializes `self._last_state_json: str | None = None`.
  - `Scheduler.flush_state()` serializes `self._ctx.runtime.model_dump_json()`, compares to `self._last_state_json`, and only when different calls `self._ctx.persist_state()` and updates the memo. Unchanged payloads perform no disk write.
  - `Scheduler.shutdown()` routes its final flush through `self.flush_state()` (so the guard and memo apply), then stops the scheduler.

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/test_scheduler.py` (imports `StateStore`, `Path`, `ReachabilityResult`, `AsyncMock` already exist per the persistence work; the `_ctx` helper accepts an optional `state_store`). Use a real `StateStore` on `tmp_path` and count writes by patching `save`:

```python
def test_flush_state_skips_write_when_unchanged(tmp_path: Path) -> None:
    """A second flush with no state change performs no additional save."""
    cfg = AppConfig()
    state = RuntimeState()
    state.set_public_ipv4('1.2.3.4')
    ss = StateStore(tmp_path / 'state.json')
    ctx = _ctx(cfg, state, ss)
    sched = scheduler.Scheduler(
        ctx, SyncService(ctx, AsyncMock()), AsyncMock(), ReachabilityProbe())
    with patch.object(ss, 'save', wraps=ss.save) as save:
        sched.flush_state()
        sched.flush_state()
    assert save.call_count == 1


def test_flush_state_writes_again_after_real_change(tmp_path: Path) -> None:
    """A persisted-field change between flushes triggers another save."""
    cfg = AppConfig(domains=[
        DomainConfig(id='a', hostname='a.example.com', provider='duckdns')])
    state = RuntimeState()
    state.rebuild(cfg)
    ss = StateStore(tmp_path / 'state.json')
    ctx = _ctx(cfg, state, ss)
    sched = scheduler.Scheduler(
        ctx, SyncService(ctx, AsyncMock()), AsyncMock(), ReachabilityProbe())
    with patch.object(ss, 'save', wraps=ss.save) as save:
        sched.flush_state()
        state.set_status('a', 'synced', ip='1.2.3.4')
        sched.flush_state()
    assert save.call_count == 2


def test_flush_state_ignores_reachability_ticks(tmp_path: Path) -> None:
    """record_reachability between flushes does not cause a second save."""
    cfg = AppConfig()
    state = RuntimeState()
    ss = StateStore(tmp_path / 'state.json')
    ctx = _ctx(cfg, state, ss)
    sched = scheduler.Scheduler(
        ctx, SyncService(ctx, AsyncMock()), AsyncMock(), ReachabilityProbe())
    with patch.object(ss, 'save', wraps=ss.save) as save:
        sched.flush_state()
        state.record_reachability(
            ReachabilityResult(online=False, successes=0, total=3, probes=[]))
        sched.flush_state()
    # online flips False->False here (starts False); history/counters excluded,
    # so the persisted payload is unchanged and no second save occurs.
    assert save.call_count == 1
```

Note for the third test: `record_reachability` with `online=False` when state starts `online=False` leaves the persisted `online` field unchanged, and the telemetry fields are excluded — so the payload is identical. (A genuine online transition legitimately changes `online` and would save; that is correct behavior, not what this test targets.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pytest test/unit/test_scheduler.py::test_flush_state_skips_write_when_unchanged -v`
Expected: FAIL (`flush_state` currently saves unconditionally → `call_count == 2`).

- [ ] **Step 3: Add the memo + guard to the scheduler**

In `tether_ddns/scheduler.py`, add the memo field in `__init__`. Locate:

```python
        self._scheduler = AsyncIOScheduler()
        self._ctx = ctx
        self._sync = sync
        self._dispatch = dispatch
        self._reachability = reachability
```

Append after `self._reachability = reachability`:

```python
        self._last_state_json: str | None = None
```

Replace the current `flush_state` method:

```python
    def flush_state(self) -> None:
        """Persist the current runtime state to disk."""
        self._ctx.persist_state()
```

with the write-if-changed version:

```python
    def flush_state(self) -> None:
        """Persist runtime state to disk only when the payload has changed.

        Skips redundant writes: the reachability telemetry is excluded from the
        persisted model, so a plain reachability tick produces an identical
        payload and no disk write.
        """
        payload = self._ctx.runtime.model_dump_json()
        if payload == self._last_state_json:
            return
        self._ctx.persist_state()
        self._last_state_json = payload
```

Replace the current `shutdown` method:

```python
    def shutdown(self) -> None:
        """Flush runtime state, then stop the scheduler."""
        self._ctx.persist_state()
        if self._scheduler.running:
            self._scheduler.shutdown(wait=False)
```

with one that routes through the guard:

```python
    def shutdown(self) -> None:
        """Flush runtime state (if changed), then stop the scheduler."""
        self.flush_state()
        if self._scheduler.running:
            self._scheduler.shutdown(wait=False)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pytest test/unit/test_scheduler.py -v`
Expected: PASS. The pre-existing `test_shutdown_flushes_state` and `test_flush_state_writes` still pass (first flush always writes because the memo starts `None`).

- [ ] **Step 5: Run type/lint gates**

Run: `pytest test/test_mypy.py test/test_pyright.py test/test_ruff.py test/test_flake8.py -q`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add tether_ddns/scheduler.py test/unit/test_scheduler.py
git commit -m "feat: skip redundant state writes with a write-if-changed flush guard"
```

---

### Task 3: Update the persistence spec + full verification

**Files:**
- Modify: `docs/superpowers/specs/2026-07-15-runtime-state-persistence-design.md`

- [ ] **Step 1: Move the reachability series into "excluded" in the original spec**

In `docs/superpowers/specs/2026-07-15-runtime-state-persistence-design.md`, find the "Persisted vs. excluded state" section. Move `reachability_started_at`, `reachability_checks`, `reachability_online`, and `reachability_history` from the **Persisted** list to the **Excluded** list, and add a one-line note:

```
Note: the reachability telemetry series was moved to Excluded in the follow-up
design `2026-07-15-reachability-persistence-exclusion-design.md` (uptime% window
+ disk-churn fix). `online` remains persisted.
```

Keep `online`, `public_ipv4/6`, `ipv4/ipv6_changed_at`, and `domains` in Persisted.

- [ ] **Step 2: Run the full suite and all gates**

Run: `pytest -q`
Expected: PASS (all unit tests + `test_ruff`, `test_mypy`, `test_pyright`, `test_flake8`).

- [ ] **Step 3: Manual write-suppression smoke**

```bash
export TETHER_DDNS_STATE_PATH=/tmp/td-smoke2/state.json
export TETHER_DDNS_CONFIG_PATH=/tmp/td-smoke2/config.json
mkdir -p /tmp/td-smoke2
# Start the daemon; note the state file mtime; leave it idle > 90s (≥ 3 checks).
python -m tether_ddns &
sleep 5; stat -c '%Y' /tmp/td-smoke2/state.json   # record mtime
sleep 90; stat -c '%Y' /tmp/td-smoke2/state.json  # unchanged if idle+reachable
# Then trigger a domain status change via the UI/API and confirm mtime advances.
kill %1
```

Expected: the state file mtime does NOT advance across idle reachability ticks; it advances after a real domain/IP/online-transition change and on shutdown (first flush of a session always writes).

- [ ] **Step 4: Commit the doc update**

```bash
git add docs/superpowers/specs/2026-07-15-runtime-state-persistence-design.md
git commit -m "docs: mark reachability series as excluded in persistence spec"
```

---

## Self-Review

**Spec coverage:**
- Exclude the four reachability telemetry fields → Task 1 (`exclude=True` + rationale comment).
- Frontend `snapshot()` unchanged → Task 1 `test_snapshot_still_emits_full_reachability_block`.
- `online` stays persisted → Task 1 `test_model_dump_excludes_ephemeral_and_reachability_series` asserts `dumped['online'] is True`.
- Write-if-changed via content comparison (Option D), no dirty flag/listener → Task 2.
- Comparison uses the exact serialized payload (`model_dump_json`) → Task 2 Step 3.
- Shutdown flush routed through the guard → Task 2 Step 3 `shutdown()`.
- Reachability tick does not trigger a write → Task 2 `test_flush_state_ignores_reachability_ticks`.
- Inline documentation of exclusions → Task 1 comment block; guard comment in Task 2.
- Update persisted-vs-excluded in the original spec → Task 3.

**Placeholder scan:** No TBD/TODO; every code step has full code.

**Type consistency:** `flush_state()` and `shutdown()` signatures unchanged; new `self._last_state_json: str | None`; `model_dump_json() -> str` compared to `str | None`. Test helper `_ctx(cfg, state, state_store=None)` matches the signature established in the persistence work.

**Note for implementer:** confirm `_ctx` in `test/unit/test_scheduler.py` already accepts an optional `state_store` (added in the persistence branch). If a test needs `DomainConfig`, it is already imported in that file.
