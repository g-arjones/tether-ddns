# WebSocket reconnection and post-reconnect resync

**Date:** 2026-08-31
**Status:** approved, ready for implementation planning

## Problem

When the dashboard is backgrounded for a while — a hidden browser tab, or the
standalone home-screen app closed on an iPhone — the WebSocket to `/api/ws`
closes and is never reopened. The page must be reloaded manually.

`useLiveState` opens the socket once inside a `useEffect` and returns a cleanup
that closes it. There is no `onclose` handler, no `onerror` handler, no
reconnect, no visibility handling, and no connection status is exposed to the
rest of the app:

```ts
useEffect(() => {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/api/ws`);
  ws.onmessage = (e: MessageEvent) => { /* ... */ };
  return () => ws.close();
}, []);
```

Three consequences follow.

**Nothing reconnects.** Any socket loss — OS suspension, Wi-Fi change, daemon
restart — is terminal until the operator reloads.

**Stale data is presented as live.** `App` keeps rendering the last snapshot it
received. The `online` flag in the top bar is the *daemon's* view of internet
reachability, not the browser's connection to the daemon, so a dead socket
leaves the UI cheerfully reporting "online" with minutes-old values. This
contradicts two of the project's design principles: *show real state, don't
summarize it away*, and *fail loud and clear*.

**Not everything would self-heal even if the socket did come back.** The server
pushes a full `runtime.snapshot()` and its entire log ring buffer on every
connect, so those two are free. But:

- the client *appends* log entries (`[...prev.slice(-499), payload]`), so a
  reconnect would duplicate the whole log view;
- `domains` / `hooks` / `settings` are fetched once on mount and never again;
- incidents refetch only when `reachability.rev` changes, so a day-boundary
  rollover during a long sleep leaves the 30-day window's buckets misaligned.

## Goals

1. Reconnect automatically — on resume from background, and on ordinary network
   failure — without a page reload.
2. Detect a connection that is dead but not reported as closed.
3. Never render stale state as if it were live.
4. After a reconnect, the UI matches the daemon exactly, as if freshly loaded.

## Non-goals

Explicitly out of scope, decided during brainstorming:

- A third-party reconnecting-socket library. None of the candidates implement
  the app-level heartbeat, staleness watchdog, or resume semantics this design
  needs, so adopting one would split the logic across two codebases while only
  supplying the easy part (backoff).
- Diagnostics in the disconnected overlay — attempt counts, next-retry
  countdown, a manual "Retry now" button. The overlay is deliberately minimal.
- Giving up after N attempts. Reconnection retries forever at a capped
  interval.
- Server-initiated heartbeats. The ping is client-driven; the server only
  replies.
- Changing the WebSocket envelope format, including batching the log replay
  into a single message.
- Offline-capable or queued mutations while disconnected. The overlay blocks
  interaction; nothing is buffered for later replay.
- Authentication or reconnect-time session recovery. There is no auth layer.

## Decisions taken during brainstorming

| Question | Decision |
| --- | --- |
| What does the UI show while down? | A full-page blocking overlay. |
| When does the overlay appear? | After a ~1.5s grace period, so fast recoveries are invisible. |
| How much is refreshed after reconnect? | Everything. Reconnect ≡ fresh page load. |
| How is a dead connection detected? | App-level heartbeat plus a staleness watchdog, accepting a small server change. |
| What does the overlay say? | Minimal: a spinner and one line of text. |

## Design

### 1. Transport: `LiveConnection`

New file `frontend/src/liveConnection.ts`, containing a plain TypeScript class
with no React dependency. The socket lifecycle, backoff, heartbeat, watchdog,
and status state machine all live here; `useLiveState` becomes a thin adapter
that subscribes and maps events onto React state.

This split exists because the timing logic is the part most likely to be
subtly wrong, and testing it through a React hook means driving fake timers
through `act()`. As a plain class it is tested directly.

**Status state machine:** `connecting` → `open` → `reconnecting` → `open` → …

**Reconnect.** On `close` or `error`, schedule a retry. The delay starts at
500ms, multiplies by 1.7 per attempt, and caps at 15s, with ±20% jitter applied
to each computed delay. Jitter matters because a restarted daemon would
otherwise be hit simultaneously by every open tab. Retries continue forever.

**Heartbeat.** Every 20s the client sends the text frame `"ping"`. Every
inbound frame — of any kind — stamps `lastMessageAt` before it is parsed.

**Watchdog.** Every 5s, if `now - lastMessageAt > 45s` (two missed pongs plus
slack), the socket is treated as dead regardless of what `readyState` claims:
force-close it and reconnect immediately.

The heartbeat and watchdog run only while the socket is open. Both are stopped
when it closes and restarted on the next open, and `lastMessageAt` is stamped
afresh at open so a slow connect cannot trip the watchdog on its first tick.

This is the mechanism that fixes the reported bug. iOS commonly leaves a
suspended socket in a *zombie* state where `readyState` still reports `OPEN`
and `onclose` never fires, but no frame will ever arrive again. A resume
handler that only checks `readyState` would silently fail on exactly the case
being fixed. The same mechanism covers Wi-Fi dropping while the tab is in the
foreground, where `onclose` can otherwise take minutes of TCP timeout.

**Resume triggers.** `visibilitychange` (to visible), `pageshow`, and the
`window` `online` event all do the same thing: reset backoff to zero and
re-evaluate immediately. If the socket is not `OPEN`, reconnect now. If it
claims to be `OPEN`, run the watchdog check at once rather than waiting up to
5s for the next tick. Because the OS freezes timers on a backgrounded page,
`lastMessageAt` will be far in the past on wake, so the watchdog fires
immediately — the suspension case and the zombie case resolve through one code
path.

**Interface.** `start()`, `stop()`, and an event emitter with three events:

- `status` — carries the new state machine value.
- `message` — carries a parsed envelope.
- `connected` — fired on each successful open, carrying an incrementing
  `generation` counter.

`stop()` must cancel the backoff, heartbeat, and watchdog timers, remove the
window/document listeners, and close the socket without scheduling a retry.

### 2. Server: answer the ping

The only backend change, in `ws_endpoint` in `tether_ddns/api.py`:

```python
try:
    while True:
        if await ws.receive_text() == 'ping':
            await ws.send_json({'kind': 'pong', 'payload': None})
except WebSocketDisconnect:
    app.state.manager.disconnect(ws)
```

The loop already reads and discards client text, so this is purely additive and
breaks no wire format. The client's message handler is an `if`/`else if` chain
on `kind`, so `pong` needs no explicit case — the watchdog stamp happens before
parsing, which is the entire purpose of the reply.

A side benefit: a client that stops pinging will eventually fail a broadcast
and be dropped by `ConnectionManager._broadcast_to`, so the server reaps dead
connections without further work.

### 3. Resync: `generation`

`useLiveState` returns `{ snapshot, logs, status, generation }`. `generation`
starts at `0` before any connection and the **first** successful open leaves it
at `0`; each subsequent open increments it. This matters: it means the config
effect below fires exactly once during initial page load rather than twice.
Three consumers key off it.

**Logs.** Clear `logs` to `[]` the moment a socket opens, then append as the
server's replay streams in. This reproduces the server's buffer exactly instead
of doubling it. The Logs view blinks empty for a frame during the replay, which
is accepted — the alternative is showing every line twice.

**Config.** Fold the existing mount effect in `App.tsx` into a single effect
with `generation` in its dependency array, covering `loadConfig()` plus
`getProviders()`, `getHooks()`, and `getIpSources()`. On first mount
`generation` is `0` and behaviour is unchanged; every reconnect re-runs it.
Six small GETs. This is what "reconnect ≡ fresh page load" cashes out to, and
it means a daemon that was upgraded or reconfigured while the phone slept
cannot leave the UI lying.

**Incidents.** `useIncidents` takes `generation` as a second argument alongside
`rev`, with both in its dependency array. `OverviewView` receives `generation`
as a new prop from `App` — one level of prop drilling, which is preferred here
over introducing a context for a single value.

Views that fetch on their own mount (About) are unaffected.

### 4. UI: `ConnectionOverlay`

New component `frontend/src/components/ConnectionOverlay.tsx`, rendered by
`App` as a sibling of `.shell`.

**Class names are namespaced `conn-*`.** This is a correctness constraint, not
a stylistic preference: `styles.css` contains global utility classes that
silently capture generic names — `.empty` carries `padding: 60px 20px` and has
shipped a broken layout before. jsdom cannot catch that class of bug.

**Styling** reimplements the `.modal-overlay` recipe under its own
`conn-overlay` rule rather than reusing the class: `position: fixed; inset: 0`,
the `rgba(5, 8, 16, .6)` scrim, `backdrop-filter: blur(4px)`, `--sa-*`
safe-area padding, and an opacity transition. It requires a different stacking
level — a new `--z-conn` token above `--z-modal` — because if a domain or hook
modal is open when the socket dies, the connection overlay must sit above it.

**Content** is a small centred card on `var(--surface)` with `var(--border)`
and `box-shadow: var(--shadow)`. It is a genuinely floating layer, so the
flat-by-default rule in DESIGN.md permits the elevation. Inside: a spinner and
one line of text — "Connecting…" if no socket has ever opened, "Reconnecting…"
thereafter. The spinner animation is suppressed under
`prefers-reduced-motion`.

**The 1.5s grace period lives in this component**, as a `useEffect` timer keyed
on `status`. The overlay is visible when `status !== 'open'` has held
continuously for 1.5s, and hides immediately on `open`. It therefore also
covers the initial page load: a local connect completing inside the grace
window renders nothing, while an unreachable daemon at load time shows
"Connecting…". `App` merely forwards `status`.

**Accessibility.** `role="status"` with `aria-live="polite"` on the label. The
`.shell` receives React 19's native boolean `inert` prop while the overlay is
visible, so stale data is genuinely unreachable by keyboard and assistive
technology rather than merely covered by a scrim.

## Testing

`liveConnection.test.ts` carries most of the weight, using `vi.useFakeTimers()`
and the existing `FakeWS` pattern from `useLiveState.test.tsx`, with no React
involved:

- reconnects after `close`;
- backoff grows and caps at 15s;
- jitter stays within ±20%;
- a ping is sent every 20s;
- the watchdog force-reconnects after 45s of silence **while `readyState` still
  reports `OPEN`** — the zombie case, and the test that proves the reported bug
  is fixed;
- `visibilitychange` to visible resets backoff and reconnects immediately;
- `stop()` cancels every timer and never reconnects.

Seam tests:

- `useLiveState` clears logs on reopen (guards the duplication regression) and
  surfaces `status` and `generation`;
- `useIncidents` refetches when `generation` changes but `rev` does not;
- `App` refetches config when `generation` increments;
- `ConnectionOverlay` stays hidden through the grace window then appears, with
  the correct wording in each direction.

Backend: one test in `test/unit/test_api.py` asserting `ping` produces a `pong`
envelope, with a one-line docstring ending in a period per house style. The
existing `test_refresh_and_websocket` is unaffected.

**One Playwright e2e**, because it is the only test that exercises a real
WebSocket. `context.setOffline(true)` → overlay appears →
`context.setOffline(false)` → overlay clears, data is live again, and the log
list contains no duplicate entries.

*Known risk:* if Chromium's offline emulation does not reliably tear down an
already-established WebSocket, fall back to `page.routeWebSocket()`, which is
available in the pinned Playwright 1.61 and closes the connection
deterministically.

Existing gates are unchanged: `npm test` (Vitest with `--coverage`) and
`pytest test/ --cov=tether_ddns --cov-fail-under=90`.

## Files touched

| File | Change |
| --- | --- |
| `frontend/src/liveConnection.ts` | new — socket lifecycle, backoff, heartbeat, watchdog |
| `frontend/src/liveConnection.test.ts` | new |
| `frontend/src/components/ConnectionOverlay.tsx` | new |
| `frontend/src/components/ConnectionOverlay.test.tsx` | new |
| `frontend/src/useLiveState.ts` | thin adapter; returns `status` + `generation`; clears logs on open |
| `frontend/src/useLiveState.test.tsx` | extended |
| `frontend/src/useIncidents.ts` | accepts `generation` |
| `frontend/src/useIncidents.test.tsx` | extended |
| `frontend/src/App.tsx` | renders overlay; config effect keyed on `generation` |
| `frontend/src/App.test.tsx` | extended — config refetch on reconnect |
| `frontend/src/views/OverviewView.tsx` | accepts and forwards `generation` |
| `frontend/src/styles.css` | `conn-*` rules, `--z-conn` token |
| `frontend/e2e/dashboard.spec.ts` | offline/online reconnect test |
| `tether_ddns/api.py` | `ping` → `pong` in `ws_endpoint` |
| `test/unit/test_api.py` | ping/pong test |
