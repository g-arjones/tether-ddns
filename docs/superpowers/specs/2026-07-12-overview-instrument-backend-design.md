# Overview Instrument — Backend Support Design

**Date:** 2026-07-12
**Scope:** Backend only. Adds the runtime telemetry the new dashboard "Overview" needs
(reachability instrument, uptime, per-resolver latency, next-check countdown, IP
last-changed). The React frontend that consumes these fields is a separate
brainstorm → spec → plan cycle that follows this one.

## Context

`GET /api/state` and the `/ws` stream currently expose `public_ipv4`,
`public_ipv6`, `online` (bool), `domains[]`, `settings`, and `logs[]`. The
`ReachabilityService.check()` result carries `online / successes / total /
details`, but the scheduler discards everything except the `online` bool and
only broadcasts on a state *transition*.

The dashboard mockup (`frontend/mockup-left-rail.html`) Overview needs richer,
live reachability telemetry. The dual-stack plan
(`2026-07-10-tether-ddns-dualstack.md`) is already implemented; a single domain
holding both A+AAAA is explicitly out of scope.

## Decisions

- **Full instrument** (uptime %, quorum history bars, per-resolver latency).
- History retains the **last 60 checks** (~30 min at the 30s cadence). The
  frontend decides how many to render.
- Reachability telemetry lives in `RuntimeState` (single home for live state).
- A dedicated `ResolverProbe` model replaces the widening `tuple` return.
- `next_check_at` is written into `RuntimeState` by the scheduler (snapshot stays
  dependency-free).
- Telemetry is **in-memory only** — resets on restart; uptime starts fresh at boot.
- The full history array is sent on **every** broadcast (simple, ~1KB).

## 1. Reachability probe result type (`reachability.py`)

Replace the `tuple[str, str]` return from `_query_one` with a model:

```python
class ResolverProbe(BaseModel):
    ip: str
    ok: bool
    latency_ms: float | None = None   # None on timeout/error
```

- `_query_one` measures wall-clock around the query with `time.perf_counter()`
  and returns a `ResolverProbe` (latency on success, `None` on timeout/error).
- `ReachabilityResult` gains `probes: list[ResolverProbe]`. Existing
  `online` / `successes` / `total` / `details` remain (`details` still feeds the
  failure log line).

## 2. Runtime state ownership (`runtime.py`)

`RuntimeState` becomes the single home for reachability telemetry:

- `reachability_started_at: float` — set at construction (boot).
- `reachability_checks: int`, `reachability_online: int` — cumulative counters.
- `reachability_history: deque[CheckRecord]` — `maxlen=60`, each
  `{ts, successes, total}`.
- `reachability_latest: list[ResolverProbe]` — probes from the most recent check.
- `next_check_at: float | None`.
- `ipv4_changed_at` / `ipv6_changed_at` — updated inside `set_public_ipv4/6`
  **only when the value actually changes**.

New methods:

- `record_reachability(result: ReachabilityResult)` — push history, bump
  counters, store `latest`, set `online`, emit once.
- `set_next_check_at(ts: float | None)`.

`snapshot()` serializes all of the above (see schema in §4).

`CheckRecord` is a small `BaseModel` (`ts`, `successes`, `total`).

## 3. Scheduler wiring (`scheduler.py`)

- `check_reachability` calls `state.record_reachability(reach)` on **every** run,
  replacing the transition-only `set_online`. The `reachability_changed` hook
  dispatch still fires **only on transition**: capture the prior `state.online`
  before recording, compare, dispatch if changed.
- After each `sync_ips` run and at `start()`, write `state.set_next_check_at(...)`
  from the `sync` job's `next_run_time`.

## 4. Snapshot schema (`/api/state` + `/ws` payload)

```jsonc
{
  "public_ipv4": "…", "public_ipv6": "…",
  "ipv4_changed_at": 1720000000.0,   // null until first seen
  "ipv6_changed_at": 1720000000.0,
  "online": true,
  "next_check_at": 1720000300.0,     // null before first schedule
  "reachability": {
    "started_at": 1719990000.0,
    "checks": 238, "online": 236,     // cumulative
    "history": [ { "ts": 1720000270.0, "successes": 3, "total": 3 } ],  // ≤60
    "latest": [ { "ip": "1.1.1.1", "ok": true, "latency_ms": 11.2 } ]
  },
  "domains": [ … ], "settings": { … }, "logs": [ … ]
}
```

Reachability telemetry is nested under one key to keep the snapshot tidy and map
cleanly to the mockup panel. Frontend `types.ts` gains matching interfaces (in
the later frontend cycle).

## 5. Testing

- `test_reachability.py`: `_query_one` returns `ResolverProbe` with latency on
  success and `None` on timeout; `check()` assembles `probes`.
- `test_runtime.py`: history caps at 60; counters increment; `started_at` stable;
  IP-changed timestamps only move on change; `snapshot()` shape.
- `test_scheduler.py`: every check records to state; hook fires only on
  transition; `next_check_at` set after sync and at start.
- Backend coverage gate stays at 90% (`pytest test/ --cov-fail-under=90`).

## Out of scope

- Frontend React implementation (separate brainstorm → spec → plan → implement).
- Persisting telemetry across restarts.
- Single-domain dual A+AAAA records.
