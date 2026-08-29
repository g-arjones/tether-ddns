# Reachability incident history — 30-day persisted window — design

Date: 2026-08-29
Status: approved (brainstorm complete)
Branch: `feat/reachability-incidents`

## Summary

Replace the ephemeral, since-boot reachability telemetry with a **persisted
30-day incident history**.

Instead of storing every check (2,880/day, unbounded), store only **incidents** —
contiguous spans during which reachability was not fully healthy. Each incident
records its start, end, severity, the worst quorum reached, and which resolvers
failed. Incidents live in a sliding 30-day window in a dedicated JSON file and
survive restarts.

The Overview panel keeps its live 24-check strip and gains a 30-day strip of
daily bars beneath it. Clicking a day opens a modal with that day's 24-hour
timeline and incident list.

## Motivation

Reachability telemetry is currently excluded from persistence on purpose (spec
`2026-07-15-reachability-persistence-exclusion-design`): it is a per-check series
that turns over every ~30 minutes, so persisting it rewrote the state file every
30 s and turned uptime% into a meaningless all-time figure.

That decision was correct for a *per-check* series, but it leaves the operator
with no history at all — after a restart the panel claims 100% uptime with no
memory of last night's outage. Storing **incidents** rather than **checks**
inverts the economics: a healthy month writes to disk zero times, while a real
outage is remembered for 30 days.

Per PRODUCT.md: *show real state, don't summarize it away* and *fail loud and
clear*. An outage that vanishes on restart does neither.

## Key decisions

1. **Two severities, both recorded.** `degraded` (at least one probe failed but
   quorum held — still online) and `outage` (quorum lost — offline). Recording
   only outages would discard early-warning signal; recording a single
   undifferentiated "something failed" would conflate a flapping resolver with
   losing the internet.

2. **A severity change splits the incident.** Consecutive checks at the same
   severity merge into one span. A change closes the current incident and opens
   a new one at the same instant, so spans are contiguous with no gap. Rejected:
   a single span tagged with its worst severity (hides that a 29-minute event was
   only 4 minutes hard-down), and a nested severity timeline (more structure than
   the UI needs).

3. **No gap detection, no `unknown` severity, no heartbeat.** Knowing when the
   process *stopped* requires periodically writing a timestamp, which reintroduces
   exactly the disk churn the previous spec removed. Instead the model assumes
   **the internet was up while the app was down**, unless an incident was ongoing
   at the time — in which case that incident is assumed to have lasted until the
   first check after the app returns. This is a deliberate, documented limitation:
   an outage that both begins and ends while tether-ddns is stopped is invisible.

4. **A dedicated file, not the runtime state file.** Incidents have a different
   lifecycle from the live snapshot: append-mostly, windowed, mutating only during
   a fault. Keeping them separate preserves the existing "no writes while healthy"
   property of `flush_state` unchanged, and lets the incident window be tested
   without touching runtime-state semantics.

5. **The window is derived, not stored.** There is no persisted `window_start`;
   it is `now - 30d`, evaluated on read. Sliding the window is therefore free and
   never causes a write.

6. **Live data over WebSocket, history over REST.** `snapshot()` fires on every
   state change and is broadcast to every connected tab, so a month of records
   must not ride in it. The snapshot carries only the ongoing incident and a
   revision counter; the frontend refetches the list over REST when the counter
   changes.

7. **Uptime% is time-based over the window, clamped to first observation.** The
   denominator is `now - max(monitoring_since, now - 30d)`, so a fresh install
   reports "99.8% · 6 days observed" rather than claiming a confident 30-day
   figure it cannot support.

8. **Daily bars are flat and colour-only.** A bar shows *that* the day had a
   problem and how bad it got, not *how much*. Proportional-height encodings were
   rejected: real incidents are minutes long and render sub-pixel against a
   24-hour day. Magnitude lives in the modal.

## Data model

New module `tether_ddns/incidents.py`:

```python
Severity = Literal['degraded', 'outage']

class Incident(BaseModel):
    start: float                # epoch seconds
    end: float | None           # None while ongoing
    severity: Severity
    min_successes: int          # worst quorum reached during the span
    total: int                  # resolvers probed at that worst check
    failed: list[str]           # resolver IPs that failed at least once

class IncidentWindow(BaseModel):
    monitoring_since: float     # written once, on first file creation
    rev: int                    # bumped on every mutation
    incidents: list[Incident]   # closed only, oldest first
    ongoing: Incident | None
```

### Severity classification

For a `ReachabilityResult`:

| condition | severity |
|---|---|
| `successes == total` | healthy (no incident) |
| `result.online` and `successes < total` | `degraded` |
| `not result.online` | `outage` |

Note this needs no access to the probe's quorum: `ReachabilityResult.online`
already encodes `successes >= quorum`, so the recorder depends only on the
result, not on the probe's configuration.

### Retention

An incident is expired when `end is not None and end < now - 30d`. An incident
that started before the cutoff but ended inside the window is still partially
visible and is retained. `ongoing` is never expired.

`WINDOW_DAYS = 30` is a module constant.

## Storage

New module `tether_ddns/incident_store.py`, mirroring
[`state_store.py`](../../../tether_ddns/state_store.py):

- Path derived from the state file's directory as `tether-ddns.incidents.json`;
  no new environment variable, so existing Docker volume mounts keep working.
- **Fail-soft load**: missing, unreadable, or invalid file yields a fresh window
  and logs a warning. The file is machine-written and regenerable.
- **Atomic save**: write to a temp file in the same directory, then `os.replace`.

### Write policy

This is the central constraint of the design. Writes happen **only** on:

- an incident opening
- an incident closing
- a severity split (close + open — a single write)
- a prune that actually removed at least one record
- graceful shutdown, if in-memory state differs from disk

Writes explicitly do **not** happen on: a healthy check, a check that extends an
existing incident at the same severity, or the window sliding.

A steady 6-hour outage therefore produces exactly two writes — one at open, one
at close — not 720.

## Recording logic

`IncidentRecorder.record(result) -> IncidentView` is called once per reachability
tick. `IncidentView` is the pair `(ongoing, rev)` published to the UI.

| `ongoing` | new severity | action | writes |
|---|---|---|---|
| none | healthy | nothing | no |
| none | degraded/outage | open `ongoing` at `now`, bump `rev` | yes |
| present | same | widen `failed`; if this check is worse, replace `min_successes`/`total` | no |
| present | different | close at `now`, append, open new at `now`, bump `rev` | yes |
| present | healthy | close at `now`, append, clear `ongoing`, bump `rev` | yes |

The "same severity" row is what keeps a long outage quiet: the only thing that
would otherwise change is a duration the frontend derives from `start`.

Pruning runs on the same tick, as an O(1) check against the head of the list.

### Restart behaviour

On load, `ongoing` is kept open exactly as persisted. The first check after boot
resolves it through the table above — extending, splitting, or closing it at that
moment. This implements decision 3: an incident in flight when the process died
is recorded as having lasted until the first check back.

### Pruning layers

1. **On load** — prune, and write immediately if anything was dropped, so disk
   state matches the retention promise from the first moment.
2. **On tick** — prune, write if anything was dropped.
3. **On read** — the API filters to the window regardless. This covers the ≤30 s
   race between a record expiring and the next tick, and any file written by
   another instance.

### Durability limits

Nothing flushes on `SIGKILL` or power loss. What is at risk is bounded:

- A **closed** incident is already on disk. Never at risk.
- An **open** incident has its `start` and `severity` on disk from the open-write.
  Only widening since then is lost — `min_successes` may read optimistically and
  `failed` may be missing a resolver. Its `end` is unset, so the next boot's first
  check closes it per the restart rule.

This is documented rather than fixed; closing it would mean periodic writes.

## Backend integration

### Wiring

`AppContext` gains an `IncidentRecorder` (built from an `IncidentStore`) and a
`persist_incidents()` method mirroring `persist_state()`.
[`Scheduler.check_reachability`](../../../tether_ddns/scheduler.py) becomes:

```python
reach = await self._reachability.check()
view = self._incidents.record(reach)
if state.record_reachability(reach, view):
    await self._dispatch.dispatch('reachability_changed', ...)
```

`record_reachability` accepts the recorder's view so a tick still produces exactly
one `_emit()`.

`Scheduler.shutdown` flushes the incident window alongside runtime state, before
stopping APScheduler. Both flushes are change-gated.

### Runtime state

Two new fields on `RuntimeState`, both `exclude=True` like the rest of the
reachability telemetry, so `flush_state`'s payload-comparison skip is unaffected:

```python
incident_rev: int = Field(default=0, exclude=True)
incident_ongoing: Incident | None = Field(default=None, exclude=True)
```

`snapshot()` publishes them inside the existing `reachability` object as `rev`
and `ongoing`.

### Removals

`reachability_checks` and `reachability_online` exist solely to compute the
since-boot percentage the header is dropping. They are removed from
`RuntimeState`, from `restore()`, and from `snapshot()`, so the payload carries
one uptime source rather than two contradictory ones. The top-level `online`
boolean is unaffected. `reachability_since`, `reachability_history`, and
`reachability_latest` are unchanged — they still drive the live strip, the
resolver rows, and "up/down for X".

### API

One new read-only route in [`api.py`](../../../tether_ddns/api.py):

```
GET /api/reachability/incidents
-> { monitoring_since, rev, incidents: [...], ongoing: {...} | null }
```

Filtered to the window on read. No query parameters — the frontend holds the
whole window and buckets it itself, which is what lets day boundaries follow the
browser's local timezone while the server stays purely epoch-based. `ongoing` is
included so a fresh fetch is self-contained.

### Hooks

Unchanged. `reachability_changed` still fires only on an online/offline
transition, so opening a `degraded` incident notifies nobody — same as today.

## Frontend

### Types

`Incident` and `IncidentWindow` mirror the backend. `Reachability` drops the
`checks` and `online` **counters** and gains `rev: number` and
`ongoing: Incident | null`. The top-level `online` boolean on `StateSnapshot` is
unrelated and unchanged.

### Data flow

A `useIncidents(rev)` hook fetches `/api/reachability/incidents` on mount and
whenever `rev` changes value — compared with `!==`, not `>`, so a server restart
that resets `rev` still triggers a refetch. Day buckets, uptime, and durations
are derived on each render from that list plus the live `ongoing` from the WS
snapshot. No polling and no timers beyond the re-render each WS frame already
causes.

### Bucketing

A pure function in `utils.ts`: given incidents and `now`, clip each span to local
midnight boundaries and return 30 `{ date, worst, incidents[] }` entries, where
`worst` orders `outage > degraded > healthy`. An incident crossing midnight is
one stored record that appears in both days' buckets, clipped. This function
carries the edge cases — midnight spanning, ongoing incidents, and DST days of 23
or 25 hours — and is unit-tested directly.

### `ReachabilityPanel`

- The live 24-check strip stays, changed to **constant-height, colour-only** bars
  so it reads consistently with the history strip below it.
- A divider, then the **30-day strip**: one flat full-height bar per day, coloured
  green when healthy, amber for `degraded`, red for `outage`.
- Each day is a `<button>` with a real focus ring and an `aria-label` such as
  *"29 August, outage, 4h 28m offline"*. Healthy days are clickable too and open
  an empty state rather than being inert.
- The header shows the clamped 30-day percentage, with a sub-line noting the
  observed span while it is under 30 days, and degraded time reported separately
  from downtime.

### `IncidentModal`

Follows the existing `DomainModal` structure:

- **Summary**: uptime, offline total, degraded total for that day.
- **24-hour timeline**: a single track with each incident positioned by time of
  day, so a 3am cluster reads differently from a scattered one.
- **Incident list**: severity tag, clock range, duration, resolver chips, and
  worst quorum. A row inherited from the previous day notes where it started.

The severity tag always reads `degraded` or `outage`. An ongoing incident is
signalled by its range rendering as `19:44 → now`, not by a separate tag.

## Testing

Backend (`test/unit/`):

- Severity classification at each boundary, including a check where quorum is
  exactly met.
- Each row of the recording table, including severity splits producing contiguous
  spans.
- **A dedicated write-policy test** asserting zero disk writes across a healthy
  run and across a steady-state incident, with writes occurring only at open,
  close, split, and prune. This is an explicit requirement, not an incidental
  assertion.
- Restart with a persisted `ongoing`: extended, split, and closed cases.
- Retention: expiry only when fully outside the window; partial overlap retained.
- Fail-soft load of a missing and a corrupt file.
- `rev` monotonicity and that it does not change on a healthy tick.
- The endpoint filters expired records.

Frontend:

- Bucketing unit tests: midnight spanning, ongoing, empty window, DST days.
- `ReachabilityPanel` renders 30 bars with correct severity classes; bars are
  focusable buttons.
- `IncidentModal` renders each edge case, including the empty state.
- Playwright: click a day bar, assert the modal opens with the expected rows.

## Out of scope

- Detecting outages that begin and end entirely while tether-ddns is stopped.
- Configurable retention — 30 days is a constant.
- Exporting or downloading incident history.
- Per-domain or per-record incident history; this is internet reachability only.
