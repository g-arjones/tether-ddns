# Healthchecks — show healthchecks.io project check status

**Date:** 2026-09-25
**Status:** approved, ready for implementation planning
**Branch:** `add_healthchecks_integration`

## Problem

Operators already run cron jobs, backups and SSL renewals monitored by healthchecks.io
(or a self-hosted Healthchecks instance). tether-ddns is their homelab instrument panel,
but it cannot show whether those jobs are healthy. The operator has to open a second
dashboard to see it.

## Goals

- A new **Healthchecks** view (left rail) where the operator adds healthchecks.io
  *projects*. One project is one read-only API key plus a base URL.
- Each project expands inline (accordion) to a checks table modelled on the official
  project dashboard, minus the Integrations column.
- Per-check **Overview** toggle, and a per-project **Show on Overview** toggle.
- A new Overview panel: one row per project, with a status badge per visible check.
- **Status is polled** on a per-project interval, set in the Add/Edit project modal.
- **The check list changes only on a fetch**. A fetch happens when a project is added
  and when the operator presses *Fetch checks*. A fetch drops the tether-ddns settings
  of checks that no longer exist upstream.
- Responsive down to 375px wide.

## Non-goals

- Firing tether-ddns hook events on check status changes. Healthchecks does its own
  alerting.
- Logging per-check status transitions.
- Flip history, ping history, uptime or sparklines.
- Pausing, resuming, creating or deleting checks. Read-only keys only.
- Ping URLs, tags, descriptions and integrations columns.
- Surfacing checks that exist upstream but have not been fetched yet. They are
  **silently ignored** everywhere.
- Persisting live status across restarts.

## Healthchecks API facts relied on (Management API v3)

- `GET {base}/api/v3/checks/` with header `X-Api-Key: <key>` returns `{"checks": [...]}`.
- API keys are **per project**. There is no account-wide key and no project-name endpoint.
- **Read-only** keys omit `uuid`, `ping_url`, `update_url`, `pause_url`, `resume_url` and
  `channels`. They add `unique_key`, which is stable across calls.
- Fields used: `name`, `slug`, `status` (`new | up | grace | down | paused`),
  `last_ping`, `next_ping` (ISO-8601 or `null`), `timeout` (seconds; simple checks),
  `schedule` + `tz` (cron/OnCalendar checks; no `timeout`), `grace` (seconds),
  `unique_key`.
- `401` means the key is missing or invalid. Rate limit: fewer than 100 requests/min;
  above that, `429`.

## Design

### 1. Data model — `tether_ddns/config_store.py`

```python
PollInterval = Annotated[int, Field(ge=60, le=86400)]

class HealthcheckRef(BaseModel):
    key: str            # upstream unique_key
    name: str           # last-fetched name (renders stateless badges after restart/failure)
    slug: str = ''
    visible: bool = True

class HealthchecksProject(BaseModel):
    id: str = Field(default_factory=lambda: uuid4().hex)
    name: str = Field(min_length=1)
    base_url: HttpUrl = HttpUrl('https://healthchecks.io')   # http/https only
    api_key: str = Field(min_length=1, json_schema_extra={'format': 'password'})
    poll_interval: PollInterval = 300
    show_on_overview: bool = True
    fetched_at: float | None = None      # epoch seconds
    checks: list[HealthcheckRef] = Field(default_factory=list[HealthcheckRef])  # upstream order

class AppConfig(BaseModel):
    ...
    healthchecks: list[HealthchecksProject] = Field(default_factory=list[HealthchecksProject])
```

- A config file with no `healthchecks` key loads as `[]`, so no migration is needed.
- `api_key` is masked as `MASK` (`********`) in every response. On update, an empty
  value or `MASK` keeps the stored key. This is the same rule as `merge_secrets`.

### 2. Live state — `tether_ddns/runtime.py`

```python
class CheckStatus(BaseModel):
    name: str; slug: str
    status: Literal['new', 'up', 'grace', 'down', 'paused']
    last_ping: float | None; next_ping: float | None      # epoch seconds
    timeout: int | None; schedule: str | None; tz: str | None; grace: int

class ProjectRuntime(BaseModel):
    polled_at: float | None = None
    ok: bool = False
    error: str | None = None
    offline: bool = False
    checks: dict[str, CheckStatus] = Field(default_factory=dict[str, CheckStatus])  # last SUCCESSFUL poll, fetched keys only
```

- `RuntimeState.healthchecks: dict[str, ProjectRuntime]` is included in `snapshot()`, so
  it streams over `/api/ws`. It is **excluded from state persistence**, like
  `reachability_history`.
- Setter methods notify listeners, following the existing `set_heartbeat` pattern.
- A failed poll sets `ok=False` and `error` and **keeps `checks`** from the last good
  poll. The last-ping and period columns stay informative. Status still renders
  `unknown`.
- `rebuild(cfg)` drops runtime entries for deleted projects.

### 3. Display status — the one rule (frontend)

For a fetched check `key` in project `p` with runtime `r`:

| Condition                                              | Display   |
|--------------------------------------------------------|-----------|
| `r` missing, or `r.polled_at is None`                  | `unknown` |
| `r.offline` or not `r.ok`                              | `unknown` |
| `key not in r.checks`                                  | `gone`    |
| otherwise                                              | `r.checks[key].status` |

`unknown` and `gone` both render as **stateless**: a dashed gray badge or dot with no fill.
`new` renders as a muted slate badge. `grace` is labelled **late** in amber, `down` in red,
`paused` in slate, and `up` as a neutral pill with a green dot (the Silent-Until-State rule).
The frontend owns rendering through `checkDisplayStatus(project, runtime, key)` in `utils.ts`.
The backend does not need this function because it never renders.

### 4. Client — `tether_ddns/healthchecks.py`

`async def list_checks(base_url: str, api_key: str) -> list[RemoteCheck]`

- `GET {str(base_url).rstrip('/')}/api/v3/checks/`. Pydantic normalises `HttpUrl` with a
  trailing `/`, so strip it before joining. The path is joined on the backend and
  nothing the client sends becomes a path. Header `X-Api-Key`. `aiohttp` with a 10s total
  timeout and `allow_redirects=False` (aiohttp only strips `Authorization`, not `X-Api-Key`,
  on a cross-origin redirect); a 3xx is reported as `HTTP <code>` via the normal error path.
- `RemoteCheck` is a Pydantic model that ignores extra fields.
- Raises `HealthchecksError(message)`. The message never contains the key:

| Failure                              | Message                                           |
|--------------------------------------|---------------------------------------------------|
| HTTP 401                             | `401 Unauthorized — API key invalid or revoked`   |
| HTTP 429                             | `429 Rate limited`                                |
| other non-2xx                        | `HTTP <code>`                                     |
| connection error / timeout           | `Unreachable: <reason>`                           |
| non-JSON / schema mismatch           | `Unexpected response`                             |
| any check carries `uuid`             | `Use a read-only API key`                         |

A project with zero checks cannot be verified as read-only this way. Its key is accepted.

### 5. Service — `tether_ddns/services/healthchecks.py`

`HealthchecksService(ctx)`:

- **`poll(project_id)`**, scheduled:
  - Offline: set `offline=True`, emit, and send no request.
  - Otherwise call `list_checks`. On success, set `ok=True, offline=False, error=None,
    polled_at=now`, and `checks = {c.unique_key: …}` **filtered to keys in `p.checks`**.
    Unfetched upstream checks are dropped.
  - On `HealthchecksError`, set `ok=False, error=msg, polled_at=now` and keep `checks`.
  - Logging: one WARNING line on the transition from ok to failing
    (`Healthchecks "<name>": <msg>`) and one INFO line on recovery. Nothing is logged
    per poll.
- **`fetch(project_id) -> HealthchecksProject`**, manual. It runs **regardless of
  offline**, like "Ping now".
  - Calls `list_checks`, then rebuilds `p.checks` in upstream order. Surviving keys keep
    `visible`. New keys get `visible=True`. Missing keys are **dropped** along with their
    settings. `name` and `slug` are refreshed.
  - Sets `fetched_at=now`, persists the config, and updates the runtime as a successful
    poll.
  - On error it raises with **no config or runtime change**.
- **`validate(base_url, api_key) -> list[RemoteCheck]`** is a thin wrapper used by
  create and edit.
- **Race safety**: both `poll` and `fetch` re-check `self._project(project_id) is project`
  right after their `await`. If the project was deleted or replaced (e.g. by a concurrent
  PUT) while the request was in flight, `poll` silently drops the result (no runtime write,
  no log) and `fetch` raises `HealthchecksError('Project changed during fetch — try again')`
  instead of mutating the detached old object.
- **Reachability transitions**, hooked where `Scheduler.check_reachability` already
  detects them, dispatch `reachability_changed` first so a slow or raising Healthchecks
  instance never delays or aborts the core hooks:
  - Going offline marks every project `offline=True` (`mark_offline`) so the Overview goes
    stateless at once. `HealthchecksService.poll_all` does not exist; there is nothing to
    poll while offline.
  - Coming back online does not poll directly. `Scheduler.nudge_healthchecks()` brings
    every project's existing poll job forward with
    `modify_job(job_id, next_run_time=datetime.now(timezone.utc))`, tolerating
    `JobLookupError`, so each project polls on its own job rather than sequentially
    blocking the transition.

### 6. Scheduler — `tether_ddns/scheduler.py`

- There is one interval job per project, id `healthchecks:<project_id>`, every
  `poll_interval` s.
- With `run_now`, add the job with `next_run_time=datetime.now(timezone.utc)` so the
  first poll is immediate; otherwise omit the kwarg. **Never** pass `next_run_time=None`, because in APScheduler 3.x that pauses
  the job.
- `schedule_healthchecks(project, *, run_now)` replaces the job.
  `unschedule_healthchecks(id)` removes it.
- `start()` schedules every configured project with `run_now=True`.

### 7. REST API — `tether_ddns/api.py`

| Method & path                                  | Behaviour |
|------------------------------------------------|-----------|
| `GET /api/healthchecks`                        | List projects (key masked). |
| `POST /api/healthchecks`                       | Body: `name, base_url, api_key, poll_interval, show_on_overview`. Calls `validate`, builds `checks` from the result (all visible), sets `fetched_at`, persists, seeds the runtime as a successful poll, and schedules the job **without** `run_now` (the first poll comes one interval later). Returns the masked project (200, like `POST /domains`). On `HealthchecksError` it returns **422** with nothing saved. The error goes on `api_key` for 401 and read-write keys, and on `base_url` for all other failures. |
| `PUT /api/healthchecks/{id}`                   | Partial update (`extra='forbid'`). The result is merged and re-validated as a `HealthchecksProject`; an explicit `null` becomes a FastAPI-shaped 422, like `put_settings`. If `base_url` or `api_key` changed, it calls `validate` first (**422** on failure, nothing saved), then re-fetches the project (**404** if it was deleted meanwhile) before merging, refreshes `checks` via `merge_refs` from the validation result, stamps `fetched_at`, and reschedules the poll job **without** `run_now` (the fresh runtime was just recorded). If only `poll_interval` changed, it reschedules **with** `run_now` and the check list is untouched. Returns the masked project. |
| `DELETE /api/healthchecks/{id}`                | Removes the project, its job and its runtime entry. Returns `{"ok": true}`, like `DELETE /domains`. |
| `POST /api/healthchecks/{id}/fetch`            | `service.fetch`. Returns the masked project. On `HealthchecksError` it returns **502** `{detail: msg}`. |
| `PUT /api/healthchecks/{id}/checks/{key}`      | Body `{visible: bool}`. Persists and returns the masked project. **404** for an unknown project or key. |

Unknown project ids return 404 on every `{id}` route.

### 8. Frontend

**Types and API.**
- `types.ts`: `HealthchecksProject`, `HealthcheckRef`, `ProjectRuntime`, `CheckStatus`,
  and `StateSnapshot.healthchecks?: Record<string, ProjectRuntime>`. The field is
  optional; always read it as `snapshot?.healthchecks?.[id]`.
- `api.ts`: `getHealthchecks`, `createHealthchecks`, `updateHealthchecks`,
  `deleteHealthchecks`, `fetchHealthchecks`, `setCheckVisible`. 422 responses surface
  as `ApiError.fieldErrors`.
- App.tsx holds `projects`, loads it on mount and reloads it after every mutation.

**Rail.**
- `ViewKey` gains `'healthchecks'`: label "Healthchecks", `count` = project count,
  placed between Hooks and Logs.
- The icon is a new `IconHeartPulse` in `icons.tsx`, the only home for icons.

**`views/HealthchecksView.tsx`.**
- `SectionHeader` with `count={{ n, noun: 'project' }}`, a "+ Add project" primary
  button, and `EmptyState` when there are no projects.

**`components/ProjectCard.tsx`**, an accordion item. Several can be open at once, and all
start collapsed.
- Header:
  - chevron `IconButton` with `aria-expanded`;
  - name, plus a summary: counts by display status (e.g. `5 up · 2 down · 7 checks`), or
    `N checks · status unknown`;
  - the `.switch` "Show on Overview";
  - `IconButton`s: Fetch checks (busy while running), Edit, Delete (`window.confirm`).
- Facts row: host (mono), `Poll every 2m`, `Last poll 14s ago`, `Fetched 3d ago`.
- Banner:
  - red `.err`-style `Last poll failed: <error>` when `!ok && !offline`;
  - neutral `System is offline — polling paused.` when `offline`.
- Fetch failures show a toast.

**`components/ChecksTable.tsx`**, rendered in the card's inset area.

| Column         | Content |
|----------------|---------|
| Status         | status pill (§3) |
| Name           | check name. For `gone` rows: dimmed, with sub-line "Not in last poll — Fetch to remove". |
| Slug           | mono |
| Period / Grace | `humanDuration(timeout)`, or `schedule` in mono with `tz`; sub-line `humanDuration(grace)` |
| Last ping      | relative (`4 months ago`), absolute in `title`; `—` if none |
| Overview       | `.switch` bound to `visible` (`aria-label="Show <name> on Overview"`) |

- For `unknown` rows, period and last ping still show the last good values.
- The **last row has no bottom divider** (`tr:last-child td { border-bottom: none }`).

**`components/ProjectModal.tsx`**, add and edit via `Modal`.
- Fields:
  - Name.
  - Base URL, default `https://healthchecks.io`.
  - API key: password input. When editing it starts empty with placeholder "unchanged".
  - Poll interval chips: 1m, 2m, 5m, 15m, 1h. This is the heartbeat chips pattern.
- Help text: "Use a **read-only** API key (Healthchecks → Project Settings → API Access)."
- The primary button reads "Add & fetch" when adding and "Save" when editing.
- 422 `fieldErrors` render inline under their fields.
- Mounted as a **sibling of `.shell`** in App.tsx and included in the `anyModalOpen` /
  `inert` / `aria-hidden={open ? undefined : true}` handling.

**`components/HealthchecksPanel.tsx`**, on the Overview.
- A `.panel ov-wide` placed after Reachability, titled "Healthchecks".
- One row per project with `show_on_overview`, listing only `visible` checks. A row is a
  grid: the left side has the name and summary (`3 up · 1 down · 1 gone`, or
  `status unknown`); the right side has the wrapped badges.
- Each badge has a `title` with its status and last ping.
- The panel is **omitted entirely** when there are no rows.
- Class names are namespaced (`hc-*`) so the global `.empty`/utility collisions can't
  happen.

**Utils.** `checkDisplayStatus`, `projectSummary(project, runtime, onlyVisible)`, and
`humanDuration(seconds)` (`1 day 2 hours`, `10 minutes`).

### 9. Responsive

| Breakpoint | ChecksTable | ProjectCard | HealthchecksPanel |
|-----------|-------------|-------------|-------------------|
| > 900px   | all six columns | single header row | two-column row grid |
| ≤ 900px   | **Slug** hidden | unchanged | unchanged |
| ≤ 620px   | **Status column hidden.** A status dot (§3 colors, dashed when stateless) sits before the name, with a visually hidden status label. **Period/Grace column hidden.** Its content moves to the name's sub-line (`1 day · grace 3 hours`). Remaining columns: Check · Last ping (short form, `4mo ago`) · toggle. | Actions (switch, Fetch, Edit, Delete) wrap to a second row. Facts wrap. | Rows stack: name and summary above the badges. |

The reference mockup is `.superpowers/brainstorm/*/content/mobile.html` (not committed).

### 10. Errors and security

- Every failure is loud and specific (§4). Nothing fails silently except unfetched
  checks, which are ignored by design.
- The key never appears in logs, errors, URLs or responses. It is sent only as a header.
- `base_url` is limited to `HttpUrl` (http/https). The request path is fixed by the
  backend.
- Upstream strings are rendered as React text only.
- `poll_interval ≥ 60` keeps even many projects well under the 100 requests/min rate
  limit.

## Testing

**Backend** (`test/unit/`, strict flake8/mypy/pyright/ruff, one-line docstrings, `pytest.mark.asyncio`):
- `test_healthchecks_client.py`:
  - sends the `X-Api-Key` header and the joined path;
  - every row of the §4 error table;
  - rejects read-write keys (`uuid` present);
  - accepts an empty project;
  - ignores extra fields.
- `test_healthchecks_service.py`:
  - poll filters to fetched keys, so unfetched keys are ignored;
  - a missing key makes the display `gone`;
  - offline makes no request and sets `offline`;
  - failure keeps `checks`;
  - a warning is logged on the ok→fail transition only, and info on recovery;
  - fetch keeps `visible`, adds new checks as visible, drops removed ones and refreshes
    names;
  - a failed fetch changes nothing;
  - offline and online transitions.
- `test_scheduler.py`: job added with an immediate run on start and on edit, and without
  one on create; replaced on edit; removed on delete; `start()` schedules all.
- `test_api.py`:
  - all six routes;
  - masking, and the masked key kept on PUT;
  - 422 field routing for `api_key` vs `base_url`;
  - explicit null returns 422;
  - fetch returns 502;
  - unknown project or key returns 404;
  - a PUT without a URL or key change makes no validate call.
- `test_config_store.py`: legacy config without `healthchecks` loads; round-trip.
- Inject every store into `create_app` so tests leak no files into cwd.
- Coverage stays ≥ 90%.

**Frontend** (Vitest + oxlint, **plus** `npx tsc --noEmit -p tsconfig.app.json`):
- `checkDisplayStatus`: every row of §3. Also `projectSummary` and `humanDuration`.
- `HealthchecksPanel`:
  - omitted when empty;
  - respects `show_on_overview` and `visible`;
  - stateless badges on failed or offline polls;
  - a snapshot with no `healthchecks` field.
- `ProjectCard` / `ChecksTable`: expand/collapse, both toggles call the API, the gone
  row, both banners, fetch toast on failure.
- `ProjectModal`: inline 422s; "unchanged" key on edit; default base URL.
- `api.ts` calls.
- Tests with times pin to local noon (`vi.useFakeTimers({ toFake: ['Date'] })`).

**Playwright** (`page.route` stubs `/api/healthchecks*`; `routeWebSocket` injects state
frames):
- nav item opens the view;
- the add flow shows the inline 422;
- card expand;
- the last table row has `border-bottom-width: 0`;
- the Overview panel appears below Reachability;
- the closed ProjectModal's controls are unreachable by Tab;
- at 375px, the Status and Slug columns are hidden, the dot is visible, and the table
  does not overflow the card (geometry assertion);
- wait for `.modal` `transform: none` before measuring.
