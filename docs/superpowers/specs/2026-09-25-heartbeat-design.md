# Heartbeat — periodic GET to a push monitor (healthchecks.io)

**Date:** 2026-09-25
**Status:** approved, ready for implementation planning

## Problem

tether-ddns watches outward (reachability, public IP, DNS records), but nothing tells
the operator when tether-ddns itself stops running. Push monitors such as
healthchecks.io do this with a dead-man's switch: the service sends a GET to a
secret URL on a fixed period, and the monitor alerts when the pings stop.

## Goals

- Two new settings: a heartbeat URL and a heartbeat interval.
- A periodic job that sends `GET <url>` with `aiohttp` when a URL is set.
- The scheduled ping is **skipped while reachability reports offline**, so an outage
  does not log an error on every tick.
- Failures follow the hooks pattern: exceptions propagate, and one point handles them.
  The console gets the full traceback. The Logs view and the Overview show only
  `ExcType: message`.
- A successful ping is **not logged**. It only updates live state.
- Overview: a Heartbeat stat card replaces "Update Interval". It has a "Ping now" button.
- Settings: a Heartbeat panel with a URL field, an explicit Save button, and
  interval chips.
- Validation lives on the Pydantic models. The 422 message is shown inline under the
  URL field.

## Non-goals

- Masking the URL. The healthchecks UUID is shown in plain text, as decided.
- Ping history, latency, or any persisted heartbeat record.
- healthchecks.io-specific features (`/start`, `/fail`, exit-code suffixes, request
  bodies).
- A separate enable switch. An empty URL means off.
- Adding and removing the scheduler job when the URL is set or cleared.

## Design

### 1. Settings and validation — `tether_ddns/config_store.py`, `tether_ddns/api.py`

```python
HeartbeatInterval = Annotated[int, Field(ge=30, le=86400)]

class AppSettings(BaseModel):
    ...
    heartbeat_url: HttpUrl | None = None
    heartbeat_interval: HeartbeatInterval = 300
```

- `SettingsUpdate` (`extra='forbid'`, partial) gains
  `heartbeat_url: HttpUrl | None = None` and
  `heartbeat_interval: HeartbeatInterval | None = None`, reusing the same
  `HeartbeatInterval` alias. FastAPI rejects bad input with a 422 before
  `put_settings` runs, so the `AppSettings(...)` built inside the handler never sees
  an invalid value and cannot turn into a 500.
- `HttpUrl` accepts only `http`/`https`. `None` means off. The frontend sends an explicit
  `null` to clear the URL. `put_settings` merges with
  `model_dump(exclude_unset=True)`, so an explicit `null` is applied, while an omitted
  key leaves the value unchanged.
- `HttpUrl` normalises input. For example, `https://hc-ping.com` becomes
  `https://hc-ping.com/`. The saved, normalised value is what the API returns.
- Every endpoint that returns settings (`GET /api/state`, `GET /api/settings`,
  `PUT /api/settings`) uses `model_dump(mode='json')` so the URL is sent as a string.
- `put_settings` calls `scheduler.reschedule_heartbeat()` when
  `heartbeat_interval` changes, alongside the existing `reschedule_sync()` check.
- The 30 s minimum stops a hand-edited config from producing a 0-second job loop.

### 2. `HeartbeatStatus` in runtime state — `tether_ddns/runtime.py`

```python
class HeartbeatStatus(BaseModel):
    at: float          # epoch seconds of the attempt
    ok: bool
    skipped: bool      # scheduled tick while offline; no request sent
    error: str | None  # 'ExcType: message', or 'ExcType' when the message is empty
```

- `RuntimeState.heartbeat: HeartbeatStatus | None = Field(default=None, exclude=True)`.
  It is not persisted, the same as the reachability data.
- `set_heartbeat(status)` assigns the status and notifies listeners, so every change
  is broadcast over `/api/ws`.
- `snapshot()` includes `'heartbeat'`: `self.heartbeat.model_dump()`, or `None` when unset.

### 3. `HeartbeatService` — `tether_ddns/services/heartbeat.py` (new)

A context-owning service, like `SyncService` and `DispatchService`.

- `async _ping(url: str) -> None`: `aiohttp.ClientSession` GET with
  `ClientTimeout(total=10)`, then `raise_for_status()`. It catches nothing, and
  `aiohttp` exceptions are not wrapped in `TetherError`.
- `async run(*, force: bool = False) -> HeartbeatStatus | None`:
  1. If no `settings.heartbeat_url` is set, return `None` without changing state.
  2. If `not force` and `runtime.online` is false, record
     `HeartbeatStatus(ok=False, skipped=True, error=None)` and return it. No request is
     sent.
  3. Otherwise `try: await self._ping(str(url))`. On success, record
     `ok=True, skipped=False, error=None`. Nothing is logged.
  4. `except Exception` is the **single handling point**. It calls
     `_log.exception('Heartbeat to %s failed', url)` and records
     `ok=False, skipped=False, error=_describe(exc)`.
- `_describe(exc)` returns `f'{type(exc).__name__}: {exc}'`, or just the type name when
  `str(exc)` is empty (for example `TimeoutError`).
- `CancelledError` is not an `Exception`, so shutdown cancels an in-flight ping cleanly.
- A manual ping can overlap a scheduled one. Each only overwrites `runtime.heartbeat`,
  and the last write wins, so no lock is needed.

### 4. Scheduler — `tether_ddns/scheduler.py`

- `Scheduler.__init__` takes the `HeartbeatService` as a new trailing parameter.
  `app.py` currently builds `Scheduler(ctx, sync, dispatch, ReachabilityProbe())`.
- `start()` always adds an `id='heartbeat'` interval job at
  `settings.heartbeat_interval`, which calls `heartbeat.run()`. When the URL is empty,
  `run()` returns immediately.
- `reschedule_heartbeat()` re-adds the job with `replace_existing=True`, the same as
  `reschedule_sync()`.
- Wiring in `app.py` constructs the service and passes it to the scheduler and to
  `app.state.heartbeat`.

### 5. Ping now — `POST /api/heartbeat/ping`

- Calls `heartbeat.run(force=True)`, so it **ignores the offline check**. A manual ping
  always attempts the request and reports its outcome.
- When no URL is configured, it returns 400 with `detail='heartbeat URL not configured'`.
- Otherwise it returns `HeartbeatStatus.model_dump()`. A failed ping is still a 200,
  because the failure is the reported status and not an API error.

### 6. `LogRingHandler` empty-message fix — `tether_ddns/logging_setup.py`

`emit` currently appends `f': {type(exc).__name__}: {exc}'`, which renders
`...: TimeoutError: ` for exceptions with no message. This affects every logged
exception, hooks included. The fix appends `': ' + type name`, followed by
`': ' + message` only when the message is non-empty. Records without `exc_info` are
unchanged.

### 7. Frontend types and API — `types.ts`, `api.ts`, `App.tsx`

- `Settings` gains `heartbeat_url: string | null` and `heartbeat_interval: number`.
- `HeartbeatStatus { at: number; ok: boolean; skipped: boolean; error: string | null }`,
  and `StateSnapshot.heartbeat: HeartbeatStatus | null`. The heartbeat can be missing
  from a ws frame, so reads use `snapshot?.heartbeat ?? null`.
- `json()` throws `ApiError extends Error` with `status: number` and
  `fieldErrors: Record<string, string>`. For a 422 whose body is FastAPI's
  `{detail: [{loc, msg}]}`, each entry maps `String(loc.at(-1))` to `msg`. Every other
  non-OK response has empty `fieldErrors`. The existing message format
  (`${url} -> ${status}`) is kept, so current callers behave the same.
- `pingHeartbeat()` calls `POST /api/heartbeat/ping`.
- `handleSaveSettings` keeps its error toast and **rethrows** the error. Existing chip
  and switch callers ignore the returned promise with `void`.

### 8. Overview — `components/HeartbeatCard.tsx` (new)

- Replaces the "Update Interval" `StatCard` in `OverviewView`. The interval is still
  shown by Record Health's "Next check" countdown.
- Reuses the `.stat` markup and classes. `StatCard` itself does not fit: its `sub` is a
  plain string, and its icon slot is a tinted `<span>`, not a button.
- Top-right: `IconButton variant="act" label="Ping now"` with a new `IconActivity`
  (pulse line) in `icons.tsx`. While the request is pending it adds `.spin` and is
  disabled. The result arrives through the ws.
- Re-renders every second with its own timer, like `RecordHealthPanel`, so "42s ago"
  counts up.
- Props: `status: HeartbeatStatus | null`, `url: string | null`,
  `interval: number`, `onPing: () => Promise<void>`.

| State | Value | Sub-line | Look |
|---|---|---|---|
| `url` null | `Off` | `Set a URL in Settings` | muted, no button |
| `status` null | `—` | `every 5 min · hc-ping.com` | neutral |
| ok | `42s ago` | **OK** · every 5 min · `hc-ping.com` | ok tint |
| skipped | `Skipped` | `Link offline` | muted |
| failed | `Failed` | error, monospace, truncated; full text in `title` | err border + text |

The monospace host is `new URL(url).host` only. The full URL appears only in Settings.
`every 5 min` comes from `formatInterval(interval)`.

### 9. Settings — Heartbeat panel in `views/SettingsView.tsx`

- A fourth `.panel` in `.settings-grid`, headed `Heartbeat`.
- **Ping URL** field (`.field`, monospace input):
  - Placeholder `https://hc-ping.com/your-uuid`. Label hint:
    `— GET on every interval, while online`. Help text: `Leave empty to disable.`
  - Local `draft` state. A **Save** button (`.btn`) sits beside the input and is enabled
    only when `draft.trim()` differs from the saved value (`''` ≙ `null`). Enter also
    saves.
  - Save sends `{heartbeat_url: draft.trim() || null}`. On `ApiError`,
    `fieldErrors.heartbeat_url` is shown as `.field-help` in the error colour, with the
    input in an error-border state, until the draft changes. On success, the draft
    resets to the returned, normalised value.
- **Interval** chips: `30 s / 1 min / 5 min / 15 min` (30/60/300/900). They save
  immediately on click, like the check-interval chips. They are dimmed (`opacity`) while
  no URL is saved, but still clickable.
- No status line in Settings. Status lives on the Overview card only.

## Error handling summary

| Situation | Console | Logs view | Overview card |
|---|---|---|---|
| success | — | — | `42s ago` · OK |
| scheduled tick, offline | — | — | `Skipped` |
| HTTP 4xx/5xx, connect error, timeout | traceback | `Heartbeat to … failed: ExcType[: msg]` | `Failed` + `ExcType[: msg]` |
| invalid URL on save | — | — | (Settings) inline Pydantic `msg` |
| Ping now, no URL | — | — | button not rendered (API 400 as a backstop) |

## Testing

### Backend (`test/unit/`)

Repo gate rules apply: one-line docstrings on tests, `@pytest.mark.asyncio`,
alphabetical imports, and `patch.object` for protected members.

- `test_heartbeat_service.py` (new), with `aiohttp.ClientSession` patched as in
  `test_duckdns.py`:
  - No URL: returns `None`, no request, state unchanged.
  - Offline and not forced: `skipped=True`, no request.
  - Offline and `force=True`: request is sent.
  - Success: `ok=True`, and **no log records** (`caplog`).
  - HTTP 404: `ok=False`, `error` starts with `ClientResponseError`, and the log record
    has `exc_info`.
  - Timeout: `error == 'TimeoutError'`.
- `test_config_store.py`: defaults are `None`/300. Rejects `ftp://x` and `hc-ping.com/x`.
  Interval accepts 30 and 86400, rejects 29 and 86401. The URL survives a save/load
  round trip.
- `test_api.py`:
  - Bad URL: 422 with `loc[-1] == 'heartbeat_url'`, config unchanged.
  - Explicit `null` clears the URL.
  - An interval change calls `reschedule_heartbeat()`. Other changes don't.
  - `POST /api/heartbeat/ping`: 400 without a URL, status body with a URL (service
    patched).
  - Settings JSON has the URL as a string.
- `test_scheduler.py`: `start()` adds the `heartbeat` job at the configured interval.
  `reschedule_heartbeat()` replaces it.
- `test_runtime.py`: `set_heartbeat` notifies, `snapshot()` includes it, and
  `model_dump_json()` excludes it.
- `test_logging_setup.py` (existing): an exception with an empty message renders
  as `msg: TimeoutError` with no trailing `: `. A normal message is unchanged.

### Frontend

- `api.test.ts`: 422 `detail` becomes `fieldErrors`. A non-422 error keeps the message
  and has empty `fieldErrors`.
- `HeartbeatCard.test.tsx`: one test per state-table row. It fakes only `Date`
  (`vi.useFakeTimers({ toFake: ['Date'] })`, fixed local noon), per the repo's timezone
  convention. Ping now calls `onPing` and spins while pending. No button when off.
  The full error is in `title`.
- `SettingsView.test.tsx`: Save is disabled until the draft changes. Empty becomes
  `null`. The field error shows and clears on the next edit. The draft resets to the
  returned value. Chips are dimmed without a URL, and a click saves
  `heartbeat_interval`.
- `OverviewView.test.tsx`: no "Update Interval" card. The Heartbeat card is rendered.
- e2e (`e2e/dashboard.spec.ts`): enter `hc-ping.com/x` and Save, and Pydantic's message
  appears under the field. This covers the real 422 path end to end.

### Gates

`pytest test/ --cov=tether_ddns --cov-fail-under=90`; flake8 / mypy / pyright / ruff
over both `tether_ddns/` and `test/`; `npm test`; `npx tsc --noEmit -p tsconfig.app.json`;
`npm run test:e2e`.
