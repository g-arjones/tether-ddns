# Reachability-series persistence exclusion + write-if-changed flush — design

Date: 2026-07-15
Status: approved (brainstorm complete)
Branch: `feat/runtime-state-persistence` (continues the runtime-state-persistence work)

## Summary

A follow-up refinement to runtime state persistence. Two independent, small
changes:

1. **Exclude the reachability telemetry time-series from persistence.** Mark
   `reachability_started_at`, `reachability_checks`, `reachability_online`, and
   `reachability_history` as `Field(exclude=True)` on `RuntimeState`, joining the
   already-excluded `reachability_latest` and `next_check_at`. They remain fully
   live in memory and in the frontend `snapshot()` payload — only persistence
   (`model_dump()`) omits them.

2. **Write-if-changed in the scheduler flush.** `flush_state` remembers the last
   persisted JSON payload and calls `state_store.save()` only when the current
   persistable payload differs. No dirty flag, no listener, no changes to
   `RuntimeState` mutators.

Together these resolve the two review follow-ups (uptime% window semantics +
pointless periodic disk writes) without adding coupling to the pure state model.

## Motivation

The initial persistence work (spec `2026-07-15-runtime-state-persistence-design`)
persisted the entire `RuntimeState`, including the reachability telemetry. That
surfaced two problems:

- **Uptime% becomes an all-time metric.** The frontend computes uptime as
  `(reachability.online / reachability.checks) * 100`. Those counters were
  since-boot values. Persisting them across restarts silently redefines uptime%
  as an unbounded all-time figure, which is not what the gauge means or what an
  operator expects.

- **Disk churn every 30 s.** `record_reachability()` appends a `CheckRecord` to
  `reachability_history` and bumps the counters on every reachability check
  (every `REACHABILITY_INTERVAL_SECONDS = 30`). With the series persisted, the
  state file changes on every single tick, so the periodic flush rewrites the
  file every 30 s forever — needless write wear (notably on SD-card homelab
  deployments, a core audience per PRODUCT.md).

Excluding the series fixes both at the source: uptime% counters reset on restart
(restoring since-boot semantics) and the persistable payload no longer changes on
a reachability tick. The write-if-changed guard then eliminates any remaining
redundant writes when nothing meaningful has changed.

Crucially, this is **not a UX regression**: before the persistence feature the
reachability history/counters were never persisted, so they always started empty
after a restart. Excluding them simply preserves that long-standing behavior.

## Key decisions

1. **Exclude the whole reachability time-series, not just the counters.** Excluding
   only the counters would fix uptime% but leave `reachability_history` changing
   every tick, so the flush would still write every 30 s. The disk-churn fix
   requires the history to be non-persisted too. The series is internally
   consistent as one unit: started_at + checks + online + history are all
   since-boot telemetry that rebuilds together.

2. **Write-if-changed lives in the flush path, not in mutators (Option D).** The
   scheduler compares the current serialized payload against the last one it
   wrote and skips the save when identical. This keeps `RuntimeState` a pure model
   (no `_dirty` flag spread across `set_*` methods) and cannot suffer a
   "forgot-to-mark-a-mutator" bug, because correctness derives from comparing the
   real payload. A persistence *listener* was rejected: it fires on every `_emit()`
   (including the 30 s reachability emit), so it would still need a payload
   comparison — which is simpler to do once in the flush path and is naturally
   throttled to the flush interval.

3. **Comparison key is the serialized JSON string.** `flush_state` computes
   `runtime.model_dump_json()` (which already excludes the reachability series and
   other ephemerals) and compares it to the last written string. Reusing the exact
   bytes that would be written guarantees the comparison matches what `save()`
   persists. The shutdown flush path also updates/uses this memo so a final
   identical state is not needlessly rewritten (but a genuine last-moment change
   is still flushed).

4. **Persisted vs. excluded is now explicit and documented in code.** Every
   excluded field carries an inline comment stating why, so a future reader (or a
   new runtime field) has the rationale at hand and does not accidentally re-persist
   the telemetry.

## Persisted vs. excluded state (updated)

**Persisted:** `public_ipv4`, `public_ipv6`, `ipv4_changed_at`, `ipv6_changed_at`,
`online`, `domains` (`id → DomainRuntime`: status/ip/updated/message).

**Excluded (in-memory + frontend `snapshot()` only):**
- `reachability_started_at`, `reachability_checks`, `reachability_online`,
  `reachability_history` — since-boot telemetry; rebuilds after restart (NEW).
- `reachability_latest` — derived from the last probe (already excluded).
- `next_check_at` — derived from the scheduler (already excluded).
- `_listeners`, `_configs` — `PrivateAttr` (already excluded).
- Application logs (`LogRingHandler`) — ephemeral, never part of the model.

Note: `online` (the current reachability boolean) IS still persisted — it is a
small, meaningful status field, not part of the telemetry series, and restoring
it avoids a momentary "offline" flash on restart until the first check.

## Behavior

- **Uptime%**: resets to since-boot on restart (original, intended semantics).
- **Reachability sparkline + "system uptime" duration**: start empty/zero after a
  restart and refill over ~30 min — identical to a cold start today. Accepted.
- **IP "stable since" (`ipv4/ipv6_changed_at`) and domain statuses**: persist —
  the valuable cross-restart continuity is retained.
- **Idle daemon disk writes**: zero between real events (IP change, domain status
  change, online transition), versus one every 30 s before.

## Components to change

- **`tether_ddns/runtime.py`** — add `exclude=True` to the four reachability
  fields, with an inline rationale comment block above them. No behavior change to
  any method; `snapshot()` still emits the full `reachability` block.
- **`tether_ddns/scheduler.py`** — `flush_state` gains a last-written-payload memo
  and a write-if-changed guard, with a one-line comment. `shutdown()` continues to
  flush first (through the same guard) then stop.

## Testing

- **`test/unit/test_runtime.py`**:
  - Extend `test_model_dump_excludes_ephemeral_fields`: assert
    `reachability_started_at`, `reachability_checks`, `reachability_online`,
    `reachability_history` are all absent from `model_dump()`, while
    `online`, `public_ipv4`, `domains`, and `*_changed_at` remain present.
  - Assert `snapshot()` still contains the full `reachability` block
    (`started_at`, `checks`, `online`, `history`, `latest`) — frontend contract
    unchanged.
  - Round-trip: after `model_validate(model_dump())`, reachability counters are 0
    and history is empty, but `public_ipv4/6`, `*_changed_at`, `online`, and
    `domains` survive.
- **`test/unit/test_scheduler.py`**:
  - Two consecutive `flush_state` calls with no intervening state change →
    `state_store.save` called exactly once.
  - After a real persisted-field change (e.g. `set_status` or `set_public_ipv4`)
    between flushes → `save` called again.
  - A `record_reachability` between flushes does NOT trigger a second save
    (its fields are excluded, so the payload is unchanged).

## Verification

1. `pytest test/unit/test_runtime.py test/unit/test_scheduler.py -q`
2. Full suite: `pytest` (incl. ruff/mypy/pyright/flake8 gates).
3. Manual: run the daemon idle for > 1 min → the state file's mtime does not
   advance on reachability ticks; change a domain's status → the file updates.

## Out of scope

- Persisting reachability history across restarts via a slower, decoupled flush
   cadence (considered and rejected — the series is low-value to persist and the
   churn/complexity is not worth it).
- A dirty-flag on mutators (rejected in favor of Option D content comparison).
- Any change to the frontend or the `/api/state` snapshot shape.
