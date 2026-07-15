# Runtime state persistence — design

Date: 2026-07-15
Status: approved (brainstorm complete)
Branch: `feat/runtime-state-persistence`

## Summary

Persist the application's live runtime state to a JSON file so that domain
statuses, public IPs, change timestamps, and reachability history survive a
restart, instead of being wiped and rebuilt to `pending` every time the process
starts. No database — a single JSON file written atomically, mirroring the
existing `ConfigStore` conventions.

State is written on a bounded cadence: a periodic scheduler flush job plus a
final flush folded into `Scheduler.shutdown()`. On startup the persisted snapshot
is restored **before** `RuntimeState.rebuild()`, so unchanged domains keep their
last-known status while config-changed domains still reset to `pending`.

The state file is machine-written and fully regenerable, so it is treated as
disposable: a missing, corrupt, or schema-incompatible file never blocks startup.

## Motivation

Today every restart discards all live state. `RuntimeState.rebuild()`
(runtime.py) resets each domain to `pending`, and the reachability history,
counters, and `*_changed_at` timestamps start from zero. For an always-on DDNS
daemon whose purpose is to be an accurate "instrument panel," a restart produces
a cold, all-`pending` screen that discards genuinely real information (a domain
that was synced three days ago, the reachability sparkline, when the IP last
changed).

Persisting this state restores continuity across restarts — directly serving
design principle #1, "Show real state, don't summarize it away." The effort is
modest because `ConfigStore` (config.py) already provides a proven atomic-write +
pydantic JSON pattern to mirror, and the state is regenerable, so the failure
modes are forgiving.

## Layers

- **Model** — `RuntimeState` (runtime.py) becomes a pydantic `BaseModel` so it can
  serialize/deserialize itself. `DomainRuntime` and `CheckRecord` are already
  models. `AppConfig`/`ConfigStore` unchanged.
- **Persistence** — new `StateStore` (state_store.py): pure JSON I/O, a sibling of
  `ConfigStore`. Holds only a path; `save(state)` / `load()`. No reference to
  runtime or context.
- **Context** — `AppContext` (context.py) gains a `state_store` field and a
  `persist_state()` method mirroring the existing `persist()`; this is the only
  glue that turns the live runtime into a persisted payload.
- **Scheduler** — owns the write cadence: a periodic `flush_state` job, and a
  final flush inside `shutdown()`.
- **Composition root** — `app.py` lifespan builds the `StateStore`, restores the
  snapshot before `rebuild()`, and injects `state_store` into `AppContext`.

## Key decisions

1. **`RuntimeState` becomes a pydantic `BaseModel` — no separate snapshot class.**
   Persistence is `model_dump(exclude=...)` / `model_validate(...)`. This avoids a
   parallel `RuntimeSnapshot` schema that would have to be kept in sync every time
   a runtime field is added: new fields persist automatically unless explicitly
   excluded. It also aligns `RuntimeState` with the other models in the codebase
   (`AppConfig`, `DomainRuntime`, `CheckRecord`).

   Field treatment:
   - `_listeners`, `_configs` → `PrivateAttr` (auto-excluded from serialization).
   - `reachability_latest`, `next_check_at` → `Field(exclude=True)`: kept in memory
     and in the frontend `snapshot()`, but skipped by persistence because they are
     derived/ephemeral.
   - `reachability_started_at` → `default_factory=time.time`; `public_ipv4/6`,
     `ipv4/ipv6_changed_at`, `next_check_at` → `None` defaults; `online` → `False`;
     `domains` → empty dict default.

2. **CRITICAL: the `reachability_history` deque `maxlen` must round-trip.**
   `reachability_history` is a `deque(maxlen=REACHABILITY_HISTORY_SIZE)` (60).
   pydantic serializes a deque to a JSON list cleanly, but on load a list must be
   re-wrapped into a **bounded** `deque(maxlen=60)` via a field validator.
   Without this, the history becomes an unbounded deque (or list) after a restore
   and grows without limit. This requires an explicit regression test: after
   `restore()`, append more than 60 records and assert the length stays capped at
   60.

3. **Persistence payload is decoupled from the frontend payload.** `snapshot()`
   (the frontend/WebSocket payload) and `_emit()` are unchanged. Persistence uses
   `model_dump(exclude=...)` independently. The two never share a code path, so
   changing one cannot silently alter the other.

4. **`StateStore` is pure I/O, glue lives in `AppContext`.** `StateStore` mirrors
   `ConfigStore`: holds a path, `save`/`load`, atomic write (tempfile +
   `os.replace`), `model_dump_json` / `model_validate_json`. It never references
   runtime or context. `AppContext.persist_state()` does
   `self.state_store.save(self.runtime)`, exactly paralleling the existing
   `persist()` → `self.store.save(self.config)`. This keeps the store trivially
   testable with a plain model and puts the "live object → payload" knowledge in
   the one place that already owns that responsibility.

5. **Write cadence: periodic flush job + flush folded into `shutdown()`
   (Option 3).** A `flush_state` APScheduler interval job (~30 s) calls
   `ctx.persist_state()`. `Scheduler.shutdown()` calls `ctx.persist_state()`
   **first**, then stops the scheduler; the lifespan `finally` stays unchanged
   (`scheduler.shutdown()`). This bounds disk I/O to one write per interval
   regardless of mutation rate, keeps all persistence in the async/timer layer
   that already owns the event loop, and leaves `RuntimeState`'s mutators
   untouched (no per-`set_*` writes, no debounce machinery). The state is
   regenerable, so losing up to one interval of changes on a hard crash is
   cosmetic; graceful restarts (container/systemd — the common case) are covered
   by the shutdown flush.

6. **Restore runs before `rebuild()` and seeds `_configs` (Option A).** On startup:
   load config → construct `RuntimeState` → load persisted snapshot →
   `runtime.restore(snapshot, config)` → `runtime.rebuild(config)`. `restore()`
   hydrates the runtime fields **and** seeds `_configs` from the *current* config.
   This matters because `rebuild()`'s "unchanged domain keeps its runtime" check
   requires `_configs` to be populated; on a fresh process it is empty, so without
   seeding it every restored domain would be reset to `pending`. Seeding `_configs`
   from the current config lets `rebuild()` preserve every persisted domain's
   restored status. Note: config edits made *while the app was down* are **not**
   specially detected — after a restart only the current config exists on disk, so
   there is no prior config to diff against. A domain whose config changed during
   downtime keeps its persisted status until the next scheduled sync reconciles it
   (consistent with decision 7). New domains (absent from the snapshot) still start
   `pending`.

7. **Restored state is trusted as-is (Option A).** No provisional/marking logic and
   no coupling to `update_on_startup`. The persisted values were genuinely real at
   shutdown; every field carries a timestamp the frontend already renders as
   "as of X"; and the first scheduled check reconciles everything within ~30 s.
   Adding provisional-state machinery for a sub-30-second cosmetic window is not
   worth the complexity.

8. **State file is fail-soft, always (Option A).** Load behavior:
   - Missing file → fresh empty state (identical to today's cold start).
   - Corrupt JSON, invalid data, or schema mismatch (e.g., after a future field
     change) → log a warning, discard, start fresh.

   The state file can never prevent the daemon from booting. This also gives free
   forward/backward compatibility across schema changes. `ConfigStore` keeps its
   existing strict behavior; only the (regenerable) state file is fail-soft.

## Data flow

**Startup (app.py lifespan):**

```
config = config_store.load()
runtime = RuntimeState()
snapshot = state_store.load()          # None if missing/corrupt (fail-soft)
if snapshot is not None:
    runtime.restore(snapshot, config)  # hydrate fields + seed _configs (Option A)
runtime.rebuild(config)                # unchanged domains keep restored status
ctx = AppContext(config, runtime, config_store, state_store, manager)
```

**Runtime (steady state):**

```
Scheduler.flush_state (interval ~30s) -> ctx.persist_state()
                                      -> state_store.save(runtime)
                                      -> atomic write to tether-ddns.state.json
```

**Shutdown:**

```
lifespan finally -> scheduler.shutdown()
                 -> ctx.persist_state()   # flush FIRST
                 -> scheduler stop
```

## Persisted vs. excluded state

**Persisted:** `public_ipv4`, `public_ipv6`, `ipv4_changed_at`, `ipv6_changed_at`,
`online`, `reachability_started_at`, `reachability_checks`, `reachability_online`,
`reachability_history` (list of `CheckRecord`), `domains`
(`id → DomainRuntime`: status/ip/updated/message).

**Excluded (in-memory only):** `_listeners`, `_configs`, `reachability_latest`
(derived from the last probe), `next_check_at` (derived from the scheduler), and
application logs (`LogRingHandler` ring buffer — deliberately ephemeral).

## File location

- Env var `TETHER_DDNS_STATE_PATH`, else `tether-ddns.state.json` in the cwd,
  resolved exactly like `ConfigStore` resolves `TETHER_DDNS_CONFIG_PATH` /
  `tether-ddns.json`.
- Separate file from config: config is user-authored and precious; state is
  machine-written and disposable. Keeping them apart avoids churning the
  hand-editable config file and keeps the fail-soft-vs-strict policies cleanly
  separated.

## Components to change

- **runtime.py** — Convert `RuntimeState` to a pydantic `BaseModel`: fields with
  defaults, `PrivateAttr` for `_listeners`/`_configs`, `Field(exclude=True)` for
  `reachability_latest`/`next_check_at`, and a validator that re-wraps
  `reachability_history` into a bounded `deque(maxlen=REACHABILITY_HISTORY_SIZE)`.
  Add `restore(snapshot, config)` (hydrate fields + seed `_configs`). Verify all
  mutators (`set_*`, `record_reachability`, `rebuild`, `add/remove_listener`) and
  `snapshot()`/`_emit()` still work on a model instance.
- **state_store.py** (new) — `StateStore` mirroring `ConfigStore`: path resolution
  (`TETHER_DDNS_STATE_PATH` / `tether-ddns.state.json`), atomic `save(RuntimeState)`,
  fail-soft `load() -> RuntimeState | None`.
- **context.py** — Add `state_store: StateStore` field and `persist_state()` to
  `AppContext`, alongside the existing `persist()`/`rebuild()`.
- **app.py** — In `create_app`/lifespan: build the `StateStore` (injectable via a
  new `create_app` parameter, mirroring the existing `store` parameter, for test
  isolation); load + `restore()` before `rebuild()`; pass `state_store` into
  `AppContext`.
- **scheduler.py** — Add `STATE_FLUSH_INTERVAL_SECONDS` (~30) and register a
  `flush_state` interval job in `start()`; call `ctx.persist_state()` at the top of
  `shutdown()` before stopping the scheduler.

## Testing

- **New `test/unit/test_state_store.py`** — round-trip `save`/`load`; missing file
  → `None`; corrupt/invalid file → `None` + warning logged (fail-soft); atomic
  write (previous good file survives a mid-write failure).
- **Extend `test/unit/test_runtime.py`**:
  - `RuntimeState` model round-trips through `model_dump`/`model_validate`;
    excluded fields (`_listeners`, `_configs`, `reachability_latest`,
    `next_check_at`) are absent from the persisted payload.
  - **deque cap regression (critical):** after `restore()`, append > 60 records
    and assert `len(reachability_history) == 60` and `maxlen == 60`.
  - `restore(snapshot, config)` then `rebuild(config)` preserves an unchanged
    domain's status and resets a config-changed domain to `pending` (Option A).
  - All existing mutators still behave after the `BaseModel` conversion.
- **Update `test/unit/test_scheduler.py` and `test/unit/test_main.py`** — construct
  `AppContext` with a `StateStore` pointed at a tmp path (since `shutdown()` now
  performs real disk I/O); assert a flush occurs on shutdown and on the periodic
  job.

## Verification

1. `pytest test/unit/test_state_store.py test/unit/test_runtime.py`
2. Full suite: `pytest` (including the lint/type gates: `test_ruff`, `test_mypy`,
   `test_pyright`, `test_flake8`).
3. Manual smoke: start the app, let a domain sync to `synced`, restart → the domain
   shows `synced` (not `pending`) and reachability history + `*_changed_at`
   timestamps are retained; delete the state file → clean cold start.

## Out of scope

- Persisting application logs (ephemeral by design).
- Persisting derived fields (`next_check_at`, `reachability_latest`).
- Any database or multi-file state store; migrations/versioning beyond the
  fail-soft discard.
- Debounced/on-mutation writing strategies (rejected in favor of Option 3).
