# Reachability "since" — current-state duration — plan

> Executed inline with TDD (subagents are read-only in this environment).

**Goal:** Replace "up {process-uptime}" with a current-state duration: "up {d}" while online, "down {d}" while offline, reset on each online↔offline transition.

## Global Constraints
- Backend gates green: `pytest` incl. ruff/mypy/pyright/flake8.
- Frontend gates green: `npx vitest run` (coverage thresholds) + `tsc`.
- `reachability_since` is non-persisted (`exclude=True`); `snapshot()` still emits the full reachability block plus `since`.
- No change to the `online` derivation (last history bar ≥ QUORUM).

---

### Task 1: Backend `reachability_since`

**Files:** `tether_ddns/runtime.py`, `test/unit/test_runtime.py`

- Add field `reachability_since: float = Field(default_factory=time.time, exclude=True)` in the excluded telemetry block.
- In `record_reachability`, after computing `transitioned`, when `transitioned` set `self.reachability_since = time.time()`.
- In `snapshot()` reachability block, add `'since': self.reachability_since`.
- Tests:
  - `record_reachability` False→True sets `reachability_since` close to now (and > the initial boot value when time advances).
  - a non-transition check leaves `reachability_since` unchanged.
  - True→False resets it.
  - `snapshot()['reachability']` contains `since`; `model_dump()` excludes `reachability_since`.

Commit: `feat: track current reachability-state duration (since)`

### Task 2: Frontend up/down since

**Files:** `frontend/src/types.ts`, `frontend/src/components/ReachabilityPanel.tsx`, `frontend/src/components/ReachabilityPanel.test.tsx`, and mock sites `frontend/src/views/OverviewView.tsx`, `frontend/src/views/OverviewView.test.tsx`, `frontend/src/useLiveState.test.tsx`.

- `Reachability` type: add `since: number;`.
- `ReachabilityPanel`: sub-label becomes `{r.online}/{r.checks} checks · {online ? 'up' : 'down'} {formatUptime(r.since)}`.
- Add `since: 0` (or appropriate) to every `Reachability` mock/default literal.
- Panel test: assert "up" label when latest bars online; add an offline case asserting "down".

Commit: `feat: show current online/offline duration in reachability card`

### Task 3: Full verification
- `pytest -q`
- `cd frontend && npx vitest run` and `npx tsc -p tsconfig.app.json --noEmit`
- Commit any doc updates.
