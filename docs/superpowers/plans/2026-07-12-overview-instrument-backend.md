# Overview Instrument Backend Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the runtime telemetry the new dashboard Overview needs — reachability probe latency, a 60-check quorum history, cumulative uptime counters, per-family IP last-changed timestamps, and a `next_check_at` countdown — all exposed through the existing `/api/state` + `/ws` snapshot.

**Architecture:** Bottom-up. First give `ReachabilityService` a proper `ResolverProbe` result type carrying latency (Task 1). Then make `RuntimeState` the single home for reachability telemetry and IP-change timestamps, serialized by `snapshot()` (Tasks 2–4). Finally wire the scheduler to record every check and publish `next_check_at` (Task 5). TDD throughout; strict gates.

**Tech Stack:** Python 3.12 (FastAPI, pydantic v2, APScheduler, aiodns), pytest.

## Global Constraints

- Python `>=3.12`. Strict gates: flake8 (pep257 docstrings, alphabetical import order, single quotes, naming), mypy (`mypy .`), pyright strict (`pyright tether_ddns`), ruff.
- Docstrings + full type annotations on every new/changed function, method, and class.
- Backend coverage gate: `pytest test/` must pass with `--cov-fail-under=90`.
- Reachability cadence is the existing module constant `REACHABILITY_INTERVAL_SECONDS = 30` — no magic numbers.
- History retains the **last 60 checks** — expose as a module constant `REACHABILITY_HISTORY_SIZE = 60` in `runtime.py`.
- Telemetry is **in-memory only** — never persisted to `tether-ddns.json`.
- Do not weaken `mypy.ini` / `pyrightconfig.json`. Scope any `# noqa` / `# pyright: ignore` narrowly.
- Venv at `.venv` (`source .venv/bin/activate`; project uses `uv`). Backend unit tests live in `test/unit/`.
- All timestamps are epoch seconds as `float` (`time.time()`); latency is milliseconds as `float` (`time.perf_counter()` deltas).

---

## Task 1: `ResolverProbe` result type with latency

**Files:**
- Modify: `tether_ddns/reachability.py`
- Test: `test/unit/test_reachability.py`

**Interfaces:**
- Produces:
  - `class ResolverProbe(BaseModel)` with `ip: str`, `ok: bool`, `latency_ms: float | None = None`.
  - `ReachabilityService._query_one(self, resolver_ip: str) -> ResolverProbe`.
  - `ReachabilityResult` gains `probes: list[ResolverProbe] = Field(default_factory=list)`. Existing `online`, `successes`, `total`, `details` unchanged.

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/test_reachability.py`:

```python
import asyncio

from tether_ddns.reachability import (
    ReachabilityResult, ReachabilityService, ResolverProbe)


def test_resolver_probe_defaults() -> None:
    probe = ResolverProbe(ip='1.1.1.1', ok=True, latency_ms=12.5)
    assert probe.ip == '1.1.1.1'
    assert probe.ok is True
    assert probe.latency_ms == 12.5
    assert ResolverProbe(ip='9.9.9.9', ok=False).latency_ms is None


def test_query_one_success_has_latency(monkeypatch) -> None:
    async def fake_wait_for(coro, timeout):  # noqa: ANN001, ANN202, ARG001
        if asyncio.iscoroutine(coro):
            coro.close()
        return None

    monkeypatch.setattr('tether_ddns.reachability.asyncio.wait_for', fake_wait_for)
    svc = ReachabilityService(resolvers=['1.1.1.1'])
    probe = asyncio.run(svc._query_one('1.1.1.1'))  # noqa: SLF001
    assert probe.ip == '1.1.1.1'
    assert probe.ok is True
    assert probe.latency_ms is not None
    assert probe.latency_ms >= 0


def test_query_one_timeout_has_no_latency(monkeypatch) -> None:
    async def fake_wait_for(coro, timeout):  # noqa: ANN001, ANN202, ARG001
        if asyncio.iscoroutine(coro):
            coro.close()
        raise asyncio.TimeoutError

    monkeypatch.setattr('tether_ddns.reachability.asyncio.wait_for', fake_wait_for)
    svc = ReachabilityService(resolvers=['1.1.1.1'])
    probe = asyncio.run(svc._query_one('1.1.1.1'))  # noqa: SLF001
    assert probe.ok is False
    assert probe.latency_ms is None


def test_check_assembles_probes(monkeypatch) -> None:
    async def fake_query_one(self, resolver_ip):  # noqa: ANN001, ANN202
        return ResolverProbe(ip=resolver_ip, ok=True, latency_ms=5.0)

    monkeypatch.setattr(ReachabilityService, '_query_one', fake_query_one)
    svc = ReachabilityService(resolvers=['1.1.1.1', '8.8.8.8'])
    result: ReachabilityResult = asyncio.run(svc.check())
    assert [p.ip for p in result.probes] == ['1.1.1.1', '8.8.8.8']
    assert result.successes == 2
    assert result.online is True
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest test/unit/test_reachability.py -k "probe or query_one or assembles" -v`
Expected: FAIL — `ImportError: cannot import name 'ResolverProbe'`.

- [ ] **Step 3: Implement `ResolverProbe`, latency, and `probes`**

In `tether_ddns/reachability.py`, add `import time` (respect alphabetical order: after `import asyncio`). Add the model after `ReachabilityResult`:

```python
class ResolverProbe(BaseModel):
    """Outcome of a single resolver query."""

    ip: str
    ok: bool
    latency_ms: float | None = None
```

Add `probes` to `ReachabilityResult`:

```python
class ReachabilityResult(BaseModel):
    """Outcome of a reachability check."""

    online: bool
    successes: int
    total: int
    details: dict[str, str] = Field(default_factory=dict)
    probes: list[ResolverProbe] = Field(default_factory=list)
```

Rewrite `_query_one` to return a `ResolverProbe`, timing the query:

```python
    async def _query_one(self, resolver_ip: str) -> ResolverProbe:
        """Resolve against one resolver, returning a timed probe."""
        resolver = aiodns.DNSResolver(nameservers=[resolver_ip])
        start = time.perf_counter()
        try:
            await asyncio.wait_for(
                resolver.query_dns(self._query_host, 'A'), timeout=self._timeout)
        except asyncio.TimeoutError:
            self._last_detail = 'timeout'
            return ResolverProbe(ip=resolver_ip, ok=False)
        except aiodns.error.DNSError as exc:
            self._last_detail = f'dns_error: {exc}'
            return ResolverProbe(ip=resolver_ip, ok=False)
        except Exception as exc:  # noqa: BLE001 - one bad resolver must not kill the check
            self._last_detail = f'error: {exc}'
            return ResolverProbe(ip=resolver_ip, ok=False)
        latency_ms = (time.perf_counter() - start) * 1000
        self._last_detail = 'ok'
        return ResolverProbe(ip=resolver_ip, ok=True, latency_ms=latency_ms)
```

Note: `_query_one` no longer carries the detail string in its return. Keep the `details` map by reconstructing it in `check()` from each probe (see below) — do NOT add `self._last_detail` state (that line above is illustrative only; use the `check()` reconstruction instead and delete any `self._last_detail` usage).

Replace `check()` so it derives everything from probes:

```python
    async def check(self) -> ReachabilityResult:
        """Query all resolvers concurrently and evaluate the quorum."""
        probes = await asyncio.gather(
            *(self._query_one(ip) for ip in self._resolver_ips))
        details = {
            p.ip: 'ok' if p.ok else 'unreachable' for p in probes}
        successes = sum(1 for p in probes if p.ok)
        online = successes >= self._quorum
        if not online:
            _log.warning(
                'Reachability failed: %d/%d resolvers ok (%s)',
                successes, len(self._resolver_ips), details)
        return ReachabilityResult(
            online=online, successes=successes,
            total=len(self._resolver_ips), details=details,
            probes=list(probes))
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest test/unit/test_reachability.py -v`
Expected: PASS (including any pre-existing tests; update assertions on the old `details` values if a pre-existing test expected `'dns_error: ...'` — the new `check()` maps failures to `'unreachable'`).

- [ ] **Step 5: Gates + commit**

Run: `flake8 tether_ddns/reachability.py && mypy . && pyright tether_ddns && ruff check tether_ddns/reachability.py`
Expected: clean.

```bash
git add tether_ddns/reachability.py test/unit/test_reachability.py
git commit -m "feat(reachability): add ResolverProbe with per-resolver latency"
```

---

## Task 2: `CheckRecord` model and reachability telemetry fields

**Files:**
- Modify: `tether_ddns/runtime.py`
- Test: `test/unit/test_runtime.py`

**Interfaces:**
- Consumes: `ReachabilityResult`, `ResolverProbe` from `tether_ddns.reachability`.
- Produces:
  - `REACHABILITY_HISTORY_SIZE = 60` module constant.
  - `class CheckRecord(BaseModel)` with `ts: float`, `successes: int`, `total: int`.
  - New `RuntimeState` attributes set in `__init__`: `reachability_started_at: float`, `reachability_checks: int = 0`, `reachability_online: int = 0`, `reachability_history: deque[CheckRecord]` (`maxlen=REACHABILITY_HISTORY_SIZE`), `reachability_latest: list[ResolverProbe] = []`, `next_check_at: float | None = None`, `ipv4_changed_at: float | None = None`, `ipv6_changed_at: float | None = None`.

- [ ] **Step 1: Write the failing test**

Add to `test/unit/test_runtime.py`:

```python
from collections import deque

from tether_ddns.runtime import (
    CheckRecord, REACHABILITY_HISTORY_SIZE, RuntimeState)


def test_reachability_fields_initialised() -> None:
    state = RuntimeState()
    assert state.reachability_checks == 0
    assert state.reachability_online == 0
    assert isinstance(state.reachability_history, deque)
    assert state.reachability_history.maxlen == REACHABILITY_HISTORY_SIZE
    assert state.reachability_latest == []
    assert state.next_check_at is None
    assert state.ipv4_changed_at is None
    assert state.ipv6_changed_at is None
    assert isinstance(state.reachability_started_at, float)


def test_check_record_shape() -> None:
    rec = CheckRecord(ts=1.0, successes=3, total=3)
    assert rec.model_dump() == {'ts': 1.0, 'successes': 3, 'total': 3}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest test/unit/test_runtime.py -k "reachability_fields or check_record" -v`
Expected: FAIL — `ImportError: cannot import name 'CheckRecord'`.

- [ ] **Step 3: Implement the model and fields**

In `tether_ddns/runtime.py`: add `import time` (already present — verify) and `from collections import deque` (alphabetical, above `import time`). Import the reachability types:

```python
from tether_ddns.reachability import ReachabilityResult, ResolverProbe
```

Add the constant and model near the top (after imports, before `freshness`):

```python
REACHABILITY_HISTORY_SIZE = 60


class CheckRecord(BaseModel):
    """A single reachability check summary for the history buffer."""

    ts: float
    successes: int
    total: int
```

Extend `RuntimeState.__init__` (append after `self.online = False`):

```python
        self.reachability_started_at: float = time.time()
        self.reachability_checks: int = 0
        self.reachability_online: int = 0
        self.reachability_history: deque[CheckRecord] = deque(
            maxlen=REACHABILITY_HISTORY_SIZE)
        self.reachability_latest: list[ResolverProbe] = []
        self.next_check_at: float | None = None
        self.ipv4_changed_at: float | None = None
        self.ipv6_changed_at: float | None = None
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest test/unit/test_runtime.py -k "reachability_fields or check_record" -v`
Expected: PASS.

- [ ] **Step 5: Gates + commit**

Run: `flake8 tether_ddns/runtime.py && mypy . && pyright tether_ddns && ruff check tether_ddns/runtime.py`
Expected: clean.

```bash
git add tether_ddns/runtime.py test/unit/test_runtime.py
git commit -m "feat(runtime): add reachability telemetry state fields"
```

---

## Task 3: `record_reachability`, `set_next_check_at`, and IP-change timestamps

**Files:**
- Modify: `tether_ddns/runtime.py`
- Test: `test/unit/test_runtime.py`

**Interfaces:**
- Consumes: `ReachabilityResult` (has `online`, `successes`, `total`, `probes`).
- Produces:
  - `RuntimeState.record_reachability(self, result: ReachabilityResult) -> bool` — appends a `CheckRecord`, increments `reachability_checks` (and `reachability_online` when `result.online`), stores `reachability_latest = result.probes`, sets `self.online = result.online`, emits once. Returns `True` when `online` transitioned (differs from prior), else `False`.
  - `RuntimeState.set_next_check_at(self, ts: float | None) -> None` — sets `next_check_at`, emits.
  - `set_public_ipv4` / `set_public_ipv6` updated to set `ipv4_changed_at` / `ipv6_changed_at = time.time()` **only when the incoming value differs from the current** and is not `None`.

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/test_runtime.py`:

```python
from tether_ddns.reachability import ReachabilityResult, ResolverProbe


def _result(online: bool, successes: int = 3, total: int = 3) -> ReachabilityResult:
    return ReachabilityResult(
        online=online, successes=successes, total=total,
        probes=[ResolverProbe(ip='1.1.1.1', ok=online, latency_ms=5.0)])


def test_record_reachability_accumulates() -> None:
    state = RuntimeState()
    assert state.record_reachability(_result(True)) is True   # False -> True
    assert state.record_reachability(_result(True)) is False  # no transition
    assert state.reachability_checks == 2
    assert state.reachability_online == 2
    assert state.online is True
    assert len(state.reachability_history) == 2
    assert state.reachability_latest[0].ip == '1.1.1.1'


def test_record_reachability_counts_only_online() -> None:
    state = RuntimeState()
    state.record_reachability(_result(True))
    state.record_reachability(_result(False, successes=0))
    assert state.reachability_checks == 2
    assert state.reachability_online == 1


def test_record_reachability_history_caps_at_size() -> None:
    state = RuntimeState()
    for _ in range(REACHABILITY_HISTORY_SIZE + 5):
        state.record_reachability(_result(True))
    assert len(state.reachability_history) == REACHABILITY_HISTORY_SIZE


def test_set_next_check_at() -> None:
    state = RuntimeState()
    state.set_next_check_at(123.0)
    assert state.next_check_at == 123.0


def test_ip_changed_at_only_moves_on_change() -> None:
    state = RuntimeState()
    state.set_public_ipv4('203.0.113.1')
    first = state.ipv4_changed_at
    assert first is not None
    state.set_public_ipv4('203.0.113.1')  # unchanged
    assert state.ipv4_changed_at == first
    state.set_public_ipv4('203.0.113.2')  # changed
    assert state.ipv4_changed_at is not None
    assert state.ipv4_changed_at >= first
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest test/unit/test_runtime.py -k "record_reachability or next_check_at or ip_changed_at" -v`
Expected: FAIL — `AttributeError: 'RuntimeState' object has no attribute 'record_reachability'`.

- [ ] **Step 3: Implement the methods**

In `tether_ddns/runtime.py`, replace `set_public_ipv4` and `set_public_ipv6`:

```python
    def set_public_ipv4(self, ip: str | None) -> None:
        """Update the current public IPv4, tracking last-changed, and notify."""
        if ip is not None and ip != self.public_ipv4:
            self.ipv4_changed_at = time.time()
        self.public_ipv4 = ip
        self._emit()

    def set_public_ipv6(self, ip: str | None) -> None:
        """Update the current public IPv6, tracking last-changed, and notify."""
        if ip is not None and ip != self.public_ipv6:
            self.ipv6_changed_at = time.time()
        self.public_ipv6 = ip
        self._emit()
```

Add after `set_online`:

```python
    def record_reachability(self, result: ReachabilityResult) -> bool:
        """Record a reachability check; return True on an online transition."""
        transitioned = result.online != self.online
        self.reachability_history.append(CheckRecord(
            ts=time.time(), successes=result.successes, total=result.total))
        self.reachability_checks += 1
        if result.online:
            self.reachability_online += 1
        self.reachability_latest = list(result.probes)
        self.online = result.online
        self._emit()
        return transitioned

    def set_next_check_at(self, ts: float | None) -> None:
        """Set the next scheduled sync time and notify listeners."""
        self.next_check_at = ts
        self._emit()
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest test/unit/test_runtime.py -k "record_reachability or next_check_at or ip_changed_at" -v`
Expected: PASS.

- [ ] **Step 5: Gates + commit**

Run: `flake8 tether_ddns/runtime.py && mypy . && pyright tether_ddns && ruff check tether_ddns/runtime.py`
Expected: clean.

```bash
git add tether_ddns/runtime.py test/unit/test_runtime.py
git commit -m "feat(runtime): record reachability, next-check, and IP-change times"
```

---

## Task 4: Extend `snapshot()` with the new telemetry

**Files:**
- Modify: `tether_ddns/runtime.py`
- Test: `test/unit/test_runtime.py`

**Interfaces:**
- Produces: `RuntimeState.snapshot()` returns the existing keys plus
  `ipv4_changed_at`, `ipv6_changed_at`, `next_check_at`, and a nested
  `reachability` object `{started_at, checks, online, history[], latest[]}`.

- [ ] **Step 1: Write the failing test**

Add to `test/unit/test_runtime.py`:

```python
def test_snapshot_includes_reachability_block() -> None:
    state = RuntimeState()
    state.record_reachability(_result(True))
    state.set_next_check_at(999.0)
    state.set_public_ipv4('203.0.113.9')
    snap = state.snapshot()
    assert snap['next_check_at'] == 999.0
    assert snap['ipv4_changed_at'] is not None
    assert snap['ipv6_changed_at'] is None
    reach = snap['reachability']
    assert isinstance(reach, dict)
    assert reach['checks'] == 1
    assert reach['online'] == 1
    assert isinstance(reach['started_at'], float)
    assert reach['history'] == [
        {'ts': reach['history'][0]['ts'], 'successes': 3, 'total': 3}]
    assert reach['latest'] == [
        {'ip': '1.1.1.1', 'ok': True, 'latency_ms': 5.0}]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest test/unit/test_runtime.py -k "snapshot_includes_reachability" -v`
Expected: FAIL — `KeyError: 'next_check_at'`.

- [ ] **Step 3: Extend `snapshot()`**

Replace the `snapshot` method body's return with:

```python
    def snapshot(self) -> dict[str, object]:
        """Return a serialisable snapshot of the state."""
        return {
            'public_ipv4': self.public_ipv4,
            'public_ipv6': self.public_ipv6,
            'ipv4_changed_at': self.ipv4_changed_at,
            'ipv6_changed_at': self.ipv6_changed_at,
            'online': self.online,
            'next_check_at': self.next_check_at,
            'reachability': {
                'started_at': self.reachability_started_at,
                'checks': self.reachability_checks,
                'online': self.reachability_online,
                'history': [r.model_dump() for r in self.reachability_history],
                'latest': [p.model_dump() for p in self.reachability_latest],
            },
            'domains': [d.model_dump() for d in self.domains.values()],
        }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest test/unit/test_runtime.py -v`
Expected: PASS (all runtime tests).

- [ ] **Step 5: Gates + commit**

Run: `flake8 tether_ddns/runtime.py && mypy . && pyright tether_ddns && ruff check tether_ddns/runtime.py`
Expected: clean.

```bash
git add tether_ddns/runtime.py test/unit/test_runtime.py
git commit -m "feat(runtime): expose reachability telemetry in snapshot"
```

---

## Task 5: Scheduler records every check and publishes `next_check_at`

**Files:**
- Modify: `tether_ddns/scheduler.py`
- Test: `test/unit/test_scheduler.py`

**Interfaces:**
- Consumes: `RuntimeState.record_reachability` (returns `bool` transition),
  `RuntimeState.set_next_check_at`.
- Produces: `Scheduler.check_reachability` records every check and dispatches
  `reachability_changed` only on transition; `Scheduler.sync_ips` and
  `Scheduler.start` publish `next_check_at` from the `sync` job's `next_run_time`.

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/test_scheduler.py` (follow the file's existing fixture/import style; adapt names to match what's already there):

```python
import asyncio

from tether_ddns.config import AppConfig
from tether_ddns.reachability import ReachabilityResult, ResolverProbe
from tether_ddns.runtime import RuntimeState
from tether_ddns.scheduler import Scheduler


def _reach(online: bool) -> ReachabilityResult:
    return ReachabilityResult(
        online=online, successes=3 if online else 0, total=3,
        probes=[ResolverProbe(ip='1.1.1.1', ok=online, latency_ms=4.0)])


def test_check_reachability_records_every_run(monkeypatch) -> None:
    sched = Scheduler()

    async def fake_check() -> ReachabilityResult:
        return _reach(True)

    monkeypatch.setattr(sched._reachability, 'check', fake_check)  # noqa: SLF001
    cfg = AppConfig()
    state = RuntimeState()
    asyncio.run(sched.check_reachability(cfg, state))
    asyncio.run(sched.check_reachability(cfg, state))
    assert state.reachability_checks == 2
    assert state.online is True


def test_check_reachability_dispatches_only_on_transition(monkeypatch) -> None:
    sched = Scheduler()
    online = [False]

    async def fake_check() -> ReachabilityResult:
        return _reach(online[0])

    dispatched: list[bool] = []

    async def fake_dispatch(event, cfg) -> None:  # noqa: ANN001
        dispatched.append(event.online)

    monkeypatch.setattr(sched._reachability, 'check', fake_check)  # noqa: SLF001
    monkeypatch.setattr(
        'tether_ddns.scheduler.dispatch_reachability_changed', fake_dispatch)
    cfg = AppConfig()
    state = RuntimeState()
    online[0] = True
    asyncio.run(sched.check_reachability(cfg, state))   # transition -> dispatch
    asyncio.run(sched.check_reachability(cfg, state))   # steady -> no dispatch
    assert dispatched == [True]
```

For `next_check_at`, add a test that starts the scheduler and asserts the value is published:

```python
def test_start_publishes_next_check_at() -> None:
    sched = Scheduler()
    cfg = AppConfig()
    state = RuntimeState()
    sched.start(cfg, state)
    try:
        assert state.next_check_at is not None
        assert state.next_check_at > 0
    finally:
        sched.shutdown()
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest test/unit/test_scheduler.py -k "records_every_run or only_on_transition or publishes_next_check" -v`
Expected: FAIL — `check_reachability` still calls `set_online` (no `reachability_checks` increment) and no `next_check_at` is published.

- [ ] **Step 3: Rewrite `check_reachability` and publish `next_check_at`**

In `tether_ddns/scheduler.py`, replace `check_reachability`:

```python
    async def check_reachability(self, cfg: AppConfig, state: RuntimeState) -> None:
        """Run the DNS-quorum check; fire reachability_changed on transition."""
        was_online = state.online
        reach = await self._reachability.check()
        transitioned = state.record_reachability(reach)
        if transitioned:
            await dispatch_reachability_changed(
                ReachabilityChangedEvent(
                    online=reach.online, was_online=was_online), cfg)
```

Add a private helper and call it from `start()` and at the end of `sync_ips`:

```python
    def _publish_next_check(self, state: RuntimeState) -> None:
        """Publish the sync job's next fire time to runtime state."""
        job = self._scheduler.get_job('sync')
        next_run = getattr(job, 'next_run_time', None) if job else None
        state.set_next_check_at(next_run.timestamp() if next_run else None)
```

In `start()`, after `self._scheduler.start()`:

```python
        self._scheduler.start()
        self._publish_next_check(state)
```

At the end of `sync_ips` (after the domain loop), add:

```python
        self._publish_next_check(state)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest test/unit/test_scheduler.py -v`
Expected: PASS (including pre-existing scheduler tests — update any that asserted the old transition-only `set_online` behavior).

- [ ] **Step 5: Gates + commit**

Run: `flake8 tether_ddns/scheduler.py && mypy . && pyright tether_ddns && ruff check tether_ddns/scheduler.py`
Expected: clean.

```bash
git add tether_ddns/scheduler.py test/unit/test_scheduler.py
git commit -m "feat(scheduler): record every reachability check and publish next_check_at"
```

---

## Task 6: Full-suite verification

**Files:**
- Test: entire `test/` suite.

- [ ] **Step 1: Run the full backend suite with coverage**

Run: `pytest test/ --cov=tether_ddns --cov-fail-under=90`
Expected: PASS, coverage ≥ 90%. If any pre-existing test asserted the old snapshot shape (e.g. in `test_ws.py` or `test_main.py`), update it to include the new keys / nested `reachability` block.

- [ ] **Step 2: Run all strict gates across the package**

Run: `flake8 tether_ddns test && mypy . && pyright tether_ddns && ruff check tether_ddns test`
Expected: clean.

- [ ] **Step 3: Commit any test-shape fixups**

```bash
git add -A
git commit -m "test: align snapshot-shape assertions with reachability telemetry"
```

---

## Self-Review Notes

- **Spec coverage:** §1 → Task 1; §2 → Tasks 2–4; §3 → Task 5; §4 (schema) → Task 4; §5 (testing) → Tasks 1–6. All covered.
- **Type consistency:** `ResolverProbe`, `CheckRecord`, `ReachabilityResult.probes`, `record_reachability -> bool`, `set_next_check_at`, `_publish_next_check` names are used identically across tasks.
- **Note for implementer:** `test_ws.py` and `test_main.py` assert snapshot shape today; Task 6 explicitly covers reconciling them.
