# Reachability "since" — current-state duration — design

Date: 2026-07-15
Status: approved (brainstorm complete)
Branch: `feat/runtime-state-persistence`

## Summary

Replace the reachability card's misleading "up {duration}" (which surfaced
`reachability_started_at` = process start time) with a **current-state duration**:
how long the connection has been continuously online, or — when offline — how long
it has been down. Backend tracks a single `reachability_since` timestamp reset on
every online↔offline transition; the frontend renders "up {d}" when online and
"down {d}" when offline.

## Motivation

`reachability_started_at` measures how long the monitoring process has run, which
is not operator-useful and reads as if it were connection uptime (it sits beside
the Online/Offline badge). A failed check never reset it. Operators want "current
state, and for how long" — the instrument-panel intent.

## Design

- **New field** `reachability_since: float` on `RuntimeState`,
  `Field(default_factory=time.time, exclude=True)`. Non-persisted, like the rest
  of the reachability telemetry — it resets at boot.
- **Reset on transition:** `record_reachability` already computes
  `transitioned = result.online != self.online`. When `transitioned`, set
  `reachability_since = time.time()` (the moment the new state began). Initial
  state is `online=False`, `reachability_since=boot`; the first successful check is
  a False→True transition and resets `since` to now ("up" starts counting from
  first online), while an all-failing start leaves `since=boot` ("down since boot").
- **Snapshot:** add `since` to the `reachability` block. `reachability_started_at`
  stays in the payload for now (no consumer after this change; removing it is a
  separate cleanup, out of scope).
- **Frontend:** `Reachability` type gains `since: number`. `ReachabilityPanel`
  renders the sub-label as `{online ? 'up' : 'down'} {formatUptime(since)}`, using
  the existing `online` derivation (last history bar ≥ QUORUM).

## Persistence

`reachability_since` is `exclude=True` — not persisted. After a restart it starts
at boot and the first check reconciles it, consistent with the reachability
telemetry exclusion (`2026-07-15-reachability-persistence-exclusion-design.md`).

## Testing

- Backend (`test/unit/test_runtime.py`): a False→True transition sets
  `reachability_since` to ~now; a steady-state check (no transition) leaves it
  unchanged; a True→False transition resets it again. `since` present in
  `snapshot()['reachability']`; `since` absent from `model_dump()` (excluded).
- Frontend (`ReachabilityPanel` test): renders "up …" when the latest history bar
  is online and "down …" when offline, using `since`.

## Out of scope

- Removing `reachability_started_at` from the snapshot (separate cleanup).
- Persisting the current-state duration across restarts.
