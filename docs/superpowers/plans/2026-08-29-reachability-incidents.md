# Reachability Incident History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the ephemeral since-boot reachability telemetry with a persisted 30-day incident history, surfaced as a clickable strip of daily bars with a per-day detail modal.

**Architecture:** A new incident domain (`tether_ddns/incidents.py`), its own fail-soft JSON store (`tether_ddns/incident_store.py`), and a recorder service (`tether_ddns/services/incidents.py`) that the scheduler calls once per reachability tick. The recorder writes to disk only on incident open, close, severity split, and prune. The live ongoing incident plus a revision counter ride the existing WebSocket snapshot; the 30-day list is served by a new REST endpoint that the frontend refetches only when the revision changes.

**Tech Stack:** Python 3.12+, Pydantic v2, FastAPI, APScheduler, pytest; React 19, TypeScript, Vite, Vitest, Playwright.

**Spec:** [docs/superpowers/specs/2026-08-29-reachability-incidents-design.md](../specs/2026-08-29-reachability-incidents-design.md)

## Global Constraints

- **Backend gates run over BOTH `tether_ddns/` and `test/`.** The repo has meta-tests that lint the whole repo: `test/test_flake8.py`, `test/test_pyright.py`, `test/test_ruff.py`, `test/test_mypy.py`. Run `flake8 test/ tether_ddns/`, `pyright`, `ruff check`, `mypy .` — not just the package directory.
- **Coverage gate:** `pytest test/ --cov=tether_ddns --cov-fail-under=90`.
- **Docstrings are mandatory** (flake8-docstrings). Every module, class, function, and **every test function** needs a one-line docstring ending with a period (D103).
- **Single quotes** for Python strings. **Max line length 99.**
- **Imports strictly alphabetical** (flake8 I101).
- **Pyright strict.** Never use a blanket `# type: ignore` — `reportUnnecessaryTypeIgnoreComment` is an error. Use narrow `# pyright: ignore[ruleName]` only when unavoidable.
- **Async tests** use `@pytest.mark.asyncio` + `async def` + `await`, never `asyncio.run`.
- **Access protected members in tests** via `patch.object(obj, '_name')` to avoid `reportPrivateUsage`.
- **Python venv:** `source .venv/bin/activate` from the repo root.
- **Frontend:** run from `frontend/`. `npm test` (Vitest; `npm run lint` with oxlint runs as pretest), `npm run test:e2e` (Playwright).
- **Retention constant:** in Python, `WINDOW_DAYS = 30` in `tether_ddns/incidents.py` is the single source; do not hardcode `30` or `2592000` anywhere else in the package. The frontend cannot import it, so it declares its own single named constant, `DAY_BARS` in `ReachabilityPanel.tsx`; the `days` parameters in `utils.ts` default to `30` and callers pass `DAY_BARS`. Those two declarations are the only literals permitted.
- **Timestamps are epoch seconds (floats)** everywhere in Python and in the JSON payloads. The frontend converts from `Date.now()` milliseconds at the boundary.

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `tether_ddns/incidents.py` | `Severity`, `Incident`, `IncidentWindow`, `IncidentView`, `classify()`, `failed_ips()`, `prune()`, `WINDOW_DAYS`/`WINDOW_SECONDS` |
| `tether_ddns/incident_store.py` | `IncidentStore` — fail-soft load, atomic save, path resolution |
| `tether_ddns/services/incidents.py` | `IncidentRecorder` — the transition table, prune-on-load, write policy |
| `test/unit/conftest.py` | Shared `make_result` fixture: builds a `ReachabilityResult` from a list of per-probe outcomes |
| `test/unit/test_incidents.py` | Model, classification, prune |
| `test/unit/test_incident_store.py` | Persistence round-trip, fail-soft, path |
| `test/unit/test_incident_recorder.py` | Transition table, **write policy**, restart, retention |
| `frontend/src/useIncidents.ts` | `useIncidents(rev)` fetch-on-rev-change hook |
| `frontend/src/useIncidents.test.tsx` | Hook refetch behaviour |
| `frontend/src/components/IncidentModal.tsx` | Day detail: summary, 24h timeline, incident list |
| `frontend/src/components/IncidentModal.test.tsx` | Modal rendering incl. edge cases |

**Modified:**

| File | Change |
|---|---|
| `tether_ddns/runtime.py` | Add `incident_rev`/`incident_ongoing` (excluded); `record_reachability` takes a view; drop `reachability_checks`/`reachability_online` |
| `tether_ddns/context.py` | Hold the recorder; add `persist_incidents()` |
| `tether_ddns/scheduler.py` | Record incidents on each tick; flush on shutdown |
| `tether_ddns/app.py` | Build `IncidentStore` + `IncidentRecorder`, pass into `AppContext` |
| `tether_ddns/api.py` | `GET /api/reachability/incidents` |
| `frontend/src/types.ts` | `Severity`, `Incident`, `IncidentWindow`; reshape `Reachability` |
| `frontend/src/api.ts` | `getIncidents()` |
| `frontend/src/utils.ts` | `bucketByDay()`, `uptimeStats()`, `formatDuration()` |
| `frontend/src/components/ReachabilityPanel.tsx` | Constant-height live strip; 30-day strip; modal wiring |
| `frontend/src/styles.css` | Day strip and modal timeline styles |
| `frontend/src/views/OverviewView.tsx` | Call `useIncidents`, pass window down |
| `frontend/e2e/dashboard.spec.ts` | Click a day bar, assert the modal |

Existing tests that must be updated as part of the task that breaks them: `test/unit/test_runtime.py`, `test/unit/test_scheduler.py`, `test/unit/test_api.py`, `test/unit/test_main.py` (if it asserts snapshot keys), `frontend/src/types.test.ts`, `frontend/src/useLiveState.test.tsx`, `frontend/src/views/OverviewView.test.tsx`, `frontend/src/components/ReachabilityPanel.test.tsx`.

---

### Task 1: Incident domain model

**Files:**
- Create: `tether_ddns/incidents.py`
- Create: `test/unit/conftest.py`
- Test: `test/unit/test_incidents.py`

**Interfaces:**
- Consumes: `ReachabilityResult`, `ResolverProbe` from `tether_ddns.reachability`.
- Produces:
  - `Severity = Literal['degraded', 'outage']`
  - `Incident(start: float, end: float | None, severity: Severity, min_successes: int, total: int, failed: list[str])`
  - `IncidentWindow(monitoring_since: float, rev: int, incidents: list[Incident], ongoing: Incident | None)`
  - `IncidentView(ongoing: Incident | None, rev: int)` — a `NamedTuple`
  - `classify(result: ReachabilityResult) -> Severity | None`
  - `failed_ips(result: ReachabilityResult) -> list[str]`
  - `prune(window: IncidentWindow, cutoff: float) -> bool`
  - `WINDOW_DAYS: int = 30`, `WINDOW_SECONDS: float`
  - `make_result` pytest fixture in `test/unit/conftest.py`, reused by Tasks 3 and 6

The fixture lives in `conftest.py` rather than a plain module because `test/` is not a package and cannot become one — `test` collides with the stdlib module — and pyright resolves imports from the project root, so a sibling `import` would need `extraPaths` in `pyrightconfig.json`. A fixture needs no import at all.

- [ ] **Step 1: Write the failing tests**

Create `test/unit/conftest.py`:

```python
"""Shared fixtures for the unit test suite."""
from typing import Callable

import pytest

from tether_ddns.reachability import ReachabilityResult, ResolverProbe

QUORUM = 2


@pytest.fixture
def make_result() -> Callable[[list[bool]], ReachabilityResult]:
    """Return a factory building a ReachabilityResult from probe outcomes.

    Probe IPs are assigned as ``10.0.0.<index>`` and ``online`` is derived from
    the quorum, matching ReachabilityProbe's own rule.
    """
    def _make(oks: list[bool]) -> ReachabilityResult:
        probes = [
            ResolverProbe(ip=f'10.0.0.{i}', ok=ok, latency_ms=1.0 if ok else None)
            for i, ok in enumerate(oks)
        ]
        successes = sum(oks)
        return ReachabilityResult(
            online=successes >= QUORUM, successes=successes,
            total=len(oks), details={}, probes=probes)
    return _make
```

Create `test/unit/test_incidents.py`:

```python
"""Tests for the incident domain model and helpers."""
from typing import Callable

from tether_ddns.incidents import (
    Incident,
    IncidentWindow,
    classify,
    failed_ips,
    prune,
)
from tether_ddns.reachability import ReachabilityResult

ResultFactory = Callable[[list[bool]], ReachabilityResult]


def test_classify_all_ok_is_healthy(make_result: ResultFactory) -> None:
    """A check where every probe succeeded yields no incident."""
    assert classify(make_result([True, True, True])) is None


def test_classify_partial_failure_is_degraded(make_result: ResultFactory) -> None:
    """A check that lost a probe but held quorum is degraded."""
    assert classify(make_result([True, True, False])) == 'degraded'


def test_classify_quorum_lost_is_outage(make_result: ResultFactory) -> None:
    """A check that lost quorum is an outage."""
    assert classify(make_result([True, False, False])) == 'outage'


def test_classify_total_failure_is_outage(make_result: ResultFactory) -> None:
    """A check where every probe failed is an outage."""
    assert classify(make_result([False, False, False])) == 'outage'


def test_failed_ips_lists_only_failures(make_result: ResultFactory) -> None:
    """failed_ips returns the IPs of probes that did not succeed."""
    result = make_result([True, False, False])
    assert failed_ips(result) == ['10.0.0.1', '10.0.0.2']


def test_prune_drops_fully_expired_incidents() -> None:
    """An incident that ended before the cutoff is dropped."""
    window = IncidentWindow(
        monitoring_since=0.0, rev=0, ongoing=None,
        incidents=[Incident(
            start=10.0, end=20.0, severity='outage',
            min_successes=0, total=3, failed=[])])
    assert prune(window, 30.0) is True
    assert window.incidents == []


def test_prune_keeps_incident_overlapping_the_cutoff() -> None:
    """An incident that started before but ended after the cutoff stays."""
    window = IncidentWindow(
        monitoring_since=0.0, rev=0, ongoing=None,
        incidents=[Incident(
            start=10.0, end=40.0, severity='outage',
            min_successes=0, total=3, failed=[])])
    assert prune(window, 30.0) is False
    assert len(window.incidents) == 1


def test_prune_reports_no_change_when_nothing_expired() -> None:
    """prune returns False when every incident is inside the window."""
    window = IncidentWindow(
        monitoring_since=0.0, rev=0, ongoing=None,
        incidents=[Incident(
            start=100.0, end=110.0, severity='degraded',
            min_successes=2, total=3, failed=[])])
    assert prune(window, 30.0) is False
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `source .venv/bin/activate && pytest test/unit/test_incidents.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'tether_ddns.incidents'`

- [ ] **Step 3: Write the implementation**

Create `tether_ddns/incidents.py`:

```python
"""Incident model for the persisted reachability history window."""
from __future__ import annotations

import time
from typing import Literal, NamedTuple

from pydantic import BaseModel, Field

from tether_ddns.reachability import ReachabilityResult

Severity = Literal['degraded', 'outage']

WINDOW_DAYS = 30
WINDOW_SECONDS = WINDOW_DAYS * 24 * 60 * 60


class Incident(BaseModel):
    """A contiguous span during which reachability was not fully healthy."""

    start: float
    end: float | None = None
    severity: Severity
    min_successes: int
    total: int
    failed: list[str] = Field(default_factory=list[str])


class IncidentWindow(BaseModel):
    """The persisted 30-day incident window."""

    monitoring_since: float = Field(default_factory=time.time)
    rev: int = 0
    incidents: list[Incident] = Field(default_factory=list[Incident])
    ongoing: Incident | None = None


class IncidentView(NamedTuple):
    """The live incident data published to the UI on each check."""

    ongoing: Incident | None
    rev: int


def classify(result: ReachabilityResult) -> Severity | None:
    """Return the severity for a check, or None when fully healthy.

    ``ReachabilityResult.online`` already encodes ``successes >= quorum``, so
    this needs no access to the probe's configuration.
    """
    if result.successes >= result.total:
        return None
    return 'degraded' if result.online else 'outage'


def failed_ips(result: ReachabilityResult) -> list[str]:
    """Return the resolver IPs whose probe failed in this check."""
    return [p.ip for p in result.probes if not p.ok]


def prune(window: IncidentWindow, cutoff: float) -> bool:
    """Drop incidents that ended before ``cutoff``; True if any were dropped."""
    kept = [i for i in window.incidents if i.end is None or i.end >= cutoff]
    if len(kept) == len(window.incidents):
        return False
    window.incidents = kept
    return True
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `source .venv/bin/activate && pytest test/unit/test_incidents.py -v`
Expected: PASS (8 tests)

- [ ] **Step 5: Run the lint gates**

Run: `source .venv/bin/activate && flake8 test/ tether_ddns/ && ruff check && mypy . && pyright`
Expected: all clean

- [ ] **Step 6: Commit**

```bash
git add tether_ddns/incidents.py test/unit/conftest.py test/unit/test_incidents.py
git commit -m "feat: add reachability incident model and classification"
```

---

### Task 2: Incident store

**Files:**
- Create: `tether_ddns/incident_store.py`
- Test: `test/unit/test_incident_store.py`

**Interfaces:**
- Consumes: `IncidentWindow` from Task 1; `StateStore.resolve_path()` from `tether_ddns.state_store`.
- Produces: `IncidentStore(path: Path | None = None)` with `.path`, `.resolve_path()` (static), `.beside(state_path: Path)` (classmethod), `.load() -> IncidentWindow`, `.save(window: IncidentWindow) -> None`.

Note the difference from `StateStore`: `load()` returns a **fresh `IncidentWindow`**, never `None`. There is no meaningful "no state" mode for a history window.

`beside()` exists because `create_app` accepts an injected `StateStore` whose path may differ from what the environment resolves to. Deriving from the injected store is what keeps tests from writing an incident file into the repository root.

- [ ] **Step 1: Write the failing tests**

Create `test/unit/test_incident_store.py`:

```python
"""Tests for the IncidentStore persistence layer."""
import logging
from pathlib import Path

import pytest

from tether_ddns.incident_store import IncidentStore
from tether_ddns.incidents import Incident, IncidentWindow


def test_resolve_path_sits_beside_the_state_file(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """The incident file is resolved into the state file's directory."""
    monkeypatch.setenv('TETHER_DDNS_STATE_PATH', str(tmp_path / 'state.json'))
    assert IncidentStore.resolve_path() == tmp_path / 'tether-ddns.incidents.json'


def test_beside_derives_from_a_given_state_path(tmp_path: Path) -> None:
    """beside places the incident file next to an explicit state file."""
    store = IncidentStore.beside(tmp_path / 'nested' / 'state.json')
    assert store.path == tmp_path / 'nested' / 'tether-ddns.incidents.json'


def test_load_missing_returns_fresh_window(tmp_path: Path) -> None:
    """Loading a missing file yields an empty window, not None."""
    store = IncidentStore(tmp_path / 'nope.json')
    window = store.load()
    assert window.incidents == []
    assert window.ongoing is None
    assert window.rev == 0


def test_save_then_load_round_trips(tmp_path: Path) -> None:
    """A saved window is read back with its incidents intact."""
    store = IncidentStore(tmp_path / 'incidents.json')
    window = IncidentWindow(
        monitoring_since=100.0, rev=4, ongoing=None,
        incidents=[Incident(
            start=200.0, end=260.0, severity='outage',
            min_successes=0, total=3, failed=['1.1.1.1'])])
    store.save(window)
    loaded = store.load()
    assert loaded.rev == 4
    assert loaded.monitoring_since == 100.0
    assert len(loaded.incidents) == 1
    assert loaded.incidents[0].failed == ['1.1.1.1']


def test_save_then_load_round_trips_ongoing(tmp_path: Path) -> None:
    """An ongoing incident survives a save/load cycle with end unset."""
    store = IncidentStore(tmp_path / 'incidents.json')
    window = IncidentWindow(
        monitoring_since=100.0, rev=1, incidents=[],
        ongoing=Incident(
            start=300.0, end=None, severity='degraded',
            min_successes=2, total=3, failed=['8.8.8.8']))
    store.save(window)
    loaded = store.load()
    assert loaded.ongoing is not None
    assert loaded.ongoing.end is None
    assert loaded.ongoing.severity == 'degraded'


def test_load_corrupt_returns_fresh_window_and_warns(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """A corrupt incident file is discarded fail-soft with a warning."""
    path = tmp_path / 'incidents.json'
    path.write_text('{ not valid json', encoding='utf-8')
    store = IncidentStore(path)
    with caplog.at_level(logging.WARNING):
        window = store.load()
    assert window.incidents == []
    assert any(r.levelno >= logging.WARNING for r in caplog.records)


def test_save_leaves_no_temp_files(tmp_path: Path) -> None:
    """The atomic save removes its temporary file."""
    store = IncidentStore(tmp_path / 'incidents.json')
    store.save(IncidentWindow())
    assert [p.name for p in tmp_path.iterdir()] == ['incidents.json']


def test_path_property_returns_bound_path(tmp_path: Path) -> None:
    """The path property exposes the bound file path."""
    path = tmp_path / 'incidents.json'
    assert IncidentStore(path).path == path
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `source .venv/bin/activate && pytest test/unit/test_incident_store.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'tether_ddns.incident_store'`

- [ ] **Step 3: Write the implementation**

Create `tether_ddns/incident_store.py`:

```python
"""JSON-backed persistence for the reachability incident window.

The file is machine-written and regenerable, so loading is fail-soft: a
missing, unreadable, or invalid file yields a fresh empty window.
"""
from __future__ import annotations

import logging
import os
import tempfile
from pathlib import Path

from pydantic import ValidationError

from tether_ddns.incidents import IncidentWindow
from tether_ddns.state_store import StateStore

DEFAULT_FILENAME = 'tether-ddns.incidents.json'

logger = logging.getLogger(__name__)


class IncidentStore:
    """Loads and saves :class:`IncidentWindow` as JSON on disk."""

    def __init__(self, path: Path | None = None) -> None:
        """Create a store bound to a path (resolved if omitted)."""
        self._path = path if path is not None else self.resolve_path()

    @property
    def path(self) -> Path:
        """Return the incident file path."""
        return self._path

    @staticmethod
    def resolve_path() -> Path:
        """Resolve the incident path beside the runtime state file."""
        return StateStore.resolve_path().parent / DEFAULT_FILENAME

    @classmethod
    def beside(cls, state_path: Path) -> 'IncidentStore':
        """Create a store in the same directory as ``state_path``."""
        return cls(state_path.parent / DEFAULT_FILENAME)

    def load(self) -> IncidentWindow:
        """Load the persisted window, or a fresh one when absent/corrupt."""
        if not self._path.exists():
            return IncidentWindow()
        try:
            return IncidentWindow.model_validate_json(
                self._path.read_text('utf-8'))
        except (OSError, ValidationError, ValueError) as exc:
            logger.warning(
                'Discarding unreadable incident window at %s: %s',
                self._path, exc)
            return IncidentWindow()

    def save(self, window: IncidentWindow) -> None:
        """Persist the incident window atomically."""
        self._path.parent.mkdir(parents=True, exist_ok=True)
        data = window.model_dump_json(indent=2)
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

Run: `source .venv/bin/activate && pytest test/unit/test_incident_store.py -v`
Expected: PASS (8 tests)

- [ ] **Step 5: Run the lint gates**

Run: `source .venv/bin/activate && flake8 test/ tether_ddns/ && ruff check && mypy . && pyright`
Expected: all clean

- [ ] **Step 6: Commit**

```bash
git add tether_ddns/incident_store.py test/unit/test_incident_store.py
git commit -m "feat: add fail-soft incident window store"
```

---

### Task 3: Incident recorder

This is the heart of the feature. The write-policy test in Step 1 is a hard requirement from the design review, not an optional extra.

**Files:**
- Create: `tether_ddns/services/incidents.py`
- Test: `test/unit/test_incident_recorder.py`

**Interfaces:**
- Consumes: everything from Tasks 1 and 2, including the `make_result` fixture in `test/unit/conftest.py`.
- Produces: `IncidentRecorder(store: IncidentStore)` with
  - `record(result: ReachabilityResult, now: float | None = None) -> IncidentView`
  - `view` property `-> IncidentView`
  - `window(now: float | None = None) -> IncidentWindow` — filtered to the retention period
  - `flush() -> None` — persist in-memory widening

`now` is injectable purely so tests can drive time deterministically; production callers omit it.

Construction has one deliberate side effect: if the file does not exist yet, it is written once. Without this, `monitoring_since` would be regenerated on every restart until the first incident, and the clamped uptime denominator would silently reset — defeating spec decision 7.

- [ ] **Step 1: Write the failing tests**

Create `test/unit/test_incident_recorder.py`:

```python
"""Tests for the IncidentRecorder transition table and write policy."""
import time
from pathlib import Path
from typing import Callable
from unittest.mock import patch

from tether_ddns.incident_store import IncidentStore
from tether_ddns.incidents import (
    WINDOW_SECONDS,
    Incident,
    IncidentWindow,
)
from tether_ddns.reachability import ReachabilityResult
from tether_ddns.services.incidents import IncidentRecorder

HEALTHY = [True, True, True]
DEGRADED = [True, True, False]
OUTAGE = [True, False, False]

ResultFactory = Callable[[list[bool]], ReachabilityResult]


def test_healthy_checks_open_no_incident(
    tmp_path: Path, make_result: ResultFactory
) -> None:
    """A run of healthy checks leaves the window empty."""
    recorder = IncidentRecorder(IncidentStore(tmp_path / 'i.json'))
    for tick in range(5):
        view = recorder.record(make_result(HEALTHY), now=float(tick))
    assert view.ongoing is None
    assert recorder.window(now=10.0).incidents == []


def test_first_bad_check_opens_an_incident(
    tmp_path: Path, make_result: ResultFactory
) -> None:
    """The first non-healthy check opens an ongoing incident."""
    recorder = IncidentRecorder(IncidentStore(tmp_path / 'i.json'))
    view = recorder.record(make_result(OUTAGE), now=100.0)
    assert view.ongoing is not None
    assert view.ongoing.severity == 'outage'
    assert view.ongoing.start == 100.0
    assert view.ongoing.end is None


def test_same_severity_checks_extend_one_incident(
    tmp_path: Path, make_result: ResultFactory
) -> None:
    """Consecutive checks at the same severity merge into one span."""
    recorder = IncidentRecorder(IncidentStore(tmp_path / 'i.json'))
    recorder.record(make_result(OUTAGE), now=100.0)
    recorder.record(make_result(OUTAGE), now=130.0)
    view = recorder.record(make_result(HEALTHY), now=160.0)
    window = recorder.window(now=200.0)
    assert view.ongoing is None
    assert len(window.incidents) == 1
    assert window.incidents[0].start == 100.0
    assert window.incidents[0].end == 160.0


def test_severity_change_splits_into_contiguous_spans(
    tmp_path: Path, make_result: ResultFactory
) -> None:
    """A severity change closes one incident and opens the next at the same instant."""
    recorder = IncidentRecorder(IncidentStore(tmp_path / 'i.json'))
    recorder.record(make_result(DEGRADED), now=100.0)
    recorder.record(make_result(OUTAGE), now=130.0)
    recorder.record(make_result(HEALTHY), now=160.0)
    window = recorder.window(now=200.0)
    assert [i.severity for i in window.incidents] == ['degraded', 'outage']
    assert window.incidents[0].end == 130.0
    assert window.incidents[1].start == 130.0


def test_incident_records_worst_quorum_and_failed_resolvers(
    tmp_path: Path, make_result: ResultFactory
) -> None:
    """An incident keeps the worst quorum and the union of failed resolvers."""
    recorder = IncidentRecorder(IncidentStore(tmp_path / 'i.json'))
    recorder.record(make_result([True, False, False]), now=100.0)
    recorder.record(make_result([False, False, False]), now=130.0)
    recorder.record(make_result(HEALTHY), now=160.0)
    incident = recorder.window(now=200.0).incidents[0]
    assert incident.min_successes == 0
    assert incident.failed == ['10.0.0.0', '10.0.0.1', '10.0.0.2']


def test_no_disk_writes_while_healthy_or_steady(
    tmp_path: Path, make_result: ResultFactory
) -> None:
    """Disk writes happen only on open, close, split and prune."""
    store = IncidentStore(tmp_path / 'i.json')
    recorder = IncidentRecorder(store)
    with patch.object(store, 'save', wraps=store.save) as save:
        recorder.record(make_result(HEALTHY), now=100.0)
        recorder.record(make_result(HEALTHY), now=130.0)
        assert save.call_count == 0, 'healthy checks must not write'

        recorder.record(make_result(OUTAGE), now=160.0)
        assert save.call_count == 1, 'opening an incident writes once'

        recorder.record(make_result(OUTAGE), now=190.0)
        recorder.record(make_result(OUTAGE), now=220.0)
        assert save.call_count == 1, 'a steady incident must not write'

        recorder.record(make_result(DEGRADED), now=250.0)
        assert save.call_count == 2, 'a severity split writes once'

        recorder.record(make_result(HEALTHY), now=280.0)
        assert save.call_count == 3, 'closing an incident writes once'

        recorder.record(make_result(HEALTHY), now=310.0)
        assert save.call_count == 3, 'healthy checks after close must not write'


def test_prune_writes_only_when_a_record_expires(
    tmp_path: Path, make_result: ResultFactory
) -> None:
    """A tick prunes and writes only when an incident actually falls out."""
    path = tmp_path / 'i.json'
    end = time.time() - WINDOW_SECONDS / 2
    IncidentStore(path).save(IncidentWindow(
        monitoring_since=end - 110, rev=1, ongoing=None,
        incidents=[Incident(
            start=end - 100, end=end, severity='outage',
            min_successes=0, total=3, failed=[])]))
    store = IncidentStore(path)
    recorder = IncidentRecorder(store)
    with patch.object(store, 'save', wraps=store.save) as save:
        recorder.record(make_result(HEALTHY), now=end + 100)
        assert save.call_count == 0
        recorder.record(make_result(HEALTHY), now=end + WINDOW_SECONDS + 1)
        assert save.call_count == 1
    assert recorder.window(now=end + WINDOW_SECONDS + 1).incidents == []


def test_rev_is_stable_across_healthy_checks(
    tmp_path: Path, make_result: ResultFactory
) -> None:
    """The revision counter does not move on a healthy tick."""
    recorder = IncidentRecorder(IncidentStore(tmp_path / 'i.json'))
    first = recorder.record(make_result(HEALTHY), now=100.0).rev
    second = recorder.record(make_result(HEALTHY), now=130.0).rev
    assert first == second


def test_rev_advances_on_open_and_close(
    tmp_path: Path, make_result: ResultFactory
) -> None:
    """The revision counter advances on each real mutation."""
    recorder = IncidentRecorder(IncidentStore(tmp_path / 'i.json'))
    opened = recorder.record(make_result(OUTAGE), now=100.0).rev
    steady = recorder.record(make_result(OUTAGE), now=130.0).rev
    closed = recorder.record(make_result(HEALTHY), now=160.0).rev
    assert steady == opened
    assert closed > opened


def test_restart_closes_ongoing_at_first_healthy_check(
    tmp_path: Path, make_result: ResultFactory
) -> None:
    """An incident in flight when the process died ends at the first check back."""
    path = tmp_path / 'i.json'
    IncidentStore(path).save(IncidentWindow(
        monitoring_since=0.0, rev=3, incidents=[],
        ongoing=Incident(
            start=100.0, end=None, severity='outage',
            min_successes=0, total=3, failed=['10.0.0.1'])))
    recorder = IncidentRecorder(IncidentStore(path))
    recorder.record(make_result(HEALTHY), now=5000.0)
    window = recorder.window(now=5000.0)
    assert window.ongoing is None
    assert window.incidents[0].start == 100.0
    assert window.incidents[0].end == 5000.0


def test_restart_extends_ongoing_at_same_severity(
    tmp_path: Path, make_result: ResultFactory
) -> None:
    """A still-failing check after restart extends the persisted incident."""
    path = tmp_path / 'i.json'
    IncidentStore(path).save(IncidentWindow(
        monitoring_since=0.0, rev=3, incidents=[],
        ongoing=Incident(
            start=100.0, end=None, severity='outage',
            min_successes=1, total=3, failed=['10.0.0.1'])))
    recorder = IncidentRecorder(IncidentStore(path))
    view = recorder.record(make_result(OUTAGE), now=5000.0)
    assert view.ongoing is not None
    assert view.ongoing.start == 100.0


def test_prune_on_load_writes_when_records_expire(tmp_path: Path) -> None:
    """Loading a stale file prunes it and rewrites immediately."""
    path = tmp_path / 'i.json'
    IncidentStore(path).save(IncidentWindow(
        monitoring_since=0.0, rev=1, ongoing=None,
        incidents=[Incident(
            start=1.0, end=2.0, severity='outage',
            min_successes=0, total=3, failed=[])]))
    recorder = IncidentRecorder(IncidentStore(path))
    assert recorder.window().incidents == []
    assert IncidentStore(path).load().incidents == []


def test_first_start_persists_monitoring_since(tmp_path: Path) -> None:
    """A first-ever start writes the file so monitoring_since is stable."""
    path = tmp_path / 'i.json'
    recorder = IncidentRecorder(IncidentStore(path))
    assert path.exists()
    since = recorder.window().monitoring_since
    restarted = IncidentRecorder(IncidentStore(path))
    assert restarted.window().monitoring_since == since


def test_later_starts_do_not_rewrite_the_file(tmp_path: Path) -> None:
    """Starting against an existing, current file writes nothing."""
    path = tmp_path / 'i.json'
    IncidentRecorder(IncidentStore(path))
    store = IncidentStore(path)
    with patch.object(store, 'save') as save:
        IncidentRecorder(store)
        assert save.call_count == 0


def test_flush_persists_widening_of_a_steady_incident(
    tmp_path: Path, make_result: ResultFactory
) -> None:
    """flush writes the in-memory widening that a steady tick skipped."""
    path = tmp_path / 'i.json'
    recorder = IncidentRecorder(IncidentStore(path))
    recorder.record(make_result([True, False, False]), now=100.0)
    recorder.record(make_result([False, False, False]), now=130.0)
    recorder.flush()
    ongoing = IncidentStore(path).load().ongoing
    assert ongoing is not None
    assert ongoing.min_successes == 0


def test_flush_is_a_no_op_when_nothing_changed(
    tmp_path: Path, make_result: ResultFactory
) -> None:
    """flush does not write when no widening is pending."""
    store = IncidentStore(tmp_path / 'i.json')
    recorder = IncidentRecorder(store)
    recorder.record(make_result(HEALTHY), now=100.0)
    with patch.object(store, 'save') as save:
        recorder.flush()
        assert save.call_count == 0


def test_window_filters_expired_records_on_read(
    tmp_path: Path, make_result: ResultFactory
) -> None:
    """The served window excludes records outside the retention period."""
    path = tmp_path / 'i.json'
    recorder = IncidentRecorder(IncidentStore(path))
    recorder.record(make_result(OUTAGE), now=100.0)
    recorder.record(make_result(HEALTHY), now=200.0)
    later = 200.0 + WINDOW_SECONDS + 1
    assert recorder.window(now=later).incidents == []
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `source .venv/bin/activate && pytest test/unit/test_incident_recorder.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'tether_ddns.services.incidents'`

- [ ] **Step 3: Write the implementation**

Create `tether_ddns/services/incidents.py`:

```python
"""Records reachability incidents into the persisted 30-day window."""
from __future__ import annotations

import time

from tether_ddns.incident_store import IncidentStore
from tether_ddns.incidents import (
    WINDOW_SECONDS,
    Incident,
    IncidentView,
    IncidentWindow,
    Severity,
    classify,
    failed_ips,
    prune,
)
from tether_ddns.reachability import ReachabilityResult


class IncidentRecorder:
    """Turns a stream of reachability checks into persisted incidents."""

    def __init__(self, store: IncidentStore) -> None:
        """Load and prune the window, ensuring it exists on disk.

        The first ever start writes the file so ``monitoring_since`` is stable
        across restarts; every later healthy start writes nothing.
        """
        self._store = store
        self._dirty = False
        existed = store.path.exists()
        self._window = store.load()
        pruned = prune(self._window, time.time() - WINDOW_SECONDS)
        if pruned:
            self._window.rev += 1
        if pruned or not existed:
            self._store.save(self._window)

    @property
    def view(self) -> IncidentView:
        """Return the ongoing incident and current revision."""
        return IncidentView(self._window.ongoing, self._window.rev)

    def window(self, now: float | None = None) -> IncidentWindow:
        """Return the window filtered to the retention period."""
        cutoff = (time.time() if now is None else now) - WINDOW_SECONDS
        return self._window.model_copy(update={
            'incidents': [
                i for i in self._window.incidents
                if i.end is None or i.end >= cutoff
            ],
        })

    def record(
        self, result: ReachabilityResult, now: float | None = None,
    ) -> IncidentView:
        """Fold one check into the window, writing only on a real change."""
        ts = time.time() if now is None else now
        changed = prune(self._window, ts - WINDOW_SECONDS)
        severity = classify(result)
        ongoing = self._window.ongoing
        if ongoing is None:
            if severity is not None:
                self._open(severity, result, ts)
                changed = True
        elif severity is None:
            self._close(ongoing, ts)
            changed = True
        elif severity == ongoing.severity:
            self._dirty = self._widen(ongoing, result) or self._dirty
        else:
            self._close(ongoing, ts)
            self._open(severity, result, ts)
            changed = True
        if changed:
            self._window.rev += 1
            self._store.save(self._window)
            self._dirty = False
        return self.view

    def flush(self) -> None:
        """Persist pending in-memory widening of an ongoing incident."""
        if self._dirty:
            self._store.save(self._window)
            self._dirty = False

    def _open(
        self, severity: Severity, result: ReachabilityResult, ts: float,
    ) -> None:
        """Start a new ongoing incident at ``ts``."""
        self._window.ongoing = Incident(
            start=ts, end=None, severity=severity,
            min_successes=result.successes, total=result.total,
            failed=failed_ips(result))

    def _close(self, ongoing: Incident, ts: float) -> None:
        """End the ongoing incident at ``ts`` and file it."""
        ongoing.end = ts
        self._window.incidents.append(ongoing)
        self._window.ongoing = None

    @staticmethod
    def _widen(ongoing: Incident, result: ReachabilityResult) -> bool:
        """Absorb a check into an ongoing incident; True if anything changed."""
        changed = False
        if result.successes < ongoing.min_successes:
            ongoing.min_successes = result.successes
            ongoing.total = result.total
            changed = True
        for ip in failed_ips(result):
            if ip not in ongoing.failed:
                ongoing.failed.append(ip)
                changed = True
        return changed
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `source .venv/bin/activate && pytest test/unit/test_incident_recorder.py -v`
Expected: PASS (17 tests)

- [ ] **Step 5: Run the lint gates**

Run: `source .venv/bin/activate && flake8 test/ tether_ddns/ && ruff check && mypy . && pyright`
Expected: all clean

- [ ] **Step 6: Commit**

```bash
git add tether_ddns/services/incidents.py test/unit/test_incident_recorder.py
git commit -m "feat: record reachability incidents with write-on-change policy"
```

---

### Task 4: Runtime state integration

**Files:**
- Modify: `tether_ddns/runtime.py`
- Modify: `test/unit/test_runtime.py`

**Interfaces:**
- Consumes: `Incident`, `IncidentView` from Task 1.
- Produces: `RuntimeState.record_reachability(result: ReachabilityResult, view: IncidentView) -> bool`; `snapshot()['reachability']` gains `rev` and `ongoing`, and loses `checks` and `online`.

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/test_runtime.py` (keep existing imports alphabetical when adding):

```python
def test_record_reachability_publishes_the_incident_view() -> None:
    """The snapshot exposes the recorder's ongoing incident and revision."""
    state = RuntimeState()
    ongoing = Incident(
        start=100.0, end=None, severity='outage',
        min_successes=0, total=3, failed=['1.1.1.1'])
    result = ReachabilityResult(
        online=False, successes=0, total=3, details={}, probes=[])
    state.record_reachability(result, IncidentView(ongoing, 7))
    reach = state.snapshot()['reachability']
    assert isinstance(reach, dict)
    assert reach['rev'] == 7
    assert reach['ongoing'] == ongoing.model_dump()


def test_snapshot_omits_the_since_boot_counters() -> None:
    """The retired check counters are gone from the snapshot."""
    state = RuntimeState()
    reach = state.snapshot()['reachability']
    assert isinstance(reach, dict)
    assert 'checks' not in reach
    assert 'online' not in reach


def test_incident_fields_are_not_persisted() -> None:
    """Incident view fields are excluded from the persisted payload."""
    state = RuntimeState()
    result = ReachabilityResult(
        online=True, successes=3, total=3, details={}, probes=[])
    state.record_reachability(result, IncidentView(None, 12))
    assert 'incident_rev' not in state.model_dump()
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `source .venv/bin/activate && pytest test/unit/test_runtime.py -v`
Expected: FAIL — `record_reachability()` takes 2 positional arguments but 3 were given

- [ ] **Step 3: Write the implementation**

In `tether_ddns/runtime.py`:

Add to the imports (alphabetical):

```python
from tether_ddns.incidents import Incident, IncidentView
```

Replace the persistence-exclusion comment block's counter fields. Delete these two lines:

```python
    reachability_checks: int = Field(default=0, exclude=True)
    reachability_online: int = Field(default=0, exclude=True)
```

and add, next to the other excluded reachability fields:

```python
    incident_rev: int = Field(default=0, exclude=True)
    incident_ongoing: Incident | None = Field(default=None, exclude=True)
```

Delete these two lines from `restore()`:

```python
        self.reachability_checks = other.reachability_checks
        self.reachability_online = other.reachability_online
```

Replace `record_reachability`:

```python
    def record_reachability(
        self, result: ReachabilityResult, view: IncidentView,
    ) -> bool:
        """Record a reachability check; return True on an online transition."""
        transitioned = result.online != self.online
        if transitioned:
            self.reachability_since = time.time()
        self.reachability_history.append(CheckRecord(
            ts=time.time(), successes=result.successes, total=result.total))
        self.reachability_latest = list(result.probes)
        self.incident_ongoing = view.ongoing
        self.incident_rev = view.rev
        self.online = result.online
        self._emit()
        return transitioned
```

Replace the `reachability` block in `snapshot()`:

```python
            'reachability': {
                'since': self.reachability_since,
                'rev': self.incident_rev,
                'ongoing': (
                    self.incident_ongoing.model_dump()
                    if self.incident_ongoing is not None else None),
                'history': [r.model_dump() for r in self.reachability_history],
                'latest': [p.model_dump() for p in self.reachability_latest],
            },
```

Update the comment above the excluded fields so it describes the current design — the series is still live-only, but uptime is now derived from the incident window rather than from since-boot counters.

- [ ] **Step 4: Update the existing tests that used the removed counters**

Run: `source .venv/bin/activate && grep -n "record_reachability\|reachability_checks\|reachability_online" test/unit/test_runtime.py`

Apply these edits to `test/unit/test_runtime.py`:

- Add `from tether_ddns.incidents import Incident, IncidentView` to the imports, alphabetically before the `tether_ddns.reachability` import.
- Every `state.record_reachability(<result>)` call gains a second argument: `state.record_reachability(<result>, IncidentView(None, 0))`.
- The snapshot key-set assertion `{'since', 'checks', 'online', 'history', 'latest'}` becomes `{'since', 'rev', 'ongoing', 'history', 'latest'}`, and the `reach_dict['checks'] == 1` assertion below it is deleted.
- Delete `test_record_reachability_accumulates` and `test_record_reachability_counts_only_online` outright — they exist only to exercise the removed counters. Replace them with:

```python
def test_record_reachability_detects_transitions() -> None:
    """record_reachability reports only the checks that flip online state."""
    state = RuntimeState()
    view = IncidentView(None, 0)
    assert state.record_reachability(_result(True), view) is True
    assert state.record_reachability(_result(True), view) is False
```

- Delete every remaining assertion naming `reachability_checks` or `reachability_online`: the two `not in dumped` assertions, the pair after `restore`, the pair in the rebuild test, and the `reach['checks']`/`reach['online']` pair in the snapshot test.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `source .venv/bin/activate && pytest test/unit/test_runtime.py test/unit/test_main.py -v`
Expected: PASS

- [ ] **Step 6: Run the lint gates**

Run: `source .venv/bin/activate && flake8 test/ tether_ddns/ && ruff check && mypy . && pyright`
Expected: all clean

- [ ] **Step 7: Commit**

```bash
git add tether_ddns/runtime.py test/unit/test_runtime.py test/unit/test_main.py
git commit -m "feat: publish incident view in runtime snapshot, drop boot counters"
```

---

### Task 5: Context, app and scheduler wiring

**Files:**
- Modify: `tether_ddns/context.py`
- Modify: `tether_ddns/scheduler.py`
- Modify: `tether_ddns/app.py`
- Modify: `test/unit/test_context.py`, `test/unit/test_scheduler.py`

**Interfaces:**
- Consumes: `IncidentRecorder` (Task 3), `RuntimeState.record_reachability(result, view)` (Task 4).
- Produces: `AppContext.incidents: IncidentRecorder`, `AppContext.persist_incidents()`. `Scheduler.check_reachability` records incidents before emitting; `Scheduler.shutdown` flushes them.

`AppContext` is a dataclass with positional fields; `incidents` is added as the **last** field so existing positional construction in tests keeps working until updated.

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/test_scheduler.py`. The file's `_ctx` helper needs a sixth `AppContext` argument, so add a recorder factory and thread it through:

```python
def _recorder() -> IncidentRecorder:
    """Build an IncidentRecorder bound to a throwaway temp file."""
    return IncidentRecorder(IncidentStore(Path(mkdtemp()) / 'incidents.json'))


def _ctx(
    cfg: AppConfig, state: RuntimeState, state_store: StateStore | None = None,
    incidents: IncidentRecorder | None = None,
) -> AppContext:
    """Build an AppContext for dispatch tests."""
    store = state_store if state_store is not None else MagicMock()
    recorder = incidents if incidents is not None else _recorder()
    return AppContext(cfg, state, MagicMock(), store, MagicMock(), recorder)
```

Add `from tempfile import mkdtemp`, `from tether_ddns.incident_store import IncidentStore` and `from tether_ddns.services.incidents import IncidentRecorder` to the imports, keeping them alphabetical. Then add the new tests:

```python
@pytest.mark.asyncio
async def test_check_reachability_records_an_incident() -> None:
    """A failing check is folded into the incident window."""
    ctx = _ctx(AppConfig(), RuntimeState())
    probe = ReachabilityProbe()
    sched = scheduler.Scheduler(
        ctx, SyncService(ctx, AsyncMock()), AsyncMock(), probe)
    with patch.object(probe, 'check', new=AsyncMock(return_value=_online(False))):
        await sched.check_reachability()
    ongoing = ctx.incidents.view.ongoing
    assert ongoing is not None
    assert ongoing.severity == 'outage'


@pytest.mark.asyncio
async def test_check_reachability_emits_once_per_tick() -> None:
    """Recording an incident does not produce a second state emit."""
    state = RuntimeState()
    ctx = _ctx(AppConfig(), state)
    emits: list[dict[str, object]] = []
    state.add_listener(emits.append)
    probe = ReachabilityProbe()
    sched = scheduler.Scheduler(
        ctx, SyncService(ctx, AsyncMock()), AsyncMock(), probe)
    with patch.object(probe, 'check', new=AsyncMock(return_value=_online(False))):
        await sched.check_reachability()
    assert len(emits) == 1


def test_shutdown_flushes_the_incident_window() -> None:
    """Shutdown persists pending incident widening before stopping."""
    ctx = _ctx(AppConfig(), RuntimeState())
    sched = scheduler.Scheduler(
        ctx, SyncService(ctx, AsyncMock()), AsyncMock(), ReachabilityProbe())
    with patch.object(ctx.incidents, 'flush') as flush:
        sched.shutdown()
    flush.assert_called_once()
```

Note: helpers prefixed with `_` are exempt from the D103 docstring rule, which is why the existing `_online` helper has none. Test functions themselves are not exempt.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `source .venv/bin/activate && pytest test/unit/test_scheduler.py -v`
Expected: FAIL — `AppContext` has no attribute `incidents`

- [ ] **Step 3: Write the implementation**

In `tether_ddns/context.py`:

```python
from tether_ddns.services.incidents import IncidentRecorder
```

Add the field and method:

```python
@dataclass
class AppContext:
    """Bundles shared mutable state for controllers and the scheduler."""

    config: AppConfig
    runtime: RuntimeState
    config_store: ConfigStore
    state_store: StateStore
    manager: ConnectionManager
    incidents: IncidentRecorder

    ...

    def persist_incidents(self) -> None:
        """Save the current incident window to disk."""
        self.incidents.flush()
```

In `tether_ddns/scheduler.py`, replace `check_reachability`:

```python
    async def check_reachability(self) -> None:
        """Run the DNS-quorum check; fire reachability_changed on transition."""
        state = self._ctx.runtime
        was_online = state.online
        reach = await self._reachability.check()
        view = self._ctx.incidents.record(reach)
        if state.record_reachability(reach, view):
            await self._dispatch.dispatch(
                'reachability_changed',
                ReachabilityChangedEvent(
                    online=reach.online, was_online=was_online))
```

and `shutdown`:

```python
    def shutdown(self) -> None:
        """Flush runtime state and incidents, then stop the scheduler."""
        self.flush_state()
        self._ctx.persist_incidents()
        if self._scheduler.running:
            self._scheduler.shutdown(wait=False)
```

In `tether_ddns/app.py`, add imports (alphabetical):

```python
from tether_ddns.incident_store import IncidentStore
from tether_ddns.services.incidents import IncidentRecorder
```

and build the recorder before the context. Derive the incident path from the **resolved state store**, not from the environment — `create_app` accepts an injected `StateStore`, and tests inject one under `tmp_path`. Using `IncidentStore()` here would resolve against the environment and write an incident file into the repository root during the test suite:

```python
        recorder = IncidentRecorder(
            IncidentStore.beside(resolved_state_store.path))
        ctx = AppContext(
            config, runtime, resolved_config_store, resolved_state_store,
            manager, recorder)
```

Publish the loaded view immediately so a browser connecting before the first tick sees the persisted ongoing incident:

```python
        runtime.incident_ongoing = recorder.view.ongoing
        runtime.incident_rev = recorder.view.rev
```

Place those two lines directly after the recorder is constructed and before `runtime.rebuild(config)`, so the rebuild's `_emit()` carries them.

- [ ] **Step 4: Fix every other `AppContext(...)` construction**

Run: `source .venv/bin/activate && grep -rn "AppContext(" test/ tether_ddns/`

Each remaining call site gains a sixth argument. In tests, bind the store under `tmp_path` (or `mkdtemp()` where no `tmp_path` fixture is in scope) so nothing writes into the repository.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `source .venv/bin/activate && pytest test/ -v`
Expected: PASS

- [ ] **Step 6: Run the lint and coverage gates**

Run: `source .venv/bin/activate && flake8 test/ tether_ddns/ && ruff check && mypy . && pyright && pytest test/ --cov=tether_ddns --cov-fail-under=90`
Expected: all clean

- [ ] **Step 7: Commit**

```bash
git add tether_ddns/context.py tether_ddns/scheduler.py tether_ddns/app.py test/
git commit -m "feat: wire the incident recorder into the scheduler tick"
```

---

### Task 6: Incidents API endpoint

**Files:**
- Modify: `tether_ddns/api.py`
- Modify: `test/unit/test_api.py`

**Interfaces:**
- Consumes: `AppContext.incidents` (Task 5), `IncidentRecorder.window()` (Task 3).
- Produces: `GET /api/reachability/incidents` returning the serialised `IncidentWindow`.

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/test_api.py`. It already has a `_client(tmp_path)` helper returning a `TestClient`; use it as a context manager so the lifespan runs. Extend the existing `from typing import Any` import to `from typing import Any, Callable`, and add `import time` plus `from tether_ddns.incidents import WINDOW_SECONDS`, keeping imports alphabetical. Reuse the `make_result` fixture from `test/unit/conftest.py` rather than defining local result builders.

```python
ResultFactory = Callable[[list[bool]], ReachabilityResult]


def test_get_incidents_returns_the_window(tmp_path: Path) -> None:
    """The incidents endpoint returns the persisted window."""
    with _client(tmp_path) as client:
        res = client.get('/api/reachability/incidents')
    assert res.status_code == 200
    body = res.json()
    assert body['incidents'] == []
    assert body['ongoing'] is None
    assert 'monitoring_since' in body
    assert 'rev' in body


def test_get_incidents_filters_expired_records(
    tmp_path: Path, make_result: ResultFactory
) -> None:
    """Records outside the retention period are not served."""
    with _client(tmp_path) as client:
        recorder = client.app.state.ctx.incidents
        old = time.time() - WINDOW_SECONDS - 100
        recorder.record(make_result([False, False, False]), now=old)
        recorder.record(make_result([True, True, True]), now=old + 50)
        res = client.get('/api/reachability/incidents')
    assert res.json()['incidents'] == []
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `source .venv/bin/activate && pytest test/unit/test_api.py -v`
Expected: FAIL — 404 Not Found

- [ ] **Step 3: Write the implementation**

In `tether_ddns/api.py`, add the route beside `/state`:

```python
    @router.get('/reachability/incidents')
    def get_incidents() -> dict[str, object]:
        return app.state.ctx.incidents.window().model_dump()
```

The route takes no parameters and performs no I/O beyond an in-memory filter, so there is no untrusted input to validate.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `source .venv/bin/activate && pytest test/unit/test_api.py -v`
Expected: PASS

- [ ] **Step 5: Run the lint gates**

Run: `source .venv/bin/activate && flake8 test/ tether_ddns/ && ruff check && mypy . && pyright`
Expected: all clean

- [ ] **Step 6: Commit**

```bash
git add tether_ddns/api.py test/unit/test_api.py
git commit -m "feat: serve the 30-day incident window over REST"
```

---

### Task 7: Frontend types, client and hook

**Files:**
- Modify: `frontend/src/types.ts`, `frontend/src/api.ts`, `frontend/src/types.test.ts`, `frontend/src/useLiveState.test.tsx`
- Create: `frontend/src/useIncidents.ts`, `frontend/src/useIncidents.test.tsx`

**Interfaces:**
- Consumes: the payload shapes from Tasks 4 and 6.
- Produces: `Severity`, `Incident`, `IncidentWindow` types; `getIncidents()`; `useIncidents(rev: number): IncidentWindow | null`.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/useIncidents.test.tsx`:

```tsx
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { useIncidents } from './useIncidents';
import type { IncidentWindow } from './types';

const EMPTY: IncidentWindow = { monitoring_since: 0, rev: 1, incidents: [], ongoing: null };

afterEach(() => { vi.restoreAllMocks(); });

describe('useIncidents', () => {
  test('fetches the window on mount', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(EMPTY), { status: 200 }));
    const { result } = renderHook(({ rev }) => useIncidents(rev), { initialProps: { rev: 1 } });
    await waitFor(() => expect(result.current).not.toBeNull());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('refetches when rev changes', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(EMPTY), { status: 200 }));
    const { rerender } = renderHook(({ rev }) => useIncidents(rev), { initialProps: { rev: 1 } });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    rerender({ rev: 2 });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  test('refetches when rev resets after a server restart', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(EMPTY), { status: 200 }));
    const { rerender } = renderHook(({ rev }) => useIncidents(rev), { initialProps: { rev: 9 } });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    rerender({ rev: 0 });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  test('does not refetch when rev is unchanged', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(EMPTY), { status: 200 }));
    const { rerender } = renderHook(({ rev }) => useIncidents(rev), { initialProps: { rev: 3 } });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    rerender({ rev: 3 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/useIncidents.test.tsx`
Expected: FAIL — cannot resolve `./useIncidents`

- [ ] **Step 3: Write the implementation**

In `frontend/src/types.ts`, add:

```ts
export type Severity = 'degraded' | 'outage';

export interface Incident {
  start: number;
  end: number | null;
  severity: Severity;
  min_successes: number;
  total: number;
  failed: string[];
}

export interface IncidentWindow {
  monitoring_since: number;
  rev: number;
  incidents: Incident[];
  ongoing: Incident | null;
}
```

and reshape `Reachability` — remove `checks` and `online`, add `rev` and `ongoing`:

```ts
export interface Reachability {
  since: number;
  rev: number;
  ongoing: Incident | null;
  history: CheckRecord[];
  latest: ResolverProbe[];
}
```

In `frontend/src/api.ts`, add the import of `IncidentWindow` to the existing type import and:

```ts
export const getIncidents = () => json<IncidentWindow>('/api/reachability/incidents');
```

Create `frontend/src/useIncidents.ts`:

```ts
import { useEffect, useState } from 'react';
import { getIncidents } from './api';
import type { IncidentWindow } from './types';

// Refetches whenever `rev` changes value. The effect dependency uses Object.is,
// so a server restart that resets rev to a lower number still refetches.
export function useIncidents(rev: number): IncidentWindow | null {
  const [data, setData] = useState<IncidentWindow | null>(null);

  useEffect(() => {
    let cancelled = false;
    getIncidents()
      .then((w) => { if (!cancelled) setData(w); })
      .catch(() => { if (!cancelled) setData(null); });
    return () => { cancelled = true; };
  }, [rev]);

  return data;
}
```

Do not name the state variable `window` — it shadows the global and oxlint will reject it.

- [ ] **Step 4: Update the existing type and snapshot tests**

`frontend/src/types.test.ts` asserts `Reachability` has `history`; add assertions for `rev` and `ongoing`. `frontend/src/useLiveState.test.tsx` builds a `reachability` fixture with `checks`/`online`; replace those keys with `rev: 0, ongoing: null`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd frontend && npm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add frontend/src/types.ts frontend/src/api.ts frontend/src/useIncidents.ts frontend/src/useIncidents.test.tsx frontend/src/types.test.ts frontend/src/useLiveState.test.tsx
git commit -m "feat: add incident types, client and refetch-on-rev hook"
```

---

### Task 8: Day bucketing and uptime maths

**Files:**
- Modify: `frontend/src/utils.ts`, `frontend/src/utils.test.ts`

**Interfaces:**
- Consumes: `Incident` (Task 7).
- Produces:
  - `type DaySeverity = 'healthy' | 'degraded' | 'outage'`
  - `interface DayBucket { start: number; end: number; worst: DaySeverity; incidents: Incident[]; offlineSeconds: number; degradedSeconds: number }`
  - `bucketByDay(incidents: Incident[], ongoing: Incident | null, nowMs?: number, days?: number): DayBucket[]`
  - `interface UptimeStats { pct: number; offlineSeconds: number; degradedSeconds: number; observedSeconds: number }`
  - `uptimeStats(incidents: Incident[], ongoing: Incident | null, monitoringSince: number, nowMs?: number, days?: number): UptimeStats`
  - `formatDuration(seconds: number): string` — hour/minute scale, for incident durations
  - `humanTime(seconds: number): string` — already exists as a private helper; add `export` to it. It handles the day and month scale that `formatDuration` deliberately does not, and Task 10 needs it for the observed-span sub-line (ten days must read `10d`, not `240h`).

All timestamps in `Incident` are epoch **seconds**; `nowMs` is milliseconds, matching the existing helpers in this file.

- [ ] **Step 1: Write the failing tests**

Add to `frontend/src/utils.test.ts`. The file already imports `{ describe, expect, it }` from `vitest` and a set of helpers from `./utils` — extend both import statements rather than adding duplicates, adding `test` to the vitest import:

```ts
import { bucketByDay, uptimeStats, formatDuration } from './utils';
import type { Incident } from './types';

const DAY = 86400;
// 2026-08-29T12:00:00 local time, expressed in ms.
const NOW_MS = new Date(2026, 7, 29, 12, 0, 0).getTime();
const NOW = NOW_MS / 1000;

function incident(start: number, end: number | null, severity: 'degraded' | 'outage'): Incident {
  return { start, end, severity, min_successes: 0, total: 3, failed: ['1.1.1.1'] };
}

test('bucketByDay returns one bucket per day, oldest first', () => {
  const buckets = bucketByDay([], null, NOW_MS, 30);
  expect(buckets).toHaveLength(30);
  expect(buckets[0].start).toBeLessThan(buckets[29].start);
});

test('bucketByDay marks a day with no incidents healthy', () => {
  const buckets = bucketByDay([], null, NOW_MS, 30);
  expect(buckets.every((b) => b.worst === 'healthy')).toBe(true);
});

test('bucketByDay attributes an incident to its day', () => {
  const buckets = bucketByDay([incident(NOW - 3600, NOW - 3000, 'outage')], null, NOW_MS, 30);
  const today = buckets[29];
  expect(today.worst).toBe('outage');
  expect(today.incidents).toHaveLength(1);
  expect(today.offlineSeconds).toBe(600);
});

test('bucketByDay clips an incident that crosses midnight into both days', () => {
  const midnight = new Date(2026, 7, 29, 0, 0, 0).getTime() / 1000;
  const buckets = bucketByDay(
    [incident(midnight - 1140, midnight + 900, 'outage')], null, NOW_MS, 30);
  expect(buckets[28].worst).toBe('outage');
  expect(buckets[28].offlineSeconds).toBe(1140);
  expect(buckets[29].worst).toBe('outage');
  expect(buckets[29].offlineSeconds).toBe(900);
});

test('bucketByDay treats an ongoing incident as running to now', () => {
  const buckets = bucketByDay([], incident(NOW - 300, null, 'outage'), NOW_MS, 30);
  expect(buckets[29].offlineSeconds).toBe(300);
});

test('bucketByDay ranks outage above degraded on the same day', () => {
  const buckets = bucketByDay(
    [incident(NOW - 7200, NOW - 7000, 'degraded'), incident(NOW - 3600, NOW - 3400, 'outage')],
    null, NOW_MS, 30);
  expect(buckets[29].worst).toBe('outage');
});

test('bucketByDay uses local midnight boundaries across a DST change', () => {
  const buckets = bucketByDay([], null, NOW_MS, 30);
  for (const b of buckets) {
    const span = b.end - b.start;
    expect(span === DAY || span === DAY - 3600 || span === DAY + 3600).toBe(true);
  }
});

test('uptimeStats reports 100% for a clean window', () => {
  const stats = uptimeStats([], null, 0, NOW_MS, 30);
  expect(stats.pct).toBe(100);
  expect(stats.offlineSeconds).toBe(0);
});

test('uptimeStats excludes degraded time from downtime', () => {
  const stats = uptimeStats([incident(NOW - 3600, NOW - 3000, 'degraded')], null, 0, NOW_MS, 30);
  expect(stats.offlineSeconds).toBe(0);
  expect(stats.degradedSeconds).toBe(600);
  expect(stats.pct).toBe(100);
});

test('uptimeStats clamps the denominator to first observation', () => {
  const stats = uptimeStats([], null, NOW - DAY, NOW_MS, 30);
  expect(stats.observedSeconds).toBeCloseTo(DAY, 3);
});

test('uptimeStats counts an ongoing outage up to now', () => {
  const stats = uptimeStats([], incident(NOW - 600, null, 'outage'), NOW - DAY, NOW_MS, 30);
  expect(stats.offlineSeconds).toBe(600);
});

test('uptimeStats ignores incident time before first observation', () => {
  const stats = uptimeStats(
    [incident(NOW - 2 * DAY, NOW - 2 * DAY + 600, 'outage')], null, NOW - DAY, NOW_MS, 30);
  expect(stats.offlineSeconds).toBe(0);
});

test('formatDuration renders hours, minutes and seconds', () => {
  expect(formatDuration(45)).toBe('45s');
  expect(formatDuration(600)).toBe('10m');
  expect(formatDuration(3660)).toBe('1h 1m');
  expect(formatDuration(16080)).toBe('4h 28m');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run src/utils.test.ts`
Expected: FAIL — `bucketByDay is not a function`

- [ ] **Step 3: Write the implementation**

Add to `frontend/src/utils.ts`, and add `export` to the existing `humanTime` function:

```ts
import type { Incident } from './types';

export type DaySeverity = 'healthy' | 'degraded' | 'outage';

export interface DayBucket {
  start: number;
  end: number;
  worst: DaySeverity;
  incidents: Incident[];
  offlineSeconds: number;
  degradedSeconds: number;
}

export interface UptimeStats {
  pct: number;
  offlineSeconds: number;
  degradedSeconds: number;
  observedSeconds: number;
}

function overlap(inc: Incident, from: number, to: number, nowSec: number): number {
  const start = Math.max(inc.start, from);
  const end = Math.min(inc.end ?? nowSec, to);
  return Math.max(0, end - start);
}

export function bucketByDay(
  incidents: Incident[],
  ongoing: Incident | null,
  nowMs: number = Date.now(),
  days: number = 30,
): DayBucket[] {
  const nowSec = nowMs / 1000;
  const all = ongoing ? [...incidents, ongoing] : incidents;
  const midnight = new Date(nowMs);
  midnight.setHours(0, 0, 0, 0);
  const buckets: DayBucket[] = [];

  for (let back = days - 1; back >= 0; back -= 1) {
    const from = new Date(midnight);
    from.setDate(from.getDate() - back);
    const to = new Date(from);
    to.setDate(to.getDate() + 1);
    const start = from.getTime() / 1000;
    const end = to.getTime() / 1000;

    const hits: Incident[] = [];
    let offlineSeconds = 0;
    let degradedSeconds = 0;
    for (const inc of all) {
      const seconds = overlap(inc, start, end, nowSec);
      if (seconds <= 0) continue;
      hits.push(inc);
      if (inc.severity === 'outage') offlineSeconds += seconds;
      else degradedSeconds += seconds;
    }
    const worst: DaySeverity = offlineSeconds > 0
      ? 'outage'
      : (degradedSeconds > 0 ? 'degraded' : 'healthy');
    buckets.push({ start, end, worst, incidents: hits, offlineSeconds, degradedSeconds });
  }
  return buckets;
}

export function uptimeStats(
  incidents: Incident[],
  ongoing: Incident | null,
  monitoringSince: number,
  nowMs: number = Date.now(),
  days: number = 30,
): UptimeStats {
  const nowSec = nowMs / 1000;
  const windowStart = Math.max(monitoringSince, nowSec - days * 86400);
  const observedSeconds = Math.max(0, nowSec - windowStart);
  const all = ongoing ? [...incidents, ongoing] : incidents;

  let offlineSeconds = 0;
  let degradedSeconds = 0;
  for (const inc of all) {
    const seconds = overlap(inc, windowStart, nowSec, nowSec);
    if (inc.severity === 'outage') offlineSeconds += seconds;
    else degradedSeconds += seconds;
  }
  const pct = observedSeconds > 0
    ? ((observedSeconds - offlineSeconds) / observedSeconds) * 100
    : 100;
  return { pct, offlineSeconds, degradedSeconds, observedSeconds };
}

export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return s > 0 && m < 5 ? `${m}m ${s}s` : `${m}m`;
  return `${s}s`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/utils.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/utils.ts frontend/src/utils.test.ts
git commit -m "feat: add day bucketing and window uptime maths"
```

---

### Task 9: Incident modal

**Files:**
- Create: `frontend/src/components/IncidentModal.tsx`, `frontend/src/components/IncidentModal.test.tsx`
- Modify: `frontend/src/styles.css`

**Interfaces:**
- Consumes: `DayBucket` and `formatDuration` (Task 8), `Incident` (Task 7).
- Produces: `IncidentModal({ bucket, onClose }: { bucket: DayBucket | null; onClose: () => void })`.

A `null` bucket renders the overlay closed, matching how `DomainModal` uses an `open` flag.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/components/IncidentModal.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { IncidentModal } from './IncidentModal';
import type { DayBucket } from '../utils';
import type { Incident } from '../types';

const DAY_START = new Date(2026, 7, 29, 0, 0, 0).getTime() / 1000;
const DAY_END = new Date(2026, 7, 30, 0, 0, 0).getTime() / 1000;

function inc(startOffset: number, endOffset: number | null, severity: 'degraded' | 'outage'): Incident {
  return {
    start: DAY_START + startOffset,
    end: endOffset === null ? null : DAY_START + endOffset,
    severity,
    min_successes: severity === 'outage' ? 0 : 2,
    total: 3,
    failed: severity === 'outage' ? ['1.1.1.1', '8.8.8.8'] : ['8.8.8.8'],
  };
}

function bucket(incidents: Incident[]): DayBucket {
  return {
    start: DAY_START, end: DAY_END, worst: 'outage', incidents,
    offlineSeconds: 16080, degradedSeconds: 1020,
  };
}

describe('IncidentModal', () => {
  test('renders the day heading and summary', () => {
    const { container } = render(
      <IncidentModal bucket={bucket([inc(3600, 5000, 'outage')])} onClose={vi.fn()} />);
    // Heading format is locale-dependent; assert only that it names the day.
    expect(container.querySelector('.modal-head h3')?.textContent).toMatch(/29/);
    expect(screen.getByText('4h 28m')).toBeTruthy();
  });

  test('renders a severity tag for each incident', () => {
    render(<IncidentModal
      bucket={bucket([inc(3600, 5000, 'outage'), inc(40000, 41020, 'degraded')])}
      onClose={vi.fn()} />);
    expect(screen.getByText('outage')).toBeTruthy();
    expect(screen.getByText('degraded')).toBeTruthy();
  });

  test('renders an ongoing incident as running to now', () => {
    render(<IncidentModal bucket={bucket([inc(3600, null, 'outage')])} onClose={vi.fn()} />);
    expect(screen.getByText(/→ now/)).toBeTruthy();
    expect(screen.queryByText('ongoing')).toBeNull();
  });

  test('notes an incident inherited from the previous day', () => {
    const carried: Incident = { ...inc(0, 5000, 'outage'), start: DAY_START - 1140 };
    render(<IncidentModal bucket={bucket([carried])} onClose={vi.fn()} />);
    expect(screen.getByText(/previous day/)).toBeTruthy();
  });

  test('lists the resolvers that failed', () => {
    render(<IncidentModal bucket={bucket([inc(3600, 5000, 'outage')])} onClose={vi.fn()} />);
    expect(screen.getByText('1.1.1.1')).toBeTruthy();
    expect(screen.getByText('8.8.8.8')).toBeTruthy();
  });

  test('shows an empty state for a clean day', () => {
    const clean: DayBucket = {
      start: DAY_START, end: DAY_END, worst: 'healthy', incidents: [],
      offlineSeconds: 0, degradedSeconds: 0,
    };
    render(<IncidentModal bucket={clean} onClose={vi.fn()} />);
    expect(screen.getByText(/No incidents/)).toBeTruthy();
  });

  test('renders nothing open when the bucket is null', () => {
    const { container } = render(<IncidentModal bucket={null} onClose={vi.fn()} />);
    expect(container.querySelector('.modal-overlay.open')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/components/IncidentModal.test.tsx`
Expected: FAIL — cannot resolve `./IncidentModal`

- [ ] **Step 3: Write the implementation**

Create `frontend/src/components/IncidentModal.tsx`:

```tsx
import type { JSX } from 'react';
import type { Incident } from '../types';
import { formatDuration, type DayBucket } from '../utils';

export interface IncidentModalProps {
  bucket: DayBucket | null;
  onClose: () => void;
}

function clock(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString(undefined, {
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

function range(inc: Incident, bucket: DayBucket): string {
  const from = clock(Math.max(inc.start, bucket.start));
  if (inc.end === null) return `${from} → now`;
  return `${from} → ${clock(Math.min(inc.end, bucket.end))}`;
}

function spanSeconds(inc: Incident, bucket: DayBucket, nowSec: number): number {
  const start = Math.max(inc.start, bucket.start);
  const end = Math.min(inc.end ?? nowSec, bucket.end);
  return Math.max(0, end - start);
}

export function IncidentModal({ bucket, onClose }: IncidentModalProps): JSX.Element {
  const nowSec = Date.now() / 1000;
  const heading = bucket
    ? new Date(bucket.start * 1000).toLocaleDateString(undefined, {
      weekday: 'long', day: 'numeric', month: 'long',
    })
    : '';
  const span = bucket ? bucket.end - bucket.start : 1;
  const pct = bucket && span > 0
    ? (((span - bucket.offlineSeconds) / span) * 100).toFixed(1)
    : '100.0';

  return (
    <div
      className={`modal-overlay${bucket ? ' open' : ''}`}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="modal">
        <div className="modal-head">
          <h3>{heading}</h3>
          <button type="button" className="icon-btn" style={{ width: 34, height: 34 }} onClick={onClose} aria-label="Close">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>
        <div className="modal-body">
          {bucket && (
            <>
              <div className="inc-summary">
                <div><span className="inc-k">Uptime</span><span className="inc-v">{pct}%</span></div>
                <div><span className="inc-k">Offline</span><span className="inc-v">{formatDuration(bucket.offlineSeconds)}</span></div>
                <div><span className="inc-k">Degraded</span><span className="inc-v">{formatDuration(bucket.degradedSeconds)}</span></div>
              </div>
              <div>
                <div className="inc-label">Day timeline</div>
                <div className="inc-track">
                  {bucket.incidents.map((inc, i) => {
                    const from = Math.max(inc.start, bucket.start);
                    const to = Math.min(inc.end ?? nowSec, bucket.end);
                    const left = ((from - bucket.start) / span) * 100;
                    const width = Math.max(0.4, ((to - from) / span) * 100);
                    return (
                      <b
                        key={`${inc.start}-${i}`}
                        className={inc.severity}
                        style={{ left: `${left}%`, width: `${width}%` }}
                      />
                    );
                  })}
                </div>
                <div className="inc-ticks"><span>00</span><span>06</span><span>12</span><span>18</span><span>24</span></div>
              </div>
              {bucket.incidents.length === 0 && (
                <p className="modal-blurb">No incidents recorded on this day.</p>
              )}
              {bucket.incidents.map((inc, i) => (
                <div className="inc-row" key={`${inc.start}-row-${i}`}>
                  <span className={`inc-pip ${inc.severity}`} />
                  <div className="inc-main">
                    <div className="inc-time">{range(inc, bucket)}</div>
                    <div className="inc-meta">
                      <span className={`inc-tag ${inc.severity}`}>{inc.severity}</span>
                      {` worst ${inc.min_successes}/${inc.total}`}
                      {inc.start < bucket.start ? ' · started the previous day' : ''}
                    </div>
                    <div className="inc-meta">
                      {inc.failed.map((ip) => <span className="inc-chip" key={ip}>{ip}</span>)}
                    </div>
                  </div>
                  <span className="inc-dur">{formatDuration(spanSeconds(inc, bucket, nowSec))}</span>
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
```

Add to `frontend/src/styles.css`, after the reachability instrument block:

```css
/* incident day modal */
.inc-summary { display: flex; gap: 22px; }
.inc-summary > div { display: flex; flex-direction: column; gap: 2px; }
.inc-k { font-size: 10.5px; text-transform: uppercase; letter-spacing: .6px; color: var(--text-3); font-weight: 600; }
.inc-v { font-size: 17px; font-weight: 700; letter-spacing: -.3px; font-variant-numeric: tabular-nums; }
.inc-label { font-size: 10.5px; color: var(--text-3); font-weight: 600; text-transform: uppercase; letter-spacing: .6px; margin-bottom: 7px; }
.inc-track { position: relative; height: 22px; border-radius: 6px; background: var(--ok-soft); border: 1px solid var(--border-strong); overflow: hidden; }
.inc-track b { position: absolute; top: 0; bottom: 0; }
.inc-track b.outage { background: var(--err); }
.inc-track b.degraded { background: var(--warn); }
.inc-ticks { display: flex; justify-content: space-between; font-family: var(--mono); font-size: 10px; color: var(--text-3); margin-top: 4px; }
.inc-row { display: flex; align-items: flex-start; gap: 11px; padding: 11px 0; border-top: 1px solid var(--border); }
.inc-pip { width: 8px; height: 8px; border-radius: 50%; margin-top: 6px; flex: none; }
.inc-pip.outage { background: var(--err); }
.inc-pip.degraded { background: var(--warn); }
.inc-main { flex: 1; min-width: 0; }
.inc-time { font-family: var(--mono); font-size: 13px; font-weight: 650; }
.inc-meta { font-size: 11.5px; color: var(--text-3); margin-top: 4px; }
.inc-tag { display: inline-flex; align-items: center; font-size: 10.5px; font-weight: 650; padding: 2px 7px; border-radius: 999px; }
.inc-tag.outage { background: var(--err-soft); color: var(--err); }
.inc-tag.degraded { background: var(--warn-soft); color: var(--warn); }
.inc-chip { display: inline-block; font-family: var(--mono); font-size: 10.5px; font-weight: 650; padding: 1px 6px; border-radius: 5px; background: var(--muted-soft); color: var(--text-2); margin-right: 5px; }
.inc-dur { font-family: var(--mono); font-size: 13px; font-weight: 700; flex: none; font-variant-numeric: tabular-nums; }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/components/IncidentModal.test.tsx`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/IncidentModal.tsx frontend/src/components/IncidentModal.test.tsx frontend/src/styles.css
git commit -m "feat: add the per-day incident modal"
```

---

### Task 10: Reachability panel

**Files:**
- Modify: `frontend/src/components/ReachabilityPanel.tsx`, `frontend/src/components/ReachabilityPanel.test.tsx`, `frontend/src/styles.css`, `frontend/src/views/OverviewView.tsx`, `frontend/src/views/OverviewView.test.tsx`

**Interfaces:**
- Consumes: `bucketByDay`, `uptimeStats`, `formatDuration` (Task 8); `IncidentModal` (Task 9); `useIncidents` (Task 7).
- Produces: `ReachabilityPanel({ reachability, incidentWindow }: { reachability: Reachability; incidentWindow: IncidentWindow | null })`.

The prop is `incidentWindow`, not `window` — the latter shadows the browser global inside the component and oxlint rejects it.

- [ ] **Step 1: Write the failing tests**

Rewrite `frontend/src/components/ReachabilityPanel.test.tsx`, replacing the `checks`/`online` fixture:

```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { ReachabilityPanel, DAY_BARS } from './ReachabilityPanel';
import type { IncidentWindow, Reachability } from '../types';

const NOW = Date.now() / 1000;

const reach: Reachability = {
  since: NOW - 3600,
  rev: 1,
  ongoing: null,
  history: Array.from({ length: 30 }, (_, i) => ({ ts: i, successes: 3, total: 3 })),
  latest: [{ ip: '1.1.1.1', ok: true, latency_ms: 20 }],
};

const emptyWindow: IncidentWindow = {
  monitoring_since: NOW - 86400 * 10, rev: 1, incidents: [], ongoing: null,
};

describe('ReachabilityPanel', () => {
  test('renders one bar per day in the history strip', () => {
    const { container } = render(
      <ReachabilityPanel reachability={reach} incidentWindow={emptyWindow} />);
    expect(container.querySelectorAll('.day-strip button')).toHaveLength(DAY_BARS);
  });

  test('day bars are buttons with descriptive labels', () => {
    const { container } = render(
      <ReachabilityPanel reachability={reach} incidentWindow={emptyWindow} />);
    const first = container.querySelector('.day-strip button');
    expect(first?.getAttribute('aria-label')).toMatch(/no incidents/i);
  });

  test('marks a day with an outage', () => {
    const withOutage: IncidentWindow = {
      ...emptyWindow,
      incidents: [{
        start: NOW - 3600, end: NOW - 3000, severity: 'outage',
        min_successes: 0, total: 3, failed: ['1.1.1.1'],
      }],
    };
    const { container } = render(
      <ReachabilityPanel reachability={reach} incidentWindow={withOutage} />);
    expect(container.querySelectorAll('.day-strip button.outage')).toHaveLength(1);
  });

  test('opens the modal when a day bar is clicked', () => {
    const { container } = render(
      <ReachabilityPanel reachability={reach} incidentWindow={emptyWindow} />);
    const bars = container.querySelectorAll('.day-strip button');
    fireEvent.click(bars[bars.length - 1]);
    expect(container.querySelector('.modal-overlay.open')).not.toBeNull();
  });

  test('renders the clamped uptime percentage', () => {
    render(<ReachabilityPanel reachability={reach} incidentWindow={emptyWindow} />);
    expect(screen.getByText('100.0%')).toBeTruthy();
  });

  test('notes the observed span while under thirty days', () => {
    render(<ReachabilityPanel reachability={reach} incidentWindow={emptyWindow} />);
    expect(screen.getByText(/10d observed/)).toBeTruthy();
  });

  test('live strip bars are constant height', () => {
    const { container } = render(
      <ReachabilityPanel reachability={reach} incidentWindow={emptyWindow} />);
    for (const bar of container.querySelectorAll('.quorum span')) {
      expect((bar as HTMLElement).style.height).toBe('');
    }
  });

  test('renders without an incident window', () => {
    const { container } = render(
      <ReachabilityPanel reachability={reach} incidentWindow={null} />);
    expect(container.querySelectorAll('.day-strip button')).toHaveLength(DAY_BARS);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run src/components/ReachabilityPanel.test.tsx`
Expected: FAIL — `DAY_BARS` is not exported; panel has no `window` prop

- [ ] **Step 3: Write the implementation**

Rewrite `frontend/src/components/ReachabilityPanel.tsx`. The resolver-latency block at the bottom of the existing file is unchanged — keep it exactly as it is and change only the header, the live strip, and what follows it.

```tsx
import { useState, type JSX } from 'react';
import type { IncidentWindow, Reachability } from '../types';
import {
  bucketByDay, formatDuration, formatUptime, humanTime, uptimeStats, type DayBucket,
} from '../utils';
import { IncidentModal } from './IncidentModal';

export const QUORUM_BARS = 24;
export const QUORUM = 2;
export const DAY_BARS = 30;
const MAX_LAT_MS = 120;
const SLOW_LAT_MS = 80;
const THIRTY_DAYS = DAY_BARS * 86400;

export interface ReachabilityPanelProps {
  reachability: Reachability;
  incidentWindow: IncidentWindow | null;
}

function dayLabel(bucket: DayBucket): string {
  const date = new Date(bucket.start * 1000).toLocaleDateString(undefined, {
    day: 'numeric', month: 'long',
  });
  if (bucket.worst === 'healthy') return `${date}, no incidents`;
  return `${date}, ${bucket.worst}, ${formatDuration(
    bucket.worst === 'outage' ? bucket.offlineSeconds : bucket.degradedSeconds)}`;
}

export function ReachabilityPanel(
  { reachability: r, incidentWindow }: ReachabilityPanelProps,
): JSX.Element {
  const [selected, setSelected] = useState<DayBucket | null>(null);

  const incidents = incidentWindow?.incidents ?? [];
  const ongoing = incidentWindow?.ongoing ?? r.ongoing;
  const monitoringSince = incidentWindow?.monitoring_since ?? 0;

  const bars = r.history.slice(-QUORUM_BARS);
  const last = bars.length ? bars[bars.length - 1] : null;
  const online = last ? last.successes >= QUORUM : true;

  const buckets = bucketByDay(incidents, ongoing, Date.now(), DAY_BARS);
  const stats = uptimeStats(incidents, ongoing, monitoringSince, Date.now(), DAY_BARS);
  const partial = stats.observedSeconds < THIRTY_DAYS - 1;

  return (
    <>
      <div className="reach-head">
        <div className="reach-uptime">
          <span className={`up-val${online ? '' : ' down'}`}>{stats.pct.toFixed(1)}%</span>
          <span className="up-sub">
            {partial ? `${humanTime(stats.observedSeconds)} observed` : `${DAY_BARS} days`}
            {stats.degradedSeconds > 0 ? ` · ${formatDuration(stats.degradedSeconds)} degraded` : ''}
            {` · ${online ? 'up' : 'down'} ${formatUptime(r.since)}`}
          </span>
        </div>
        <span className={`reach-badge ${online ? 'up' : 'down'}`}><span className="rb-dot" />{online ? 'Online' : 'Offline'}</span>
      </div>

      <div className="reach-label">Live · last {QUORUM_BARS} checks</div>
      <div className="quorum">
        {Array.from({ length: QUORUM_BARS }, (_, i) => {
          const h = bars[i - (QUORUM_BARS - bars.length)];
          if (!h) return <span key={i} className="empty" />;
          const cls = h.successes < QUORUM ? 'down' : (h.successes < h.total ? 'degraded' : '');
          const live = i === QUORUM_BARS - 1 ? ' live' : '';
          return <span key={i} className={`${cls}${live}`} title={`${h.successes}/${h.total} ok`} />;
        })}
      </div>
      <div className="quorum-scale"><span>{QUORUM_BARS} checks ago</span><span>now</span></div>

      <div className="panel-divider" />

      <div className="reach-label">History · {DAY_BARS} days</div>
      <div className="day-strip">
        {buckets.map((b) => (
          <button
            key={b.start}
            type="button"
            className={b.worst}
            aria-label={dayLabel(b)}
            title={dayLabel(b)}
            onClick={() => setSelected(b)}
          />
        ))}
      </div>
      <div className="quorum-scale">
        <span>{new Date(buckets[0].start * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</span>
        <span>today</span>
      </div>

      <div className="resolvers">
        {r.latest.map((x) => {
          if (!x.ok || x.latency_ms == null) {
            return (
              <div className="res-row" key={x.ip}>
                <span className="res-ip">{x.ip}</span>
                <div className="res-track"><div className="res-fill" style={{ width: '0%' }} /></div>
                <span className="res-lat timeout">timeout</span>
              </div>
            );
          }
          const w = Math.min(100, (x.latency_ms / MAX_LAT_MS) * 100);
          const slow = x.latency_ms > SLOW_LAT_MS ? ' slow' : '';
          return (
            <div className="res-row" key={x.ip}>
              <span className="res-ip">{x.ip}</span>
              <div className="res-track"><div className={`res-fill${slow}`} style={{ width: `${w}%` }} /></div>
              <span className="res-lat">{Math.round(x.latency_ms)} ms</span>
            </div>
          );
        })}
      </div>

      <IncidentModal bucket={selected} onClose={() => setSelected(null)} />
    </>
  );
}
```

Update `frontend/src/styles.css` — the live strip loses its inline heights, so give it a fixed bar height, and add the day strip:

```css
.quorum span { flex: 1; height: 100%; border-radius: 3px; min-height: 3px; background: var(--accent); opacity: .9; transition: var(--transition); }
.quorum span.empty { background: var(--surface-2); }
.reach-label { font-size: 10.5px; color: var(--text-3); font-weight: 600; text-transform: uppercase; letter-spacing: .6px; margin-bottom: 8px; }

.day-strip { display: flex; align-items: stretch; gap: 2px; height: 34px; }
.day-strip button { flex: 1; border-radius: 2px; background: color-mix(in srgb, var(--ok) 50%, transparent); transition: var(--transition); cursor: pointer; padding: 0; border: none; }
.day-strip button.degraded { background: var(--warn); }
.day-strip button.outage { background: var(--err); }
.day-strip button:hover { filter: brightness(1.25); }
.day-strip button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
```

Keep the existing `.quorum { height: 46px }` rule; only the per-bar rule changes.

In `frontend/src/views/OverviewView.tsx`, call the hook and pass the window down:

```tsx
import { useIncidents } from '../useIncidents';
```

```tsx
  const reachability = snapshot?.reachability
    ?? { since: 0, rev: 0, ongoing: null, history: [], latest: [] };
  const incidentWindow = useIncidents(reachability.rev);
```

```tsx
            <ReachabilityPanel reachability={reachability} incidentWindow={incidentWindow} />
```

Update `frontend/src/views/OverviewView.test.tsx`: in the `snapshot` fixture replace `checks: 10, online: 10` with `rev: 0, ongoing: null`, and stop the view test hitting the network by mocking the client module above the fixture:

```tsx
vi.mock('../api', () => ({
  getIncidents: () => Promise.resolve({
    monitoring_since: 0, rev: 0, incidents: [], ongoing: null,
  }),
}));
```

The file already calls `vi.useFakeTimers()`, so no timer setup is needed.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/ReachabilityPanel.tsx frontend/src/components/ReachabilityPanel.test.tsx frontend/src/styles.css frontend/src/views/OverviewView.tsx frontend/src/views/OverviewView.test.tsx
git commit -m "feat: add the 30-day history strip to the reachability panel"
```

---

### Task 11: End-to-end verification

**Files:**
- Modify: `frontend/e2e/dashboard.spec.ts`

**Interfaces:**
- Consumes: the rendered dashboard from Tasks 6–10.
- Produces: no new exports.

- [ ] **Step 1: Write the failing test**

Add to `frontend/e2e/dashboard.spec.ts`. The suite runs against a real backend started by `playwright.config.ts` — there is no route stubbing, so a fresh instance simply yields thirty healthy bars:

```ts
test('clicking a day bar opens the incident modal', async ({ page }) => {
  await page.goto('/');
  const bars = page.locator('.day-strip button');
  await expect(bars).toHaveCount(30);
  await bars.last().click();
  await expect(page.locator('.modal-overlay.open')).toBeVisible();
  await expect(page.getByText(/Day timeline/)).toBeVisible();
});

test('the day strip is keyboard reachable', async ({ page }) => {
  await page.goto('/');
  const first = page.locator('.day-strip button').first();
  await first.focus();
  await expect(first).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('.modal-overlay.open')).toBeVisible();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npm run test:e2e`
Expected: FAIL — no `.day-strip button` elements if the build is stale, otherwise the modal assertion fails

- [ ] **Step 3: Build the frontend into the served static directory**

Run: `cd frontend && npm run build`
Expected: assets written to `tether_ddns/static/`

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npm run test:e2e`
Expected: PASS

- [ ] **Step 5: Run every gate**

Run:

```bash
source .venv/bin/activate
flake8 test/ tether_ddns/ && ruff check && mypy . && pyright
pytest test/ --cov=tether_ddns --cov-fail-under=90
cd frontend && npm test && npm run test:e2e
```

Expected: all pass

- [ ] **Step 6: Commit**

```bash
git add frontend/e2e/dashboard.spec.ts
git commit -m "test: cover the day strip and incident modal end to end"
```

---

## Manual verification

After Task 11, confirm the behaviour the automated tests cannot:

1. Start the app with no incident file. Confirm `tether-ddns.incidents.json` is **not** created while reachability is healthy.
2. Break DNS (block outbound 53, or point the resolvers at an unroutable address). Confirm the file appears within one tick, containing one `ongoing` incident.
3. Watch the file's mtime for two minutes while still broken. It must not change — this is the write policy in production.
4. Restore DNS. Confirm the incident closes with a plausible `end`, `rev` advances, and the browser strip updates without a manual reload.
5. Stop the app mid-incident with `docker stop`, wait a minute, start it again. Confirm the incident closes at the first check after boot, not at the moment the process died.
6. Click today's bar and confirm the modal's timeline position matches the wall-clock time of the outage.
