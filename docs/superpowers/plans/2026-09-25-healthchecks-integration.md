# Healthchecks.io Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Healthchecks view where you add healthchecks.io (or self-hosted) projects using read-only API keys. It polls each project's check status on a per-project interval and shows the visible checks as badges on the Overview.

**Architecture:** Project config lives in the config file, under `AppConfig.healthchecks`: the masked key, the check list from the last fetch, and the visibility toggles. The last poll result is kept in memory only, in `RuntimeState.healthchecks`, and streams over `/api/ws`. A read-only aiohttp client (`tether_ddns/healthchecks.py`) calls `GET /api/v3/checks/`. `HealthchecksService` owns polling and fetching. The scheduler runs one APScheduler job per project. On the frontend, React components (accordion `ProjectCard` + `ChecksTable`, `HealthchecksPanel`, `ProjectModal`) all read one pure status function, `checkDisplayStatus`.

**Tech Stack:** Python ≥3.12, FastAPI, Pydantic 2.13, aiohttp 3.14, APScheduler 3.x; React 19 + Vite, Vitest + Testing Library, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-25-healthchecks-integration-design.md`

## Global Constraints

- Read-only API keys only. Any upstream check carrying `uuid` → `HealthchecksError('Use a read-only API key', 'api_key')`.
- Check identity = upstream `unique_key` (stored as `key`).
- The check list changes **only** on a fetch (on add, or when you press *Fetch checks*). Polls ignore upstream checks that were never fetched.
- Status shown for each check. `unknown` and `gone` both render stateless (dashed gray):
  - `unknown` when there is no runtime entry, `polled_at is None`, `offline`, or `!ok`;
  - otherwise `gone` when the key is missing from the runtime checks;
  - otherwise the upstream status (`new | up | grace | down | paused`).
- `grace` is labelled **late** (amber). `new` and `paused` are muted slate. `up` is a neutral pill with a green dot.
- `poll_interval` is 60–86400 s, default 300. `base_url` is `HttpUrl`, default `https://healthchecks.io`. Pydantic stores it WITH a trailing `/`; strip it before joining.
- The API key is masked as `MASK` (`'********'`) in every response. On update, `''` or `MASK` keeps the stored key. The key is never logged and only ever sent in the `X-Api-Key` header.
- The HTTP timeout is 10 s total.
- Scheduled polls are skipped while offline. Manual fetch runs regardless.
- Logging: one WARNING when polling starts failing, `Healthchecks "<name>": <msg>`. One INFO on recovery, `Healthchecks "<name>": polling recovered`. Nothing else.
- Error messages (exact):
  - `401 Unauthorized — API key invalid or revoked` (field `api_key`)
  - `429 Rate limited`
  - `HTTP <code>`
  - `Unreachable: <ExcType: msg>`
  - `Unexpected response`
  - `Use a read-only API key` (field `api_key`)
  - Every message without a field goes on `base_url`.
- Backend gates (all must pass over `tether_ddns/` **and** `test/`): `flake8 tether_ddns/ test/`, `mypy .`, `pyright`, `ruff check .`, `pytest test/ --cov=tether_ddns --cov-fail-under=90`.
- Python test rules:
  - Every test function has a one-line docstring ending with `.`.
  - Async tests use `@pytest.mark.asyncio`.
  - Single quotes.
  - Imports sorted ASCII-alphabetically (uppercase before lowercase), one third-party package per group.
  - Inject every store into `create_app`.
- Frontend gates: `npm test` (oxlint + vitest + coverage) **and** `npx tsc --noEmit -p tsconfig.app.json` (npm test does not type-check). Run from `frontend/`.
- Frontend rules:
  - Tests pin time to local noon: `new Date(2026, 8, 25, 12, 0, 0)` with `vi.useFakeTimers({ toFake: ['Date'] })`.
  - Namespace every new CSS class `hc-*`. The global `.empty` utility carries padding.
  - New modals are siblings of `.shell` in `App.tsx` and are counted in `anyModalOpen`.
  - Read the ws field as `snapshot?.healthchecks?.[id]`; the field may be absent.
  - Icons live only in `components/icons.tsx`.
- Spec deltas (intentional, simpler):
  - `checkDisplayStatus(runtime, key)`: there is no `project` argument.
  - Delete uses `RuntimeState.drop_project_runtime` rather than pruning in `rebuild`.
  - `ApiError` gains an optional `detail` string so the 502 fetch error can be toasted.

---

## File Structure

**Backend**
- Modify `tether_ddns/config_store.py`: `PollInterval`, `DEFAULT_HEALTHCHECKS_URL`, `HealthcheckRef`, `HealthchecksProject`, and `AppConfig.healthchecks`.
- Modify `tether_ddns/runtime.py`: `CheckState`, `CheckStatus`, `ProjectRuntime`, `RuntimeState.healthchecks` with setters, and the snapshot key.
- Create `tether_ddns/healthchecks.py`: the read-only API client (`RemoteCheck`, `HealthchecksError`, `checks_url`, `list_checks`).
- Create `tether_ddns/services/healthchecks.py`: `HealthchecksService` and `merge_refs`.
- Modify `tether_ddns/scheduler.py`: per-project jobs and reachability-transition hooks.
- Modify `tether_ddns/api.py`: six routes, input models, and error helpers.
- Modify `tether_ddns/app.py`: wiring.
- Tests: `test/unit/test_config_store.py` (append), `test_runtime.py` (append), `test_healthchecks_client.py` (new), `test_healthchecks_service.py` (new), `test_scheduler.py` (append), `test_api_healthchecks.py` (new).

**Frontend** (`frontend/src/`)
- Modify `types.ts`, `api.ts`, `utils.ts`, `styles.css`, `components/icons.tsx`, `components/IconButton.tsx`, `layout/Rail.tsx`, `views/OverviewView.tsx`, and `App.tsx`.
- Create:
  - `components/HcSummary.tsx`
  - `components/HealthchecksPanel.tsx`
  - `components/ChecksTable.tsx`
  - `components/ProjectCard.tsx`
  - `components/ProjectModal.tsx`
  - `views/HealthchecksView.tsx`
- Tests:
  - new: `utils.healthchecks.test.ts`, one colocated `*.test.tsx` per new component;
  - updated: `api.test.ts`, `IconButton.test.tsx`, `Rail.test.tsx`, `OverviewView.test.tsx`, `App.runhook.test.tsx`;
  - e2e: `frontend/e2e/healthchecks.spec.ts`.
- Docs: `README.md` (new "Healthchecks" section).

---

### Task 1: Config models

**Files:**
- Modify: `tether_ddns/config_store.py`
- Test: `test/unit/test_config_store.py` (append)

**Interfaces:**
- Produces:
  - `PollInterval = Annotated[int, Field(ge=60, le=86400)]`
  - `DEFAULT_HEALTHCHECKS_URL = 'https://healthchecks.io'`
  - `HealthcheckRef(key: str, name: str, slug: str = '', visible: bool = True)`
  - `HealthchecksProject(id, name, base_url: HttpUrl, api_key: str, poll_interval: PollInterval = 300, show_on_overview: bool = True, fetched_at: float | None = None, checks: list[HealthcheckRef])`, with `str_strip_whitespace=True`
  - `AppConfig.healthchecks: list[HealthchecksProject]`

- [ ] **Step 1: Write the failing tests** (append to `test/unit/test_config_store.py`; add `HealthcheckRef, HealthchecksProject` to the existing `tether_ddns.config_store` import in ASCII order: `AppConfig, AppSettings, ConfigStore, DomainConfig, HealthcheckRef, HealthchecksProject`)

```python
def test_config_without_healthchecks_loads_empty(tmp_path: Path) -> None:
    """A config file written before healthchecks existed loads with no projects."""
    path = tmp_path / 'cfg.json'
    path.write_text('{"settings": {}, "domains": [], "hooks": []}', encoding='utf-8')
    assert ConfigStore(path).load().healthchecks == []


def test_healthchecks_project_defaults() -> None:
    """A project defaults to healthchecks.io, a 5-minute poll and Overview visibility."""
    project = HealthchecksProject(name='Homelab', api_key='k')
    assert str(project.base_url) == 'https://healthchecks.io/'
    assert project.poll_interval == 300
    assert project.show_on_overview is True
    assert project.fetched_at is None
    assert project.checks == []
    assert len(project.id) == 32


@pytest.mark.parametrize('seconds', [60, 86400])
def test_poll_interval_accepts_bounds(seconds: int) -> None:
    """The poll interval accepts its inclusive bounds."""
    assert HealthchecksProject(name='a', api_key='k', poll_interval=seconds).poll_interval == seconds


@pytest.mark.parametrize('seconds', [59, 86401])
def test_poll_interval_rejects_out_of_range(seconds: int) -> None:
    """The poll interval rejects values outside 60 s to 1 day."""
    with pytest.raises(ValidationError):
        HealthchecksProject(name='a', api_key='k', poll_interval=seconds)


def test_project_base_url_rejects_non_http() -> None:
    """Only http(s) base URLs are accepted."""
    with pytest.raises(ValidationError):
        HealthchecksProject(name='a', api_key='k', base_url='ftp://hc.example.lan')


@pytest.mark.parametrize('field', ['name', 'api_key'])
def test_project_rejects_blank_text(field: str) -> None:
    """Name and key must be non-blank after whitespace is stripped."""
    data = {'name': 'a', 'api_key': 'k', field: '   '}
    with pytest.raises(ValidationError):
        HealthchecksProject.model_validate(data)


def test_healthchecks_round_trip(tmp_path: Path) -> None:
    """Projects and their fetched checks survive a save/load cycle."""
    store = ConfigStore(tmp_path / 'cfg.json')
    project = HealthchecksProject(
        name='Homelab', api_key='secret', base_url='https://hc.example.lan/sub',
        poll_interval=120, fetched_at=1.5,
        checks=[HealthcheckRef(key='k1', name='Backup', slug='backup', visible=False)])
    store.save(AppConfig(healthchecks=[project]))
    loaded = store.load().healthchecks
    assert loaded == [project]
    assert str(loaded[0].base_url) == 'https://hc.example.lan/sub'
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `source .venv/bin/activate && pytest test/unit/test_config_store.py -q`
Expected: FAIL (`ImportError: cannot import name 'HealthcheckRef'`)

- [ ] **Step 3: Implement.** In `tether_ddns/config_store.py`:
  - change the pydantic import to `from pydantic import BaseModel, ConfigDict, Field, HttpUrl`;
  - add the following below `HeartbeatInterval`;
  - add the field to `AppConfig`.

```python
PollInterval = Annotated[int, Field(ge=60, le=86400)]
DEFAULT_HEALTHCHECKS_URL = 'https://healthchecks.io'
```

Below `HookConfig`:

```python
class HealthcheckRef(BaseModel):
    """A fetched healthchecks.io check and its tether-ddns display setting."""

    key: str
    name: str
    slug: str = ''
    visible: bool = True


class HealthchecksProject(BaseModel):
    """A healthchecks.io project polled with a read-only API key."""

    model_config = ConfigDict(str_strip_whitespace=True)

    id: str = Field(default_factory=lambda: uuid4().hex)  # noqa: A003
    name: str = Field(min_length=1)
    base_url: HttpUrl = HttpUrl(DEFAULT_HEALTHCHECKS_URL)
    api_key: str = Field(min_length=1)
    poll_interval: PollInterval = 300
    show_on_overview: bool = True
    fetched_at: float | None = None
    checks: list[HealthcheckRef] = Field(default_factory=list[HealthcheckRef])
```

In `AppConfig` add:

```python
    healthchecks: list[HealthchecksProject] = Field(
        default_factory=list[HealthchecksProject])
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pytest test/unit/test_config_store.py -q && flake8 tether_ddns/ test/ && pyright tether_ddns/config_store.py test/unit/test_config_store.py`
Expected: PASS, no lint errors.

- [ ] **Step 5: Commit**

```bash
git add tether_ddns/config_store.py test/unit/test_config_store.py
git commit -m "feat(healthchecks): config models for projects and fetched checks"
```

---

### Task 2: Runtime live state

**Files:**
- Modify: `tether_ddns/runtime.py`
- Test: `test/unit/test_runtime.py` (append)

**Interfaces:**
- Produces:
  - `CheckState = Literal['new', 'up', 'grace', 'down', 'paused']`
  - `CheckStatus(name, slug, status: CheckState, last_ping: float | None, next_ping: float | None, timeout: int | None, schedule: str | None, tz: str | None, grace: int)`
  - `ProjectRuntime(polled_at: float | None = None, ok: bool = False, error: str | None = None, offline: bool = False, checks: dict[str, CheckStatus])`
  - `RuntimeState.healthchecks: dict[str, ProjectRuntime]` (excluded from persistence)
  - `RuntimeState.set_project_runtime(project_id: str, runtime: ProjectRuntime) -> None` (emits)
  - `RuntimeState.set_healthchecks_offline(project_ids: list[str]) -> None` (emits only if something changed)
  - `RuntimeState.drop_project_runtime(project_id: str) -> None` (emits only if present)
  - `snapshot()['healthchecks']` holds `{project_id: ProjectRuntime.model_dump()}`

- [ ] **Step 1: Write the failing tests.** Append to `test/unit/test_runtime.py`, and extend the existing `from tether_ddns.runtime import (...)` with `CheckStatus` and `ProjectRuntime`, keeping ASCII order.

```python
def _check_status() -> CheckStatus:
    """Return a live status for one check."""
    return CheckStatus(
        name='Backup', slug='backup', status='up', last_ping=10.0, next_ping=None,
        timeout=86400, schedule=None, tz=None, grace=3600)


def test_set_project_runtime_emits_it_in_the_snapshot() -> None:
    """Recording a project's poll result streams it to listeners."""
    state = RuntimeState()
    seen: list[dict[str, object]] = []
    state.add_listener(seen.append)
    state.set_project_runtime(
        'p1', ProjectRuntime(polled_at=5.0, ok=True, checks={'k1': _check_status()}))
    snap = cast('dict[str, dict[str, object]]', seen[-1]['healthchecks'])
    assert snap['p1']['ok'] is True
    assert snap['p1']['checks'] == {'k1': _check_status().model_dump()}


def test_snapshot_healthchecks_defaults_to_empty() -> None:
    """A fresh state reports no project runtimes."""
    assert RuntimeState().snapshot()['healthchecks'] == {}


def test_set_healthchecks_offline_creates_and_flags_entries() -> None:
    """Going offline flags known projects and seeds entries for unpolled ones."""
    state = RuntimeState()
    state.set_project_runtime('p1', ProjectRuntime(polled_at=5.0, ok=True))
    seen: list[dict[str, object]] = []
    state.add_listener(seen.append)
    state.set_healthchecks_offline(['p1', 'p2'])
    assert state.healthchecks['p1'].offline is True
    assert state.healthchecks['p1'].ok is True
    assert state.healthchecks['p2'] == ProjectRuntime(offline=True)
    assert len(seen) == 1


def test_set_healthchecks_offline_is_silent_when_nothing_changes() -> None:
    """Re-flagging already-offline projects emits nothing."""
    state = RuntimeState()
    state.set_healthchecks_offline(['p1'])
    seen: list[dict[str, object]] = []
    state.add_listener(seen.append)
    state.set_healthchecks_offline(['p1'])
    state.set_healthchecks_offline([])
    assert seen == []


def test_drop_project_runtime_removes_and_emits_once() -> None:
    """Dropping a project runtime emits; dropping an absent one does not."""
    state = RuntimeState()
    state.set_project_runtime('p1', ProjectRuntime())
    seen: list[dict[str, object]] = []
    state.add_listener(seen.append)
    state.drop_project_runtime('p1')
    state.drop_project_runtime('p1')
    assert 'p1' not in state.healthchecks
    assert len(seen) == 1


def test_healthchecks_runtime_is_not_persisted() -> None:
    """Project runtimes are excluded from the persisted payload."""
    state = RuntimeState()
    state.set_project_runtime('p1', ProjectRuntime(ok=True))
    assert 'healthchecks' not in state.model_dump_json()
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pytest test/unit/test_runtime.py -q`
Expected: FAIL (`ImportError: cannot import name 'CheckStatus'`)

- [ ] **Step 3: Implement** in `tether_ddns/runtime.py`.

Below `Status = Literal[...]`:

```python
CheckState = Literal['new', 'up', 'grace', 'down', 'paused']
```

Below `HeartbeatStatus`:

```python
class CheckStatus(BaseModel):
    """Live state of one fetched healthchecks.io check (epoch-second timestamps)."""

    name: str
    slug: str = ''
    status: CheckState
    last_ping: float | None = None
    next_ping: float | None = None
    timeout: int | None = None
    schedule: str | None = None
    tz: str | None = None
    grace: int


class ProjectRuntime(BaseModel):
    """Outcome of a project's latest poll; ``checks`` is from the last successful one."""

    polled_at: float | None = None
    ok: bool = False
    error: str | None = None
    offline: bool = False
    checks: dict[str, CheckStatus] = Field(default_factory=dict[str, CheckStatus])
```

In `RuntimeState`, after the `heartbeat` field:

```python
    healthchecks: dict[str, ProjectRuntime] = Field(
        default_factory=dict[str, ProjectRuntime], exclude=True)
```

Methods, after `set_heartbeat`:

```python
    def set_project_runtime(self, project_id: str, runtime: ProjectRuntime) -> None:
        """Record a project's latest poll outcome and notify listeners."""
        self.healthchecks[project_id] = runtime
        self._emit()

    def set_healthchecks_offline(self, project_ids: list[str]) -> None:
        """Flag each project as paused by an outage; notify only on change."""
        changed = False
        for project_id in project_ids:
            current = self.healthchecks.get(project_id)
            if current is None:
                self.healthchecks[project_id] = ProjectRuntime(offline=True)
                changed = True
            elif not current.offline:
                current.offline = True
                changed = True
        if changed:
            self._emit()

    def drop_project_runtime(self, project_id: str) -> None:
        """Forget a deleted project's runtime, notifying if it existed."""
        if self.healthchecks.pop(project_id, None) is not None:
            self._emit()
```

In `snapshot()`, after the `'domains'` entry:

```python
            'healthchecks': {
                pid: rt.model_dump() for pid, rt in self.healthchecks.items()},
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pytest test/unit/test_runtime.py test/unit/test_state_store.py -q && flake8 tether_ddns/ test/ && pyright`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tether_ddns/runtime.py test/unit/test_runtime.py
git commit -m "feat(healthchecks): live per-project runtime in the state snapshot"
```

---

### Task 3: Read-only API client

**Files:**
- Create: `tether_ddns/healthchecks.py`
- Test: `test/unit/test_healthchecks_client.py`

**Interfaces:**
- Consumes: `CheckState` and `CheckStatus` from `tether_ddns.runtime`; `describe_exception` from `tether_ddns.logging_setup`.
- Produces:
  - `ErrorField = Literal['api_key', 'base_url']`
  - `class HealthchecksError(Exception)` with `.field: ErrorField` (default `'base_url'`)
  - `class RemoteCheck(CheckStatus)` adding `key: str`
  - `checks_url(base_url: str) -> str`
  - `async list_checks(base_url: str, api_key: str) -> list[RemoteCheck]`

- [ ] **Step 1: Write the failing tests** in `test/unit/test_healthchecks_client.py`

```python
"""Tests for the read-only Healthchecks Management API client."""
from datetime import datetime, timezone
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import aiohttp

import pytest

from tether_ddns.healthchecks import HealthchecksError, RemoteCheck, checks_url, list_checks

BASE = 'https://healthchecks.io/'
KEY = 'ro-key'


def _raw(**overrides: Any) -> dict[str, Any]:
    """Return a read-only check payload, as the v3 API sends it."""
    check: dict[str, Any] = {
        'name': 'Backup', 'slug': 'backup', 'tags': 'nas', 'desc': '', 'grace': 3600,
        'n_pings': 3, 'status': 'up', 'started': False,
        'last_ping': '2026-09-25T12:00:00+00:00', 'next_ping': None,
        'manual_resume': False, 'methods': '', 'timeout': 86400,
        'badge_url': 'https://healthchecks.io/b/2/x.svg', 'unique_key': 'abc123'}
    check.update(overrides)
    return check


def _session(
    status: int = 200, body: object = None, json_error: Exception | None = None,
) -> MagicMock:
    """Build a ClientSession double whose GET answers with status and body."""
    resp = MagicMock()
    resp.status = status
    resp.json = AsyncMock(return_value=body, side_effect=json_error)
    session = MagicMock()
    session.get.return_value.__aenter__ = AsyncMock(return_value=resp)
    session.get.return_value.__aexit__ = AsyncMock(return_value=False)
    return session


async def _call(session: MagicMock) -> tuple[list[RemoteCheck], MagicMock]:
    """Run list_checks against a patched ClientSession; return result and the class mock."""
    with patch('tether_ddns.healthchecks.aiohttp.ClientSession') as cs:
        cs.return_value.__aenter__ = AsyncMock(return_value=session)
        cs.return_value.__aexit__ = AsyncMock(return_value=False)
        return await list_checks(BASE, KEY), cs


def test_checks_url_joins_after_stripping_the_trailing_slash() -> None:
    """The endpoint is joined onto the base URL, sub-paths included."""
    assert checks_url('https://healthchecks.io/') == 'https://healthchecks.io/api/v3/checks/'
    assert checks_url('https://hc.lan/sub/') == 'https://hc.lan/sub/api/v3/checks/'


@pytest.mark.asyncio
async def test_list_checks_sends_the_key_header_with_a_timeout() -> None:
    """The request carries X-Api-Key and a 10 s total timeout."""
    session = _session(body={'checks': []})
    _, cs = await _call(session)
    session.get.assert_called_once_with(
        'https://healthchecks.io/api/v3/checks/', headers={'X-Api-Key': KEY})
    assert cs.call_args.kwargs['timeout'].total == 10


@pytest.mark.asyncio
async def test_list_checks_parses_simple_checks() -> None:
    """A simple check is keyed by unique_key with epoch-second timestamps."""
    checks, _ = await _call(_session(body={'checks': [_raw()]}))
    [check] = checks
    assert check.key == 'abc123'
    assert check.name == 'Backup' and check.slug == 'backup' and check.status == 'up'
    assert check.last_ping == datetime(2026, 9, 25, 12, tzinfo=timezone.utc).timestamp()
    assert check.next_ping is None
    assert check.timeout == 86400 and check.grace == 3600 and check.schedule is None


@pytest.mark.asyncio
async def test_list_checks_parses_cron_checks() -> None:
    """A cron check carries schedule and tz and no timeout."""
    raw = _raw(schedule='15 5 * * *', tz='UTC')
    del raw['timeout']
    [check], _ = await _call(_session(body={'checks': [raw]}))
    assert check.schedule == '15 5 * * *' and check.tz == 'UTC' and check.timeout is None


@pytest.mark.asyncio
async def test_list_checks_accepts_an_empty_project() -> None:
    """A project with no checks yields an empty list."""
    checks, _ = await _call(_session(body={'checks': []}))
    assert checks == []


@pytest.mark.asyncio
@pytest.mark.parametrize(('status', 'message', 'field'), [
    (401, '401 Unauthorized — API key invalid or revoked', 'api_key'),
    (429, '429 Rate limited', 'base_url'),
    (404, 'HTTP 404', 'base_url'),
    (503, 'HTTP 503', 'base_url'),
])
async def test_list_checks_maps_http_errors(status: int, message: str, field: str) -> None:
    """Non-2xx responses raise operator-worded errors on the right field."""
    with pytest.raises(HealthchecksError) as info:
        await _call(_session(status=status))
    assert str(info.value) == message
    assert info.value.field == field


@pytest.mark.asyncio
async def test_list_checks_rejects_read_write_keys() -> None:
    """A response that exposes uuid came from a read-write key and is refused."""
    with pytest.raises(HealthchecksError) as info:
        await _call(_session(body={'checks': [_raw(uuid='31365bce')]}))
    assert str(info.value) == 'Use a read-only API key'
    assert info.value.field == 'api_key'


@pytest.mark.asyncio
@pytest.mark.parametrize('body', [{'nope': 1}, {'checks': [_raw(unique_key=None)]}])
async def test_list_checks_rejects_unexpected_shapes(body: object) -> None:
    """A body that is not a read-only checks list is an unexpected response."""
    with pytest.raises(HealthchecksError, match='^Unexpected response$'):
        await _call(_session(body=body))


@pytest.mark.asyncio
async def test_list_checks_rejects_non_json() -> None:
    """A body that does not decode as JSON is an unexpected response."""
    with pytest.raises(HealthchecksError, match='^Unexpected response$'):
        await _call(_session(json_error=ValueError('bad json')))


@pytest.mark.asyncio
@pytest.mark.parametrize(('error', 'message'), [
    (aiohttp.ClientConnectionError('connection refused'),
     'Unreachable: ClientConnectionError: connection refused'),
    (TimeoutError(), 'Unreachable: TimeoutError'),
])
async def test_list_checks_maps_transport_errors(error: Exception, message: str) -> None:
    """Connection failures and timeouts are reported as unreachable."""
    session = _session()
    session.get.side_effect = error
    with pytest.raises(HealthchecksError) as info:
        await _call(session)
    assert str(info.value) == message
    assert info.value.field == 'base_url'
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pytest test/unit/test_healthchecks_client.py -q`
Expected: FAIL (`ModuleNotFoundError: No module named 'tether_ddns.healthchecks'`)

- [ ] **Step 3: Implement** `tether_ddns/healthchecks.py`

```python
"""Read-only client for the Healthchecks Management API v3."""
from __future__ import annotations

from datetime import datetime
from typing import Literal

import aiohttp

from pydantic import BaseModel, ConfigDict, ValidationError

from tether_ddns.logging_setup import describe_exception
from tether_ddns.runtime import CheckState, CheckStatus

ErrorField = Literal['api_key', 'base_url']
_TIMEOUT = aiohttp.ClientTimeout(total=10)


class HealthchecksError(Exception):
    """A failed Healthchecks request, worded for the operator."""

    def __init__(self, message: str, field: ErrorField = 'base_url') -> None:
        """Store the message and the form field it should be reported on."""
        super().__init__(message)
        self.field: ErrorField = field


class RemoteCheck(CheckStatus):
    """One upstream check, keyed by its read-only ``unique_key``."""

    key: str


class _RawCheck(BaseModel):
    model_config = ConfigDict(extra='ignore')

    name: str
    slug: str = ''
    status: CheckState
    last_ping: datetime | None = None
    next_ping: datetime | None = None
    timeout: int | None = None
    schedule: str | None = None
    tz: str | None = None
    grace: int
    unique_key: str | None = None
    uuid: str | None = None


class _ChecksResponse(BaseModel):
    model_config = ConfigDict(extra='ignore')

    checks: list[_RawCheck]


def checks_url(base_url: str) -> str:
    """Return the list-checks endpoint for a Healthchecks base URL."""
    base = base_url.rstrip('/')
    return f'{base}/api/v3/checks/'


def _stamp(value: datetime | None) -> float | None:
    return value.timestamp() if value is not None else None


def _raise_for_status(status: int) -> None:
    if status == 401:
        raise HealthchecksError('401 Unauthorized — API key invalid or revoked', 'api_key')
    if status == 429:
        raise HealthchecksError('429 Rate limited')
    if not 200 <= status < 300:
        raise HealthchecksError(f'HTTP {status}')


def _parse(body: object) -> list[RemoteCheck]:
    try:
        raw = _ChecksResponse.model_validate(body).checks
    except ValidationError as exc:
        raise HealthchecksError('Unexpected response') from exc
    if any(c.uuid is not None for c in raw):
        raise HealthchecksError('Use a read-only API key', 'api_key')
    checks: list[RemoteCheck] = []
    for c in raw:
        if c.unique_key is None:
            raise HealthchecksError('Unexpected response')
        checks.append(RemoteCheck(
            key=c.unique_key, name=c.name, slug=c.slug, status=c.status,
            last_ping=_stamp(c.last_ping), next_ping=_stamp(c.next_ping),
            timeout=c.timeout, schedule=c.schedule, tz=c.tz, grace=c.grace))
    return checks


async def list_checks(base_url: str, api_key: str) -> list[RemoteCheck]:
    """Return every check visible to a read-only key; raise HealthchecksError on failure."""
    try:
        async with aiohttp.ClientSession(timeout=_TIMEOUT) as session:
            async with session.get(
                    checks_url(base_url), headers={'X-Api-Key': api_key}) as resp:
                _raise_for_status(resp.status)
                body: object = await resp.json(content_type=None)
    except (aiohttp.ClientError, TimeoutError) as exc:
        raise HealthchecksError(f'Unreachable: {describe_exception(exc)}') from exc
    except ValueError as exc:
        raise HealthchecksError('Unexpected response') from exc
    return _parse(body)
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pytest test/unit/test_healthchecks_client.py -q && flake8 tether_ddns/ test/ && mypy . && pyright && ruff check .`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tether_ddns/healthchecks.py test/unit/test_healthchecks_client.py
git commit -m "feat(healthchecks): read-only Management API v3 client"
```

---

### Task 4: HealthchecksService

**Files:**
- Create: `tether_ddns/services/healthchecks.py`
- Test: `test/unit/test_healthchecks_service.py`

**Interfaces:**
- Consumes:
  - `list_checks`, `HealthchecksError` and `RemoteCheck` (Task 3)
  - `HealthcheckRef` and `HealthchecksProject` (Task 1)
  - `ProjectRuntime`, `CheckStatus` and the `RuntimeState` setters (Task 2)
- Produces:
  - `merge_refs(existing: list[HealthcheckRef], remote: list[RemoteCheck]) -> list[HealthcheckRef]`
  - `HealthchecksService(ctx)` with:
    - `async validate(base_url: str, api_key: str) -> list[RemoteCheck]`
    - `async poll(project_id: str) -> None`
    - `async fetch(project_id: str) -> HealthchecksProject` (raises `HealthchecksError`; raises `LookupError` for an unknown id)
    - `record_success(project: HealthchecksProject, remote: list[RemoteCheck]) -> None`
    - `mark_offline() -> None`
    - `async poll_all() -> None`

- [ ] **Step 1: Write the failing tests** in `test/unit/test_healthchecks_service.py`

```python
"""Tests for Healthchecks polling and manual fetch."""
import logging
from typing import cast
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from tether_ddns.config_store import AppConfig, HealthcheckRef, HealthchecksProject
from tether_ddns.context import AppContext
from tether_ddns.healthchecks import HealthchecksError, RemoteCheck
from tether_ddns.runtime import CheckState, RuntimeState
from tether_ddns.services.healthchecks import HealthchecksService, merge_refs

LIST = 'tether_ddns.services.healthchecks.list_checks'


def _remote(key: str, status: CheckState = 'up', name: str | None = None) -> RemoteCheck:
    """Build an upstream check keyed by key."""
    return RemoteCheck(
        key=key, name=name or key.upper(), slug=key, status=status, last_ping=1.0,
        next_ping=None, timeout=86400, schedule=None, tz=None, grace=3600)


def _ref(key: str, visible: bool = True) -> HealthcheckRef:
    """Build a fetched check reference."""
    return HealthcheckRef(key=key, name=key.upper(), slug=key, visible=visible)


def _setup(
    *refs: HealthcheckRef, online: bool = True,
) -> tuple[HealthchecksService, AppContext, HealthchecksProject]:
    """Build a service over one project whose fetched checks are refs."""
    project = HealthchecksProject(id='p1', name='Homelab', api_key='k', checks=list(refs))
    state = RuntimeState()
    state.online = online
    ctx = AppContext(
        AppConfig(healthchecks=[project]), state, MagicMock(), MagicMock(), MagicMock(),
        MagicMock())
    return HealthchecksService(ctx), ctx, project


def test_merge_refs_keeps_visibility_adds_new_and_drops_removed() -> None:
    """Merging keeps surviving settings, shows new checks and forgets removed ones."""
    merged = merge_refs(
        [_ref('k1', visible=False), _ref('k2')], [_remote('k3'), _remote('k1', name='Renamed')])
    assert merged == [
        HealthcheckRef(key='k3', name='K3', slug='k3', visible=True),
        HealthcheckRef(key='k1', name='Renamed', slug='k1', visible=False),
    ]


@pytest.mark.asyncio
async def test_poll_records_only_fetched_checks() -> None:
    """A poll updates fetched checks and silently ignores unfetched upstream ones."""
    service, ctx, _ = _setup(_ref('k1'), _ref('k2'))
    upstream = [_remote('k1'), _remote('k2', 'down'), _remote('k3')]
    with patch(LIST, new=AsyncMock(return_value=upstream)) as list_checks:
        await service.poll('p1')
    list_checks.assert_awaited_once_with('https://healthchecks.io/', 'k')
    rt = ctx.runtime.healthchecks['p1']
    assert rt.ok is True and rt.error is None and rt.offline is False
    assert rt.polled_at is not None
    assert set(rt.checks) == {'k1', 'k2'}
    assert rt.checks['k2'].status == 'down'


@pytest.mark.asyncio
async def test_poll_leaves_a_missing_check_out_of_runtime() -> None:
    """A fetched check absent upstream is simply missing from the poll result."""
    service, ctx, _ = _setup(_ref('k1'), _ref('k2'))
    with patch(LIST, new=AsyncMock(return_value=[_remote('k1')])):
        await service.poll('p1')
    assert set(ctx.runtime.healthchecks['p1'].checks) == {'k1'}


@pytest.mark.asyncio
async def test_poll_offline_sends_nothing() -> None:
    """A scheduled poll while offline flags the project and makes no request."""
    service, ctx, _ = _setup(_ref('k1'), online=False)
    with patch(LIST, new=AsyncMock()) as list_checks:
        await service.poll('p1')
    list_checks.assert_not_awaited()
    assert ctx.runtime.healthchecks['p1'].offline is True


@pytest.mark.asyncio
async def test_poll_failure_keeps_the_last_good_checks() -> None:
    """A failed poll records the error and keeps the previous check data."""
    service, ctx, _ = _setup(_ref('k1'))
    with patch(LIST, new=AsyncMock(return_value=[_remote('k1')])):
        await service.poll('p1')
    with patch(LIST, new=AsyncMock(side_effect=HealthchecksError('429 Rate limited'))):
        await service.poll('p1')
    rt = ctx.runtime.healthchecks['p1']
    assert rt.ok is False and rt.error == '429 Rate limited'
    assert set(rt.checks) == {'k1'}


@pytest.mark.asyncio
async def test_poll_logs_the_failure_once_and_the_recovery(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Repeated failures log one warning; the next success logs one info line."""
    service, _, _ = _setup(_ref('k1'))
    failing = AsyncMock(side_effect=HealthchecksError('429 Rate limited'))
    with caplog.at_level(logging.DEBUG, logger='tether_ddns'):
        with patch(LIST, new=failing):
            await service.poll('p1')
            await service.poll('p1')
        with patch(LIST, new=AsyncMock(return_value=[_remote('k1')])):
            await service.poll('p1')
            await service.poll('p1')
    assert [(r.levelno, r.getMessage()) for r in caplog.records] == [
        (logging.WARNING, 'Healthchecks "Homelab": 429 Rate limited'),
        (logging.INFO, 'Healthchecks "Homelab": polling recovered'),
    ]


@pytest.mark.asyncio
async def test_poll_unknown_project_is_a_noop() -> None:
    """Polling a deleted project id does nothing."""
    service, ctx, _ = _setup()
    with patch(LIST, new=AsyncMock()) as list_checks:
        await service.poll('gone')
    list_checks.assert_not_awaited()
    assert 'gone' not in ctx.runtime.healthchecks


@pytest.mark.asyncio
async def test_fetch_rebuilds_membership_and_persists() -> None:
    """A fetch merges upstream checks, stamps fetched_at, persists and records status."""
    service, ctx, project = _setup(_ref('k1', visible=False), _ref('k2'))
    with patch(LIST, new=AsyncMock(return_value=[_remote('k1'), _remote('k3')])):
        result = await service.fetch('p1')
    assert result is project
    assert [(c.key, c.visible) for c in project.checks] == [('k1', False), ('k3', True)]
    assert project.fetched_at is not None
    cast(MagicMock, ctx.config_store).save.assert_called_once_with(ctx.config)
    assert set(ctx.runtime.healthchecks['p1'].checks) == {'k1', 'k3'}


@pytest.mark.asyncio
async def test_fetch_runs_while_offline() -> None:
    """A manual fetch is attempted even when the link is offline."""
    service, _, _ = _setup(online=False)
    with patch(LIST, new=AsyncMock(return_value=[])) as list_checks:
        await service.fetch('p1')
    list_checks.assert_awaited_once()


@pytest.mark.asyncio
async def test_failed_fetch_changes_nothing() -> None:
    """A failed fetch leaves config and runtime untouched and re-raises."""
    service, ctx, project = _setup(_ref('k1'))
    with patch(LIST, new=AsyncMock(side_effect=HealthchecksError('HTTP 503'))):
        with pytest.raises(HealthchecksError):
            await service.fetch('p1')
    assert [c.key for c in project.checks] == ['k1']
    assert project.fetched_at is None
    cast(MagicMock, ctx.config_store).save.assert_not_called()
    assert 'p1' not in ctx.runtime.healthchecks


@pytest.mark.asyncio
async def test_fetch_unknown_project_raises_lookup_error() -> None:
    """Fetching an unknown id raises LookupError."""
    service, _, _ = _setup()
    with pytest.raises(LookupError):
        await service.fetch('gone')


def test_mark_offline_flags_every_project() -> None:
    """Going offline flags all configured projects in one emit."""
    service, ctx, _ = _setup()
    ctx.config.healthchecks.append(HealthchecksProject(id='p2', name='VPS', api_key='k'))
    seen: list[dict[str, object]] = []
    ctx.runtime.add_listener(seen.append)
    service.mark_offline()
    assert ctx.runtime.healthchecks['p1'].offline is True
    assert ctx.runtime.healthchecks['p2'].offline is True
    assert len(seen) == 1


@pytest.mark.asyncio
async def test_poll_all_polls_every_project() -> None:
    """poll_all polls each configured project once."""
    service, ctx, _ = _setup()
    ctx.config.healthchecks.append(HealthchecksProject(id='p2', name='VPS', api_key='k'))
    with patch.object(service, 'poll', new=AsyncMock()) as poll:
        await service.poll_all()
    assert [c.args[0] for c in poll.await_args_list] == ['p1', 'p2']
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pytest test/unit/test_healthchecks_service.py -q`
Expected: FAIL (`ModuleNotFoundError: No module named 'tether_ddns.services.healthchecks'`)

- [ ] **Step 3: Implement** `tether_ddns/services/healthchecks.py`

```python
"""Healthchecks polling and manual fetch as a context-owning service."""
from __future__ import annotations

import time

from tether_ddns.config_store import HealthcheckRef, HealthchecksProject
from tether_ddns.context import AppContext
from tether_ddns.healthchecks import HealthchecksError, RemoteCheck, list_checks
from tether_ddns.logging_setup import get_logger
from tether_ddns.runtime import CheckStatus, ProjectRuntime

_log = get_logger()


def merge_refs(
    existing: list[HealthcheckRef], remote: list[RemoteCheck],
) -> list[HealthcheckRef]:
    """Rebuild the fetched check list: keep visibility, show new, drop removed."""
    visible = {ref.key: ref.visible for ref in existing}
    return [
        HealthcheckRef(key=c.key, name=c.name, slug=c.slug, visible=visible.get(c.key, True))
        for c in remote
    ]


class HealthchecksService:
    """Polls project status on schedule and rebuilds check lists on demand."""

    def __init__(self, ctx: AppContext) -> None:
        """Create a service bound to a context."""
        self._ctx = ctx

    def _project(self, project_id: str) -> HealthchecksProject | None:
        return next((p for p in self._ctx.config.healthchecks if p.id == project_id), None)

    async def validate(self, base_url: str, api_key: str) -> list[RemoteCheck]:
        """Return the project's checks, raising HealthchecksError if unusable."""
        return await list_checks(base_url, api_key)

    def record_success(self, project: HealthchecksProject, remote: list[RemoteCheck]) -> None:
        """Store a successful poll result, filtered to the fetched checks."""
        runtime = self._ctx.runtime
        previous = runtime.healthchecks.get(project.id)
        known = {ref.key for ref in project.checks}
        checks = {
            c.key: CheckStatus.model_validate(c.model_dump(exclude={'key'}))
            for c in remote if c.key in known}
        runtime.set_project_runtime(
            project.id, ProjectRuntime(polled_at=time.time(), ok=True, checks=checks))
        if previous is not None and previous.error is not None:
            _log.info('Healthchecks "%s": polling recovered', project.name)

    async def poll(self, project_id: str) -> None:
        """Refresh one project's status; skip while offline."""
        project = self._project(project_id)
        if project is None:
            return
        runtime = self._ctx.runtime
        if not runtime.online:
            runtime.set_healthchecks_offline([project_id])
            return
        try:
            remote = await list_checks(str(project.base_url), project.api_key)
        except HealthchecksError as exc:
            previous = runtime.healthchecks.get(project_id)
            if previous is None:
                previous = ProjectRuntime()
            runtime.set_project_runtime(project_id, ProjectRuntime(
                polled_at=time.time(), ok=False, error=str(exc), checks=previous.checks))
            if previous.error is None:
                _log.warning('Healthchecks "%s": %s', project.name, exc)
            return
        self.record_success(project, remote)

    async def fetch(self, project_id: str) -> HealthchecksProject:
        """Rebuild a project's check list from upstream and persist it."""
        project = self._project(project_id)
        if project is None:
            raise LookupError(project_id)
        remote = await list_checks(str(project.base_url), project.api_key)
        project.checks = merge_refs(project.checks, remote)
        project.fetched_at = time.time()
        self._ctx.persist()
        self.record_success(project, remote)
        return project

    def mark_offline(self) -> None:
        """Flag every project as paused by an outage."""
        self._ctx.runtime.set_healthchecks_offline(
            [p.id for p in self._ctx.config.healthchecks])

    async def poll_all(self) -> None:
        """Poll every configured project once (used when the link comes back)."""
        for project in list(self._ctx.config.healthchecks):
            await self.poll(project.id)
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pytest test/unit/test_healthchecks_service.py -q && flake8 tether_ddns/ test/ && mypy . && pyright && ruff check .`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tether_ddns/services/healthchecks.py test/unit/test_healthchecks_service.py
git commit -m "feat(healthchecks): polling and fetch service"
```

---

### Task 5: Scheduler integration

**Files:**
- Modify: `tether_ddns/scheduler.py`
- Test: `test/unit/test_scheduler.py` (append)

**Interfaces:**
- Consumes: `HealthchecksService` (Task 4) and `HealthchecksProject` (Task 1).
- Produces:
  - `healthchecks_job_id(project_id: str) -> str`, which returns `'healthchecks:<id>'`
  - `Scheduler.__init__(..., heartbeat, *, healthchecks: HealthchecksService | None = None)`. When `None`, the scheduler builds `HealthchecksService(ctx)`.
  - `Scheduler.schedule_healthchecks(project: HealthchecksProject, *, run_now: bool = False) -> None`
  - `Scheduler.unschedule_healthchecks(project_id: str) -> None`
  - `start()` schedules every project with `run_now=True`.
  - `check_reachability`: on a transition, going offline calls `mark_offline()` and coming online awaits `poll_all()`.

- [ ] **Step 1: Write the failing tests.** Append to `test/unit/test_scheduler.py`:
  - add `from apscheduler.jobstores.base import JobLookupError  # pyright: ignore[reportMissingTypeStubs]` as its own third-party import group above `import pytest`, so the groups read stdlib → apscheduler → pytest → local;
  - add `HealthchecksProject` to the `tether_ddns.config_store` import (`AppConfig, DomainConfig, HealthchecksProject, HookConfig`);
  - add `from tether_ddns.services.healthchecks import HealthchecksService` between the heartbeat and incidents service imports.

```python
def _hc_calls(fake: MagicMock) -> list[Any]:
    """Return the add_job calls that registered healthchecks jobs."""
    return [
        c for c in fake.add_job.call_args_list
        if str(c.kwargs.get('id', '')).startswith('healthchecks:')]


def test_start_schedules_every_healthchecks_project_now() -> None:
    """start() adds one immediate interval job per project."""
    cfg = AppConfig(healthchecks=[
        HealthchecksProject(id='a', name='A', api_key='k', poll_interval=120),
        HealthchecksProject(id='b', name='B', api_key='k'),
    ])
    sched = _sched(cfg, RuntimeState())
    fake = MagicMock()
    with patch.object(sched, '_scheduler', fake):
        sched.start()
    calls = _hc_calls(fake)
    assert [c.kwargs['id'] for c in calls] == ['healthchecks:a', 'healthchecks:b']
    assert calls[0].args[1] == 'interval'
    assert calls[0].kwargs['seconds'] == 120
    assert calls[0].kwargs['args'] == ['a']
    assert calls[0].kwargs['replace_existing'] is True
    assert calls[0].kwargs['next_run_time'].tzinfo is not None


def test_schedule_healthchecks_without_run_now_omits_next_run_time() -> None:
    """Scheduling without run_now must not pause the job."""
    sched = _sched(AppConfig(), RuntimeState())
    fake = MagicMock()
    with patch.object(sched, '_scheduler', fake):
        sched.schedule_healthchecks(HealthchecksProject(id='a', name='A', api_key='k'))
    [call] = _hc_calls(fake)
    assert 'next_run_time' not in call.kwargs
    assert call.kwargs['seconds'] == 300


def test_schedule_healthchecks_run_now_fires_immediately() -> None:
    """run_now passes an aware next_run_time."""
    sched = _sched(AppConfig(), RuntimeState())
    fake = MagicMock()
    with patch.object(sched, '_scheduler', fake):
        sched.schedule_healthchecks(
            HealthchecksProject(id='a', name='A', api_key='k'), run_now=True)
    [call] = _hc_calls(fake)
    assert isinstance(call.kwargs['next_run_time'], datetime)
    assert call.kwargs['next_run_time'].tzinfo is not None


def test_unschedule_healthchecks_removes_the_job() -> None:
    """Unscheduling removes the project's job by id."""
    sched = _sched(AppConfig(), RuntimeState())
    fake = MagicMock()
    with patch.object(sched, '_scheduler', fake):
        sched.unschedule_healthchecks('a')
    fake.remove_job.assert_called_once_with('healthchecks:a')


def test_unschedule_healthchecks_tolerates_a_missing_job() -> None:
    """Unscheduling a job that does not exist is a no-op."""
    sched = _sched(AppConfig(), RuntimeState())
    fake = MagicMock()
    fake.remove_job.side_effect = JobLookupError('healthchecks:a')
    with patch.object(sched, '_scheduler', fake):
        sched.unschedule_healthchecks('a')


def _hc_sched(online: bool) -> tuple[scheduler.Scheduler, MagicMock, ReachabilityProbe]:
    """Build a scheduler with a mocked healthchecks service and a given link state."""
    state = RuntimeState()
    state.online = online
    ctx = _ctx(AppConfig(), state)
    hc = MagicMock(spec=HealthchecksService)
    probe = ReachabilityProbe()
    sched = scheduler.Scheduler(
        ctx, SyncService(ctx, AsyncMock()), AsyncMock(), probe, HeartbeatService(ctx),
        healthchecks=hc)
    return sched, hc, probe


@pytest.mark.asyncio
async def test_going_offline_marks_healthchecks_offline() -> None:
    """An online-to-offline transition flags projects without polling."""
    sched, hc, probe = _hc_sched(online=True)
    with patch.object(probe, 'check', new=AsyncMock(return_value=_online(False))):
        await sched.check_reachability()
    hc.mark_offline.assert_called_once_with()
    hc.poll_all.assert_not_awaited()


@pytest.mark.asyncio
async def test_coming_online_polls_every_project() -> None:
    """An offline-to-online transition polls every project at once."""
    sched, hc, probe = _hc_sched(online=False)
    with patch.object(probe, 'check', new=AsyncMock(return_value=_online(True))):
        await sched.check_reachability()
    hc.poll_all.assert_awaited_once_with()
    hc.mark_offline.assert_not_called()


@pytest.mark.asyncio
async def test_steady_reachability_leaves_healthchecks_alone() -> None:
    """No transition, no healthchecks side effects."""
    sched, hc, probe = _hc_sched(online=True)
    with patch.object(probe, 'check', new=AsyncMock(return_value=_online(True))):
        await sched.check_reachability()
    hc.poll_all.assert_not_awaited()
    hc.mark_offline.assert_not_called()
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pytest test/unit/test_scheduler.py -q`
Expected: FAIL (`AttributeError: 'Scheduler' object has no attribute 'schedule_healthchecks'` / unexpected keyword `healthchecks`)

- [ ] **Step 3: Implement** in `tether_ddns/scheduler.py`.

Imports (keep ASCII order):

```python
import contextlib
from datetime import datetime, timezone

from apscheduler.jobstores.base import JobLookupError  # pyright: ignore[reportMissingTypeStubs]
from apscheduler.schedulers.asyncio import (  # pyright: ignore[reportMissingTypeStubs]
    AsyncIOScheduler,
)

from tether_ddns.config_store import HealthchecksProject
from tether_ddns.context import AppContext
...
from tether_ddns.services.healthchecks import HealthchecksService
from tether_ddns.services.heartbeat import HeartbeatService
```

Module function, below the constants:

```python
def healthchecks_job_id(project_id: str) -> str:
    """Return the scheduler job id for a healthchecks project."""
    return f'healthchecks:{project_id}'
```

Constructor signature and body:

```python
    def __init__(
        self, ctx: AppContext, sync: SyncService,
        dispatch: DispatchService, reachability: ReachabilityProbe,
        heartbeat: HeartbeatService, *,
        healthchecks: HealthchecksService | None = None,
    ) -> None:
        """Create an unstarted scheduler bound to its services."""
        ...existing assignments...
        self._healthchecks = (
            healthchecks if healthchecks is not None else HealthchecksService(ctx))
```

In `start()`, after `self.reschedule_heartbeat(run_now=True)`:

```python
        for project in self._ctx.config.healthchecks:
            self.schedule_healthchecks(project, run_now=True)
```

New methods, after `reschedule_heartbeat`:

```python
    def schedule_healthchecks(
        self, project: HealthchecksProject, *, run_now: bool = False,
    ) -> None:
        """(Re-)add a project's poll job; ``run_now`` fires the first tick at once."""
        extra: dict[str, object] = (
            {'next_run_time': datetime.now(timezone.utc)} if run_now else {})
        self._scheduler.add_job(  # pyright: ignore[reportUnknownMemberType]
            self._healthchecks.poll, 'interval',
            seconds=project.poll_interval, args=[project.id],
            id=healthchecks_job_id(project.id), replace_existing=True, **extra,
        )

    def unschedule_healthchecks(self, project_id: str) -> None:
        """Remove a project's poll job if it exists."""
        with contextlib.suppress(JobLookupError):
            self._scheduler.remove_job(  # pyright: ignore[reportUnknownMemberType]
                healthchecks_job_id(project_id))
```

In `check_reachability`, replace the transition block:

```python
        if state.record_reachability(reach, view):
            if reach.online:
                await self._healthchecks.poll_all()
            else:
                self._healthchecks.mark_offline()
            await self._dispatch.dispatch(
                'reachability_changed',
                ReachabilityChangedEvent(
                    online=reach.online, was_online=was_online))
```

> If pyright reports `reportUnknownVariableType` on the `JobLookupError` import, add it to that line's ignore list. Do not use a blanket `# type: ignore`.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pytest test/unit/test_scheduler.py -q && flake8 tether_ddns/ test/ && mypy . && pyright && ruff check .`
Expected: PASS. In particular, the existing "emits once per tick" and transition tests are still green.

- [ ] **Step 5: Commit**

```bash
git add tether_ddns/scheduler.py test/unit/test_scheduler.py
git commit -m "feat(healthchecks): per-project poll jobs and reachability transitions"
```

---

### Task 6: REST API and app wiring

**Files:**
- Modify: `tether_ddns/api.py`, `tether_ddns/app.py`
- Test: `test/unit/test_api_healthchecks.py` (new)

**Interfaces:**
- Consumes:
  - `HealthchecksService` (`validate`, `fetch`, `record_success`) and `merge_refs` (Task 4)
  - `Scheduler.schedule_healthchecks` and `Scheduler.unschedule_healthchecks` (Task 5)
  - `RuntimeState.drop_project_runtime` (Task 2)
- Produces: the routes listed below; the full request and response contract is in spec §7. Also `app.state.healthchecks`.

| Route | Returns |
|---|---|
| `GET /api/healthchecks` | list of masked projects |
| `POST /api/healthchecks` | masked project (200), or 422 |
| `PUT /api/healthchecks/{id}` | masked project, 422, or 404 |
| `DELETE /api/healthchecks/{id}` | `{"ok": true}`, or 404 |
| `POST /api/healthchecks/{id}/fetch` | masked project, 502 `{detail}`, or 404 |
| `PUT /api/healthchecks/{id}/checks/{key}` with `{visible}` | masked project, or 404 |

  A masked project is `model_dump(mode='json')` with `api_key: '********'`.

- [ ] **Step 1: Write the failing tests** in `test/unit/test_api_healthchecks.py`

```python
"""Tests for the /api/healthchecks routes."""
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient

import pytest

from tether_ddns.app import create_app
from tether_ddns.config_store import (
    AppConfig, ConfigStore, HealthcheckRef, HealthchecksProject, MASK)
from tether_ddns.healthchecks import HealthchecksError, RemoteCheck
from tether_ddns.incident_store import IncidentStore
from tether_ddns.state_store import StateStore

LIST = 'tether_ddns.services.healthchecks.list_checks'
NEW = {'name': 'Homelab', 'api_key': 'secret', 'poll_interval': 120}


def _remote(key: str) -> RemoteCheck:
    """Build an upstream check keyed by key."""
    return RemoteCheck(
        key=key, name=key.upper(), slug=key, status='up', last_ping=1.0, next_ping=None,
        timeout=86400, schedule=None, tz=None, grace=3600)


def _seed() -> HealthchecksProject:
    """Return a stored project with one fetched check."""
    return HealthchecksProject(
        id='p1', name='Homelab', api_key='secret', fetched_at=1.0,
        checks=[HealthcheckRef(key='k1', name='K1', slug='k1')])


def _client(tmp_path: Path, *projects: HealthchecksProject) -> Any:
    """Build a hermetic TestClient seeded with projects."""
    store = ConfigStore(tmp_path / 'cfg.json')
    config = AppConfig(healthchecks=list(projects))
    config.settings.update_on_startup = False
    store.save(config)
    return TestClient(create_app(
        store, StateStore(tmp_path / 'state.json'), IncidentStore(tmp_path / 'incidents.json')))


def _saved(tmp_path: Path) -> list[HealthchecksProject]:
    """Read the projects persisted to disk."""
    return ConfigStore(tmp_path / 'cfg.json').load().healthchecks


def test_list_masks_the_api_key(tmp_path: Path) -> None:
    """Listing projects never reveals the key."""
    with _client(tmp_path, _seed()) as client:
        body: list[dict[str, Any]] = client.get('/api/healthchecks').json()
    assert body[0]['api_key'] == MASK
    assert body[0]['base_url'] == 'https://healthchecks.io/'
    assert body[0]['checks'] == [{'key': 'k1', 'name': 'K1', 'slug': 'k1', 'visible': True}]


def test_create_fetches_persists_and_schedules(tmp_path: Path) -> None:
    """Creating a project validates it by fetching, then saves and schedules it."""
    with _client(tmp_path) as client:
        with patch(LIST, new=AsyncMock(return_value=[_remote('k1'), _remote('k2')])), \
                patch.object(client.app.state.scheduler, 'schedule_healthchecks') as sched:
            resp: Any = client.post('/api/healthchecks', json=NEW)
        runtime = client.app.state.runtime.healthchecks
    assert resp.status_code == 200
    body: dict[str, Any] = resp.json()
    assert body['api_key'] == MASK
    assert [c['key'] for c in body['checks']] == ['k1', 'k2']
    assert body['fetched_at'] is not None
    [saved] = _saved(tmp_path)
    assert saved.api_key == 'secret' and saved.poll_interval == 120
    sched.assert_called_once()
    assert sched.call_args.kwargs == {}
    assert runtime[body['id']].ok is True


@pytest.mark.parametrize(('error', 'field'), [
    (HealthchecksError('401 Unauthorized — API key invalid or revoked', 'api_key'), 'api_key'),
    (HealthchecksError('Use a read-only API key', 'api_key'), 'api_key'),
    (HealthchecksError('Unreachable: TimeoutError'), 'base_url'),
])
def test_create_upstream_failure_is_a_field_422(
    tmp_path: Path, error: HealthchecksError, field: str,
) -> None:
    """Upstream failures become an inline 422 on the right field; nothing is saved."""
    with _client(tmp_path) as client:
        with patch(LIST, new=AsyncMock(side_effect=error)):
            resp: Any = client.post('/api/healthchecks', json=NEW)
    assert resp.status_code == 422
    [detail] = resp.json()['detail']
    assert detail['loc'] == ['body', field]
    assert detail['msg'] == str(error)
    assert _saved(tmp_path) == []


@pytest.mark.parametrize('patch_body', [
    {'base_url': 'ftp://hc.lan'}, {'name': ''}, {'api_key': ''}, {'poll_interval': 30},
    {'unknown': 1},
])
def test_create_rejects_bad_bodies_without_calling_upstream(
    tmp_path: Path, patch_body: dict[str, object],
) -> None:
    """Invalid input is rejected before any upstream request."""
    with _client(tmp_path) as client:
        with patch(LIST, new=AsyncMock()) as list_checks:
            resp: Any = client.post('/api/healthchecks', json={**NEW, **patch_body})
    assert resp.status_code == 422
    list_checks.assert_not_awaited()


def test_update_masked_key_skips_validation(tmp_path: Path) -> None:
    """Renaming with the masked key keeps the key and makes no upstream call."""
    with _client(tmp_path, _seed()) as client:
        with patch(LIST, new=AsyncMock()) as list_checks, \
                patch.object(client.app.state.scheduler, 'schedule_healthchecks') as sched:
            resp: Any = client.put('/api/healthchecks/p1', json={'name': 'Lab', 'api_key': MASK})
    assert resp.status_code == 200
    list_checks.assert_not_awaited()
    sched.assert_not_called()
    [saved] = _saved(tmp_path)
    assert saved.name == 'Lab' and saved.api_key == 'secret'
    assert [c.key for c in saved.checks] == ['k1']


def test_update_new_key_validates_and_reschedules_now(tmp_path: Path) -> None:
    """A new key is validated with a poll and the job reruns at once; checks stay."""
    with _client(tmp_path, _seed()) as client:
        with patch(LIST, new=AsyncMock(return_value=[])) as list_checks, \
                patch.object(client.app.state.scheduler, 'schedule_healthchecks') as sched:
            resp: Any = client.put('/api/healthchecks/p1', json={'api_key': 'fresh'})
    assert resp.status_code == 200
    list_checks.assert_awaited_once_with('https://healthchecks.io/', 'fresh')
    assert sched.call_args.kwargs == {'run_now': True}
    [saved] = _saved(tmp_path)
    assert saved.api_key == 'fresh' and [c.key for c in saved.checks] == ['k1']


def test_update_failed_validation_saves_nothing(tmp_path: Path) -> None:
    """A new base URL that fails validation is a 422 and is not stored."""
    error = HealthchecksError('HTTP 404')
    with _client(tmp_path, _seed()) as client:
        with patch(LIST, new=AsyncMock(side_effect=error)):
            resp: Any = client.put(
                '/api/healthchecks/p1', json={'base_url': 'https://hc.lan'})
    assert resp.status_code == 422
    assert resp.json()['detail'][0]['loc'] == ['body', 'base_url']
    assert str(_saved(tmp_path)[0].base_url) == 'https://healthchecks.io/'


def test_update_interval_reschedules_without_validation(tmp_path: Path) -> None:
    """Changing only the interval reschedules at once without an upstream call."""
    with _client(tmp_path, _seed()) as client:
        with patch(LIST, new=AsyncMock()) as list_checks, \
                patch.object(client.app.state.scheduler, 'schedule_healthchecks') as sched:
            client.put('/api/healthchecks/p1', json={'poll_interval': 900})
    list_checks.assert_not_awaited()
    assert sched.call_args.kwargs == {'run_now': True}


@pytest.mark.parametrize('body', [
    {'poll_interval': None}, {'show_on_overview': None}, {'api_key': None}, {'checks': []},
])
def test_update_rejects_nulls_and_unknown_keys(tmp_path: Path, body: dict[str, object]) -> None:
    """Explicit nulls and unknown keys are a 422, never a 500."""
    with _client(tmp_path, _seed()) as client:
        resp: Any = client.put('/api/healthchecks/p1', json=body)
    assert resp.status_code == 422


def test_delete_removes_project_job_and_runtime(tmp_path: Path) -> None:
    """Deleting forgets the project, its job and its live state."""
    with _client(tmp_path, _seed()) as client:
        with patch.object(client.app.state.scheduler, 'unschedule_healthchecks') as unsched:
            resp: Any = client.delete('/api/healthchecks/p1')
        runtime = client.app.state.runtime.healthchecks
    assert resp.json() == {'ok': True}
    unsched.assert_called_once_with('p1')
    assert 'p1' not in runtime
    assert _saved(tmp_path) == []


def test_fetch_returns_the_updated_project(tmp_path: Path) -> None:
    """A manual fetch returns the rebuilt, masked project."""
    with _client(tmp_path, _seed()) as client:
        with patch(LIST, new=AsyncMock(return_value=[_remote('k2')])):
            resp: Any = client.post('/api/healthchecks/p1/fetch')
    assert resp.status_code == 200
    assert [c['key'] for c in resp.json()['checks']] == ['k2']
    assert resp.json()['api_key'] == MASK


def test_fetch_upstream_error_is_a_502(tmp_path: Path) -> None:
    """A failed fetch reports the upstream message as a 502."""
    with _client(tmp_path, _seed()) as client:
        with patch(LIST, new=AsyncMock(side_effect=HealthchecksError('429 Rate limited'))):
            resp: Any = client.post('/api/healthchecks/p1/fetch')
    assert resp.status_code == 502
    assert resp.json() == {'detail': '429 Rate limited'}


def test_set_check_visibility_persists(tmp_path: Path) -> None:
    """Toggling a check's Overview visibility is saved."""
    with _client(tmp_path, _seed()) as client:
        resp: Any = client.put('/api/healthchecks/p1/checks/k1', json={'visible': False})
    assert resp.json()['checks'][0]['visible'] is False
    assert _saved(tmp_path)[0].checks[0].visible is False


@pytest.mark.parametrize(('method', 'url', 'body'), [
    ('put', '/api/healthchecks/nope', {'name': 'x'}),
    ('delete', '/api/healthchecks/nope', None),
    ('post', '/api/healthchecks/nope/fetch', None),
    ('put', '/api/healthchecks/nope/checks/k1', {'visible': True}),
    ('put', '/api/healthchecks/p1/checks/nope', {'visible': True}),
])
def test_unknown_project_or_check_is_404(
    tmp_path: Path, method: str, url: str, body: dict[str, object] | None,
) -> None:
    """Unknown project ids and check keys return 404."""
    with _client(tmp_path, _seed()) as client:
        resp: Any = client.request(method.upper(), url, json=body)
    assert resp.status_code == 404
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pytest test/unit/test_api_healthchecks.py -q`
Expected: FAIL (404s for every route / `AttributeError: ... 'healthchecks'`)

- [ ] **Step 3: Implement.** In `tether_ddns/app.py`:
  - import `from tether_ddns.services.healthchecks import HealthchecksService` (placed before the `heartbeat` import);
  - build `healthchecks = HealthchecksService(ctx)` after `heartbeat = HeartbeatService(ctx)`;
  - pass `healthchecks=healthchecks` to `Scheduler(...)`;
  - set `app.state.healthchecks = healthchecks` next to `app.state.heartbeat`.

In `tether_ddns/api.py`, update the imports (ASCII order within each):

```python
import platform
import time
from importlib import metadata

from fastapi import APIRouter, FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.exceptions import RequestValidationError

from pydantic import BaseModel, ConfigDict, Field, HttpUrl, ValidationError

from tether_ddns.config_store import (
    AppSettings,
    DEFAULT_HEALTHCHECKS_URL,
    DomainConfig,
    HealthchecksProject,
    HeartbeatInterval,
    HookConfig,
    MASK,
    PollInterval,
    mask_secrets,
    merge_secrets,
)
from tether_ddns.healthchecks import HealthchecksError
from tether_ddns.hooks.base import EVENT_SPECS, HOOK_REGISTRY
...
from tether_ddns.services.dispatch import DispatchService
from tether_ddns.services.healthchecks import HealthchecksService, merge_refs
from tether_ddns.services.heartbeat import HeartbeatService
```

> **Import order:** flake8-import-order compares names case-sensitively in ASCII order (uppercase before lowercase; `DE…` < `Do…`), which gives the order above. If flake8 still reports I101, follow the order it names.

Models, after `SettingsUpdate`:

```python
class HealthchecksInput(BaseModel):
    """Incoming healthchecks.io project (id and checks assigned server-side)."""

    model_config = ConfigDict(extra='forbid', str_strip_whitespace=True)

    name: str = Field(min_length=1)
    base_url: HttpUrl = HttpUrl(DEFAULT_HEALTHCHECKS_URL)
    api_key: str = Field(min_length=1)
    poll_interval: PollInterval = 300
    show_on_overview: bool = True


class HealthchecksUpdate(BaseModel):
    """Partial project update; an empty or masked key keeps the stored one."""

    model_config = ConfigDict(extra='forbid')

    name: str | None = None
    base_url: HttpUrl | None = None
    api_key: str | None = None
    poll_interval: PollInterval | None = None
    show_on_overview: bool | None = None


class CheckVisibility(BaseModel):
    """Toggle a fetched check's Overview visibility."""

    model_config = ConfigDict(extra='forbid')

    visible: bool
```

Helpers, after `_masked_hook`:

```python
def _masked_project(p: HealthchecksProject) -> dict[str, object]:
    data: dict[str, object] = p.model_dump(mode='json')
    data['api_key'] = MASK
    return data


def _body_validation_error(exc: ValidationError) -> RequestValidationError:
    """Re-shape a model ValidationError as FastAPI's 422 with body-prefixed locs."""
    errors: list[dict[str, object]] = []
    for error in exc.errors():
        item = dict(error)
        item['loc'] = ('body', *error['loc'])
        errors.append(item)
    return RequestValidationError(errors)


def _upstream_error(exc: HealthchecksError) -> RequestValidationError:
    """Report an upstream failure as a 422 on the form field it concerns."""
    return RequestValidationError([
        {'type': 'value_error', 'loc': ('body', exc.field), 'msg': str(exc), 'input': None}])
```

Refactor `put_settings` to use the helper. Replace its `except ValidationError` body with `raise _body_validation_error(exc) from exc`.

Routes, inside `register_routes` after `ping_heartbeat`:

```python
    @router.get('/healthchecks')
    def list_healthchecks() -> list[dict[str, object]]:
        return [_masked_project(p) for p in app.state.config.healthchecks]

    @router.post('/healthchecks')
    async def create_healthchecks(payload: HealthchecksInput) -> dict[str, object]:
        service: HealthchecksService = app.state.healthchecks
        try:
            remote = await service.validate(str(payload.base_url), payload.api_key)
        except HealthchecksError as exc:
            raise _upstream_error(exc) from exc
        project = HealthchecksProject(
            **payload.model_dump(), checks=merge_refs([], remote), fetched_at=time.time())
        app.state.config.healthchecks.append(project)
        _persist(app)
        service.record_success(project, remote)
        app.state.scheduler.schedule_healthchecks(project)
        return _masked_project(project)

    @router.put('/healthchecks/{project_id}')
    async def update_healthchecks(
        project_id: str, payload: HealthchecksUpdate,
    ) -> dict[str, object]:
        i, current = find_or_404(
            app.state.config.healthchecks, project_id, 'project not found')
        set_fields = payload.model_dump(exclude_unset=True)
        if set_fields.get('api_key') in ('', MASK):
            del set_fields['api_key']
        try:
            merged = HealthchecksProject(**{**current.model_dump(), **set_fields})
        except ValidationError as exc:
            raise _body_validation_error(exc) from exc
        endpoint_changed = (
            merged.base_url != current.base_url or merged.api_key != current.api_key)
        if endpoint_changed:
            service: HealthchecksService = app.state.healthchecks
            try:
                await service.validate(str(merged.base_url), merged.api_key)
            except HealthchecksError as exc:
                raise _upstream_error(exc) from exc
        app.state.config.healthchecks[i] = merged
        _persist(app)
        if endpoint_changed or merged.poll_interval != current.poll_interval:
            app.state.scheduler.schedule_healthchecks(merged, run_now=True)
        return _masked_project(merged)

    @router.delete('/healthchecks/{project_id}')
    def delete_healthchecks(project_id: str) -> dict[str, bool]:
        i, _ = find_or_404(app.state.config.healthchecks, project_id, 'project not found')
        del app.state.config.healthchecks[i]
        _persist(app)
        app.state.scheduler.unschedule_healthchecks(project_id)
        app.state.runtime.drop_project_runtime(project_id)
        return {'ok': True}

    @router.post('/healthchecks/{project_id}/fetch')
    async def fetch_healthchecks(project_id: str) -> dict[str, object]:
        find_or_404(app.state.config.healthchecks, project_id, 'project not found')
        service: HealthchecksService = app.state.healthchecks
        try:
            project = await service.fetch(project_id)
        except HealthchecksError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        return _masked_project(project)

    @router.put('/healthchecks/{project_id}/checks/{key}')
    def set_check_visibility(
        project_id: str, key: str, payload: CheckVisibility,
    ) -> dict[str, object]:
        _, project = find_or_404(
            app.state.config.healthchecks, project_id, 'project not found')
        ref = next((c for c in project.checks if c.key == key), None)
        if ref is None:
            raise HTTPException(status_code=404, detail='check not found')
        ref.visible = payload.visible
        _persist(app)
        return _masked_project(project)
```

> `find_or_404` needs items with an `id: str`. `HealthchecksProject` satisfies its `_HasId` protocol.

- [ ] **Step 4: Run the tests and confirm they pass, then run the full backend gate**

Run: `pytest test/ -q --cov=tether_ddns --cov-fail-under=90 && flake8 tether_ddns/ test/ && mypy . && pyright && ruff check .`
Expected: all PASS. `test_api.py` settings tests are still green after the `_body_validation_error` refactor. (The only warning is the known third-party `StarletteDeprecationWarning`.)

- [ ] **Step 5: Commit**

```bash
git add tether_ddns/api.py tether_ddns/app.py test/unit/test_api_healthchecks.py
git commit -m "feat(healthchecks): REST routes and app wiring"
```

---

### Task 7: Frontend types and API client

**Files:**
- Modify: `frontend/src/types.ts`, `frontend/src/api.ts`
- Test: `frontend/src/api.test.ts` (append)

**Interfaces:**
- Produces (types): `CheckState`, `HealthcheckRef`, `HealthchecksProject`, `HealthchecksInput`, `CheckStatus`, `ProjectRuntime`, and `StateSnapshot.healthchecks?: Record<string, ProjectRuntime>`.
- Produces (api):
  - `ApiError.detail?: string`, taken from a non-422 JSON `{detail: string}`
  - `getHealthchecks()`
  - `createHealthchecks(input: HealthchecksInput)`
  - `updateHealthchecks(id, patch: Partial<HealthchecksInput>)`
  - `deleteHealthchecks(id)`
  - `fetchHealthchecks(id)`
  - `setCheckVisible(id, key, visible)`
  - All except delete return `Promise<HealthchecksProject>` (or an array of them).

- [ ] **Step 1: Write the failing tests.** In `frontend/src/api.test.ts`, extend the import to `import { ApiError, createHealthchecks, fetchHealthchecks, getHealthchecks, pingHeartbeat, putSettings, setCheckVisible, updateHealthchecks } from './api';` and append inside `describe('api', ...)`:

```ts
  it('getHealthchecks GETs /api/healthchecks', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => [] })));
    expect(await getHealthchecks()).toEqual([]);
    expect(fetch).toHaveBeenCalledWith('/api/healthchecks');
  });

  it('createHealthchecks POSTs the project as JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ id: 'p1' }) })));
    const input = { name: 'Homelab', base_url: 'https://healthchecks.io', api_key: 'k', poll_interval: 300 };
    await createHealthchecks(input);
    expect(fetch).toHaveBeenCalledWith('/api/healthchecks', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
    });
  });

  it('updateHealthchecks PUTs a partial patch', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) })));
    await updateHealthchecks('p1', { show_on_overview: false });
    expect(fetch).toHaveBeenCalledWith('/api/healthchecks/p1', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{"show_on_overview":false}',
    });
  });

  it('setCheckVisible PUTs the flag under the encoded check key', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) })));
    await setCheckVisible('p1', 'a/b', false);
    expect(fetch).toHaveBeenCalledWith('/api/healthchecks/p1/checks/a%2Fb', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{"visible":false}',
    });
  });

  it('carries a string detail on non-422 failures', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 502, json: async () => ({ detail: '429 Rate limited' }) })));
    const err = await fetchHealthchecks('p1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(502);
    expect((err as ApiError).detail).toBe('429 Rate limited');
    expect(fetch).toHaveBeenCalledWith('/api/healthchecks/p1/fetch', { method: 'POST' });
  });
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run (from `frontend/`): `npx vitest run src/api.test.ts`
Expected: FAIL (the imports don't exist)

- [ ] **Step 3: Implement.** Append to `frontend/src/types.ts`:

```ts
export type CheckState = 'new' | 'up' | 'grace' | 'down' | 'paused';
export interface HealthcheckRef { key: string; name: string; slug: string; visible: boolean; }
export interface HealthchecksProject {
  id: string;
  name: string;
  base_url: string;
  api_key: string;
  poll_interval: number;
  show_on_overview: boolean;
  fetched_at: number | null;
  checks: HealthcheckRef[];
}
export interface HealthchecksInput {
  name: string;
  base_url: string;
  api_key: string;
  poll_interval: number;
  show_on_overview?: boolean;
}
export interface CheckStatus {
  name: string;
  slug: string;
  status: CheckState;
  last_ping: number | null;
  next_ping: number | null;
  timeout: number | null;
  schedule: string | null;
  tz: string | null;
  grace: number;
}
export interface ProjectRuntime {
  polled_at: number | null;
  ok: boolean;
  error: string | null;
  offline: boolean;
  checks: Record<string, CheckStatus>;
}
```

In `StateSnapshot`, after `domains: DomainState[];`:

```ts
  // Optional: fixtures and older servers omit it — always read `snapshot?.healthchecks?.[id]`.
  healthchecks?: Record<string, ProjectRuntime>;
```

In `frontend/src/api.ts`:
- extend the type import with `HealthchecksInput, HealthchecksProject`;
- give `ApiError` a `detail`;
- read it in `json()`;
- add the calls.

```ts
export class ApiError extends Error {
  readonly status: number;
  readonly fieldErrors: Record<string, string>;
  readonly detail?: string;

  constructor(message: string, status: number, fieldErrors: Record<string, string> = {}, detail?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.fieldErrors = fieldErrors;
    this.detail = detail;
  }
}
```

After `fieldErrorsOf`:

```ts
async function detailOf(res: Response): Promise<string | undefined> {
  try {
    const body = (await res.json()) as { detail?: unknown };
    return typeof body.detail === 'string' ? body.detail : undefined;
  } catch {
    return undefined;
  }
}
```

In `json()`, replace the `!res.ok` block:

```ts
  if (!res.ok) {
    const fieldErrors = res.status === 422 ? await fieldErrorsOf(res) : {};
    const detail = res.status === 422 ? undefined : await detailOf(res);
    throw new ApiError(`${url} -> ${res.status}`, res.status, fieldErrors, detail);
  }
```

Append:

```ts
export const getHealthchecks = () => json<HealthchecksProject[]>('/api/healthchecks');
export const createHealthchecks = (input: HealthchecksInput) => json<HealthchecksProject>('/api/healthchecks', jbody(input));
export const updateHealthchecks = (id: string, patch: Partial<HealthchecksInput>) =>
  json<HealthchecksProject>(`/api/healthchecks/${id}`, { ...jbody(patch), method: 'PUT' });
export const deleteHealthchecks = (id: string) => json(`/api/healthchecks/${id}`, { method: 'DELETE' });
export const fetchHealthchecks = (id: string) => json<HealthchecksProject>(`/api/healthchecks/${id}/fetch`, { method: 'POST' });
export const setCheckVisible = (id: string, key: string, visible: boolean) =>
  json<HealthchecksProject>(`/api/healthchecks/${id}/checks/${encodeURIComponent(key)}`, { ...jbody({ visible }), method: 'PUT' });
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run src/api.test.ts && npx tsc --noEmit -p tsconfig.app.json`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/types.ts frontend/src/api.ts frontend/src/api.test.ts
git commit -m "feat(healthchecks): frontend types and API client"
```

---

### Task 8: Frontend display utilities

**Files:**
- Modify: `frontend/src/utils.ts`
- Test: `frontend/src/utils.healthchecks.test.ts` (new)

**Interfaces:**
- Produces:
  - `type CheckDisplay = CheckState | 'gone' | 'unknown'`
  - `DISPLAY_LABEL: Record<CheckDisplay, string>` (`grace → 'late'`)
  - `projectUnknown(runtime?: ProjectRuntime): boolean`
  - `checkDisplayStatus(runtime: ProjectRuntime | undefined, key: string): CheckDisplay`
  - `interface SummaryPart { status: CheckDisplay; n: number; label: string }`
  - `projectSummary(refs: HealthcheckRef[], runtime: ProjectRuntime | undefined): { unknown: boolean; parts: SummaryPart[] }`
  - `humanDuration(seconds: number): string`
  - `ago(ts: number | null, nowMs: number, short?: boolean): string`
  - `hostOf(url: string): string`

- [ ] **Step 1: Write the failing tests** in `frontend/src/utils.healthchecks.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import type { CheckStatus, HealthcheckRef, ProjectRuntime } from './types';
import { ago, checkDisplayStatus, hostOf, humanDuration, projectSummary } from './utils';

const NOW_MS = new Date(2026, 8, 25, 12, 0, 0).getTime();
const status = (s: CheckStatus['status']): CheckStatus => ({
  name: 'x', slug: 'x', status: s, last_ping: null, next_ping: null, timeout: 60, schedule: null, tz: null, grace: 60,
});
const rt = (over: Partial<ProjectRuntime> = {}): ProjectRuntime => ({
  polled_at: 1, ok: true, error: null, offline: false, checks: { a: status('up'), b: status('down') }, ...over,
});
const ref = (key: string): HealthcheckRef => ({ key, name: key, slug: key, visible: true });

describe('checkDisplayStatus', () => {
  it('is unknown without a runtime or before the first poll', () => {
    expect(checkDisplayStatus(undefined, 'a')).toBe('unknown');
    expect(checkDisplayStatus(rt({ polled_at: null }), 'a')).toBe('unknown');
  });
  it('is unknown while offline or after a failed poll, even with stale checks', () => {
    expect(checkDisplayStatus(rt({ offline: true }), 'a')).toBe('unknown');
    expect(checkDisplayStatus(rt({ ok: false, error: 'HTTP 503' }), 'a')).toBe('unknown');
  });
  it('is gone when a fetched key is missing from a good poll', () => {
    expect(checkDisplayStatus(rt(), 'zzz')).toBe('gone');
  });
  it('passes the upstream status through otherwise', () => {
    expect(checkDisplayStatus(rt(), 'a')).toBe('up');
    expect(checkDisplayStatus(rt(), 'b')).toBe('down');
  });
});

describe('projectSummary', () => {
  it('counts in a fixed order and labels grace as late', () => {
    const runtime = rt({ checks: { a: status('up'), b: status('grace'), c: status('down'), d: status('up') } });
    const { unknown, parts } = projectSummary([ref('a'), ref('b'), ref('c'), ref('d'), ref('e')], runtime);
    expect(unknown).toBe(false);
    expect(parts.map((p) => `${p.n} ${p.label}`)).toEqual(['2 up', '1 late', '1 down', '1 gone']);
  });
  it('reports unknown for the whole project when the poll is not good', () => {
    expect(projectSummary([ref('a')], rt({ offline: true }))).toEqual({ unknown: true, parts: [] });
  });
});

describe('humanDuration', () => {
  it.each([
    [60, '1 minute'], [600, '10 minutes'], [10800, '3 hours'], [93600, '1 day 2 hours'],
    [604800, '1 week'], [1209600, '2 weeks'], [5184000, '60 days'], [0, '0 seconds'],
  ])('formats %i s as %s', (seconds, text) => {
    expect(humanDuration(seconds)).toBe(text);
  });
});

describe('ago', () => {
  const at = (secondsAgo: number) => NOW_MS / 1000 - secondsAgo;
  it('renders the largest unit, long and short', () => {
    expect(ago(at(14), NOW_MS)).toBe('14 seconds ago');
    expect(ago(at(11 * 3600), NOW_MS)).toBe('11 hours ago');
    expect(ago(at(3 * 604800), NOW_MS)).toBe('3 weeks ago');
    expect(ago(at(130 * 86400), NOW_MS)).toBe('4 months ago');
    expect(ago(at(130 * 86400), NOW_MS, true)).toBe('4mo ago');
    expect(ago(at(1), NOW_MS)).toBe('1 second ago');
    expect(ago(at(0), NOW_MS, true)).toBe('0s ago');
  });
  it('renders a dash for never', () => {
    expect(ago(null, NOW_MS)).toBe('—');
  });
});

describe('hostOf', () => {
  it('returns the host, or the input when it is not a URL', () => {
    expect(hostOf('https://hc.example.lan:8000/sub/')).toBe('hc.example.lan:8000');
    expect(hostOf('not a url')).toBe('not a url');
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run src/utils.healthchecks.test.ts`
Expected: FAIL (`checkDisplayStatus is not a function` / import errors)

- [ ] **Step 3: Implement.** In `frontend/src/utils.ts`, change the first line to `import type { CheckState, HealthcheckRef, Incident, ProjectRuntime } from './types';` and append:

```ts
export type CheckDisplay = CheckState | 'gone' | 'unknown';

export const DISPLAY_LABEL: Record<CheckDisplay, string> = {
  up: 'up', grace: 'late', down: 'down', paused: 'paused', new: 'new', gone: 'gone', unknown: 'unknown',
};

export function projectUnknown(runtime: ProjectRuntime | undefined): boolean {
  return !runtime || runtime.polled_at === null || runtime.offline || !runtime.ok;
}

export function checkDisplayStatus(runtime: ProjectRuntime | undefined, key: string): CheckDisplay {
  if (projectUnknown(runtime)) return 'unknown';
  return runtime?.checks[key]?.status ?? 'gone';
}

export interface SummaryPart { status: CheckDisplay; n: number; label: string; }

const SUMMARY_ORDER: CheckDisplay[] = ['up', 'grace', 'down', 'paused', 'new', 'gone'];

export function projectSummary(
  refs: HealthcheckRef[],
  runtime: ProjectRuntime | undefined,
): { unknown: boolean; parts: SummaryPart[] } {
  if (projectUnknown(runtime)) return { unknown: true, parts: [] };
  const counts = new Map<CheckDisplay, number>();
  for (const ref of refs) {
    const display = checkDisplayStatus(runtime, ref.key);
    counts.set(display, (counts.get(display) ?? 0) + 1);
  }
  const parts = SUMMARY_ORDER
    .filter((s) => counts.has(s))
    .map((s) => ({ status: s, n: counts.get(s) ?? 0, label: DISPLAY_LABEL[s] }));
  return { unknown: false, parts };
}

const WEEK = 604800;
const DURATION_UNITS: [number, string][] = [[86400, 'day'], [3600, 'hour'], [60, 'minute'], [1, 'second']];
const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;

// Healthchecks-style period: whole weeks read as weeks, anything else as at most two units.
export function humanDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  if (total > 0 && total % WEEK === 0) return plural(total / WEEK, 'week');
  const parts: string[] = [];
  let rest = total;
  for (const [size, unit] of DURATION_UNITS) {
    const n = Math.floor(rest / size);
    if (n > 0) {
      parts.push(plural(n, unit));
      rest -= n * size;
    }
    if (parts.length === 2) break;
  }
  return parts.length > 0 ? parts.join(' ') : '0 seconds';
}

const AGO_UNITS: [number, string, string][] = [
  [2592000, 'month', 'mo'], [WEEK, 'week', 'w'], [86400, 'day', 'd'],
  [3600, 'hour', 'h'], [60, 'minute', 'm'], [1, 'second', 's'],
];

export function ago(ts: number | null, nowMs: number, short = false): string {
  if (ts === null) return '—';
  const elapsed = Math.max(0, Math.floor(nowMs / 1000 - ts));
  const [size, unit, abbr] = AGO_UNITS.find(([s]) => elapsed >= s) ?? AGO_UNITS[AGO_UNITS.length - 1];
  const n = Math.floor(elapsed / size);
  return short ? `${n}${abbr} ago` : `${plural(n, unit)} ago`;
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run src/utils.healthchecks.test.ts src/utils.test.ts && npx tsc --noEmit -p tsconfig.app.json`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/utils.ts frontend/src/utils.healthchecks.test.ts
git commit -m "feat(healthchecks): display status, summary and duration helpers"
```

---

### Task 9: Shared UI pieces (icon, IconButton props, CSS, HcSummary)

**Files:**
- Modify: `frontend/src/components/icons.tsx`, `frontend/src/components/IconButton.tsx`, `frontend/src/styles.css`
- Create: `frontend/src/components/HcSummary.tsx`
- Test: `frontend/src/components/IconButton.test.tsx` (append), `frontend/src/components/HcSummary.test.tsx` (new)

**Interfaces:**
- Produces:
  - `IconHeartPulse(p: IconProps)`
  - `IconButton` gains `disabled?: boolean` and `expanded?: boolean` (→ `aria-expanded`)
  - `HcSummary({ refs, runtime, withTotal? })` rendering `<span class="hc-sum">`, with `down`/`grace` counts in `<b class="hc-s-down|hc-s-grace">`
  - all `hc-*` CSS used by Tasks 10–12

- [ ] **Step 1: Write the failing tests.** Append to `frontend/src/components/IconButton.test.tsx` inside its `describe`:

```tsx
  it('can be disabled and report its expanded state', () => {
    render(<IconButton label="Expand" onClick={vi.fn()} disabled expanded={false}><svg /></IconButton>);
    const button = screen.getByRole('button', { name: 'Expand' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-expanded', 'false');
  });

  it('omits aria-expanded unless asked', () => {
    render(<IconButton label="Edit" onClick={vi.fn()}><svg /></IconButton>);
    expect(screen.getByRole('button', { name: 'Edit' })).not.toHaveAttribute('aria-expanded');
  });
```

(Add `render`/`screen` to its testing-library import if they are not already there.)

Create `frontend/src/components/HcSummary.test.tsx`:

```tsx
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { CheckStatus, HealthcheckRef, ProjectRuntime } from '../types';
import { HcSummary } from './HcSummary';

const st = (s: CheckStatus['status']): CheckStatus => ({
  name: 'x', slug: 'x', status: s, last_ping: null, next_ping: null, timeout: 60, schedule: null, tz: null, grace: 60,
});
const refs: HealthcheckRef[] = ['a', 'b', 'c'].map((key) => ({ key, name: key, slug: key, visible: true }));
const good: ProjectRuntime = { polled_at: 1, ok: true, error: null, offline: false, checks: { a: st('up'), b: st('down') } };

describe('HcSummary', () => {
  it('lists counts and highlights down', () => {
    const { container } = render(<HcSummary refs={refs} runtime={good} />);
    expect(container.textContent).toBe('1 up · 1 down · 1 gone');
    expect(container.querySelector('b.hc-s-down')).toHaveTextContent('1 down');
  });

  it('appends the total when asked', () => {
    const { container } = render(<HcSummary refs={refs} runtime={good} withTotal />);
    expect(container.textContent).toBe('1 up · 1 down · 1 gone · 3 checks');
  });

  it('reads status unknown when the poll is not good', () => {
    const { container } = render(<HcSummary refs={refs} runtime={{ ...good, offline: true }} withTotal />);
    expect(container.textContent).toBe('3 checks · status unknown');
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run src/components/IconButton.test.tsx src/components/HcSummary.test.tsx`
Expected: FAIL

- [ ] **Step 3: Implement.** Append to `frontend/src/components/icons.tsx`:

```tsx
export function IconHeartPulse(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />
      <path d="M3.22 12H9.5l.5-1 2 4.5 2-7 1.5 3.5h5.27" />
    </Svg>
  );
}
```

`frontend/src/components/IconButton.tsx`:
- add `disabled?: boolean;` and `expanded?: boolean;` to `IconButtonProps`;
- destructure them (`disabled = false, expanded,`);
- add `disabled={disabled}` and `aria-expanded={expanded}` to the `<button>`.

Create `frontend/src/components/HcSummary.tsx`:

```tsx
import { Fragment, type JSX, type ReactNode } from 'react';
import type { HealthcheckRef, ProjectRuntime } from '../types';
import { projectSummary } from '../utils';

export interface HcSummaryProps {
  refs: HealthcheckRef[];
  runtime: ProjectRuntime | undefined;
  withTotal?: boolean;
}

export function HcSummary({ refs, runtime, withTotal = false }: HcSummaryProps): JSX.Element {
  const { unknown, parts } = projectSummary(refs, runtime);
  const total = `${refs.length} check${refs.length === 1 ? '' : 's'}`;
  const items: { key: string; node: ReactNode }[] = [];
  if (unknown) {
    if (withTotal) items.push({ key: 'total', node: total });
    items.push({ key: 'unknown', node: 'status unknown' });
  } else {
    for (const part of parts) {
      const text = `${part.n} ${part.label}`;
      const loud = part.status === 'down' || part.status === 'grace';
      items.push({ key: part.status, node: loud ? <b className={`hc-s-${part.status}`}>{text}</b> : text });
    }
    if (withTotal) items.push({ key: 'total', node: total });
  }
  return (
    <span className="hc-sum">
      {items.map((item, i) => (
        <Fragment key={item.key}>{i > 0 ? ' · ' : null}{item.node}</Fragment>
      ))}
    </span>
  );
}
```

`frontend/src/styles.css`:
- after `.chips.hb-dim { … }` (the heartbeat block), add:

```css
.field input.hc-invalid { border-color: var(--err); box-shadow: 0 0 0 3px var(--err-soft); }
.act-btn:disabled { cursor: progress; transform: none; }
```

- insert this block immediately **before** `/* ---------- Responsive ---------- */`:

```css
/* ---------- Healthchecks ---------- */
.hc-list { display: flex; flex-direction: column; gap: 10px; }
.hc-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 14px 16px; }
.hc-card-head { display: flex; align-items: center; gap: 12px; }
.hc-card-title { flex: 1; min-width: 0; }
.hc-card-title strong { display: block; font-size: 14.5px; font-weight: 700; letter-spacing: -.2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hc-card-actions { display: flex; align-items: center; gap: 8px; flex: none; }
.hc-ov-toggle { display: inline-flex; align-items: center; gap: 8px; margin-right: 4px; font-size: 12.5px; color: var(--text-2); cursor: pointer; }
.hc-chevron svg { transform: rotate(-90deg); transition: transform var(--transition); }
.hc-chevron.open svg { transform: none; }
.hc-sum { font-size: 12px; color: var(--text-2); }
.hc-sum b { font-weight: 650; }
.hc-sum .hc-s-down { color: var(--err); }
.hc-sum .hc-s-grace { color: var(--warn); }
.hc-facts { display: flex; flex-wrap: wrap; gap: 4px 18px; margin-top: 10px; font-size: 12px; color: var(--text-3); }
.hc-facts b { color: var(--text-2); font-weight: 600; }
.hc-facts .mono, .hc-table .mono { font-family: var(--mono); font-size: 12px; font-weight: 600; letter-spacing: -.3px; color: var(--text-2); }
.hc-banner { margin-top: 10px; padding: 7px 11px; border-radius: 8px; font-size: 12.5px; color: var(--text-2); background: var(--surface-2); border: 1px solid var(--border); }
.hc-banner.hc-banner-err { color: var(--err); background: var(--err-soft); border-color: transparent; }
.hc-inner { margin: 14px -16px -14px; padding: 0 16px 2px; border-top: 1px solid var(--border); background: var(--bg); border-radius: 0 0 var(--radius) var(--radius); overflow-x: auto; }
.hc-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.hc-table th { text-align: left; padding: 10px 8px; font-size: 11px; font-weight: 600; letter-spacing: .5px; text-transform: uppercase; color: var(--text-3); border-bottom: 1px solid var(--border); white-space: nowrap; }
.hc-table td { padding: 10px 8px; border-bottom: 1px solid var(--border); vertical-align: top; }
.hc-table tbody tr:last-child td { border-bottom: none; }
.hc-sub { display: block; font-size: 12px; color: var(--text-3); }
.hc-gone-row .hc-c-name { color: var(--text-3); }
.hc-c-ov { width: 1%; }
.hc-empty-row { text-align: center; color: var(--text-3); }
.hc-mob, .hc-short, .hc-period-sub { display: none; }
.hc-sr { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
/* status: pill (table), badge (overview), dot (narrow table) */
.hc-pill, .hc-badge { display: inline-flex; align-items: center; gap: 6px; border-radius: 999px; font-weight: 600; white-space: nowrap; border: 1px solid transparent; }
.hc-pill { padding: 2px 8px; font-size: 12px; color: var(--text-2); }
.hc-badge { padding: 4px 10px; font-size: 12.5px; color: var(--text); background: var(--surface-2); border-color: var(--border); }
.hc-pill i, .hc-badge i, .hc-dot { display: inline-block; flex: none; width: 7px; height: 7px; border-radius: 50%; background: var(--ok); }
.hc-grace i, .hc-dot.hc-grace { background: var(--warn); }
.hc-down i, .hc-dot.hc-down { background: var(--err); }
.hc-paused i, .hc-new i, .hc-dot.hc-paused, .hc-dot.hc-new { background: var(--text-3); }
.hc-gone i, .hc-unknown i, .hc-dot.hc-gone, .hc-dot.hc-unknown { background: transparent; border: 1px dashed var(--text-3); }
.hc-pill.hc-grace, .hc-badge.hc-grace { color: var(--warn); background: var(--warn-soft); border-color: transparent; }
.hc-pill.hc-down, .hc-badge.hc-down { color: var(--err); background: var(--err-soft); border-color: transparent; }
.hc-badge.hc-paused, .hc-badge.hc-new { color: var(--text-2); }
.hc-pill.hc-gone, .hc-pill.hc-unknown, .hc-badge.hc-gone, .hc-badge.hc-unknown { color: var(--text-3); background: transparent; border: 1px dashed var(--border-strong); }
/* overview panel */
.hc-row { display: grid; grid-template-columns: minmax(120px, 180px) 1fr; gap: 14px; align-items: start; padding: 12px 0; }
.hc-row + .hc-row { border-top: 1px solid var(--border); }
.hc-row:last-child { padding-bottom: 0; }
.hc-row-name strong { display: block; font-size: 13.5px; }
.hc-badges { display: flex; flex-wrap: wrap; gap: 6px; }
@media (max-width: 900px) {
  .hc-c-slug { display: none; }
}
@media (max-width: 620px) {
  .hc-c-status, .hc-c-period, .hc-long { display: none; }
  .hc-mob, .hc-short { display: inline; }
  .hc-period-sub { display: block; }
  .hc-mob .hc-dot { margin-right: 7px; vertical-align: 1px; }
  .hc-card-head { flex-wrap: wrap; }
  .hc-card-actions { width: 100%; }
  .hc-card-actions .hc-ov-toggle { margin-right: auto; }
  .hc-row { grid-template-columns: 1fr; gap: 8px; }
  .hc-row-name strong { display: inline; margin-right: 6px; }
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run src/components && npx tsc --noEmit -p tsconfig.app.json`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/icons.tsx frontend/src/components/IconButton.tsx frontend/src/components/IconButton.test.tsx frontend/src/components/HcSummary.tsx frontend/src/components/HcSummary.test.tsx frontend/src/styles.css
git commit -m "feat(healthchecks): heart-pulse icon, IconButton state props, hc-* styles, summary"
```

---

### Task 10: Overview panel

**Files:**
- Create: `frontend/src/components/HealthchecksPanel.tsx`
- Modify: `frontend/src/views/OverviewView.tsx`
- Test: `frontend/src/components/HealthchecksPanel.test.tsx` (new), `frontend/src/views/OverviewView.test.tsx` (update)

**Interfaces:**
- Consumes: `HcSummary` (Task 9); `checkDisplayStatus`, `DISPLAY_LABEL` and `ago` (Task 8).
- Produces:
  - `HealthchecksPanel({ projects: HealthchecksProject[], runtime: Record<string, ProjectRuntime> | undefined, nowMs: number }): JSX.Element | null`
  - `OverviewViewProps.projects: HealthchecksProject[]`

- [ ] **Step 1: Write the failing tests.** Create `frontend/src/components/HealthchecksPanel.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { CheckStatus, HealthchecksProject, ProjectRuntime } from '../types';
import { HealthchecksPanel } from './HealthchecksPanel';

const NOW_MS = new Date(2026, 8, 25, 12, 0, 0).getTime();
const st = (name: string, s: CheckStatus['status']): CheckStatus => ({
  name, slug: name, status: s, last_ping: NOW_MS / 1000 - 60, next_ping: null, timeout: 60, schedule: null, tz: null, grace: 60,
});
const project = (over: Partial<HealthchecksProject> = {}): HealthchecksProject => ({
  id: 'p1', name: 'Homelab', base_url: 'https://healthchecks.io/', api_key: '********', poll_interval: 300,
  show_on_overview: true, fetched_at: 1,
  checks: [
    { key: 'a', name: 'Backup', slug: 'backup', visible: true },
    { key: 'b', name: 'SSL', slug: 'ssl', visible: true },
    { key: 'c', name: 'Hidden', slug: 'hidden', visible: false },
    { key: 'd', name: 'Old job', slug: 'old', visible: true },
  ],
  ...over,
});
const runtime: Record<string, ProjectRuntime> = {
  p1: { polled_at: 1, ok: true, error: null, offline: false, checks: { a: st('Backup', 'up'), b: st('SSL', 'down'), c: st('Hidden', 'up') } },
};

describe('HealthchecksPanel', () => {
  it('renders one row per shown project with badges for visible checks only', () => {
    const { container } = render(<HealthchecksPanel projects={[project()]} runtime={runtime} nowMs={NOW_MS} />);
    expect(screen.getByRole('heading', { name: 'Healthchecks' })).toBeInTheDocument();
    const badges = container.querySelectorAll('.hc-badge');
    expect(badges).toHaveLength(3);
    expect(container.querySelector('.hc-badge.hc-down')).toHaveTextContent('SSL');
    expect(container.querySelector('.hc-badge.hc-gone')).toHaveTextContent('Old job');
    expect(screen.queryByText('Hidden')).toBeNull();
    expect(container.querySelector('.hc-row .hc-sum')?.textContent).toBe('1 up · 1 down · 1 gone');
  });

  it('renders every badge stateless after a failed or offline poll', () => {
    const failed = { p1: { ...runtime.p1, ok: false, error: 'HTTP 503' } };
    const { container } = render(<HealthchecksPanel projects={[project()]} runtime={failed} nowMs={NOW_MS} />);
    expect(container.querySelectorAll('.hc-badge.hc-unknown')).toHaveLength(3);
    expect(screen.getByText('status unknown')).toBeInTheDocument();
  });

  it('renders stateless badges when the snapshot has no healthchecks field', () => {
    const { container } = render(<HealthchecksPanel projects={[project()]} runtime={undefined} nowMs={NOW_MS} />);
    expect(container.querySelectorAll('.hc-badge.hc-unknown')).toHaveLength(3);
  });

  it('is omitted when no project has visible checks on the Overview', () => {
    const { container } = render(
      <HealthchecksPanel
        projects={[project({ show_on_overview: false }), project({ id: 'p2', checks: [] })]}
        runtime={runtime}
        nowMs={NOW_MS}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('prefers the live upstream name over the fetched one', () => {
    const renamed = { p1: { ...runtime.p1, checks: { ...runtime.p1.checks, a: st('Nightly backup', 'up') } } };
    render(<HealthchecksPanel projects={[project()]} runtime={renamed} nowMs={NOW_MS} />);
    expect(screen.getByText('Nightly backup')).toBeInTheDocument();
  });
});
```

In `frontend/src/views/OverviewView.test.tsx`, add `projects={[]}` to all three existing `<OverviewView … />` renders, and append:

```tsx
  it('renders the Healthchecks panel when a project has visible checks', () => {
    render(
      <OverviewView
        snapshot={snapshot}
        domains={[]}
        projects={[{
          id: 'p1', name: 'Homelab', base_url: 'https://healthchecks.io/', api_key: '********', poll_interval: 300,
          show_on_overview: true, fetched_at: 1, checks: [{ key: 'a', name: 'Backup', slug: 'backup', visible: true }],
        }]}
        settings={snapshot.settings ?? null}
        incidentWindow={null}
        dayBuckets={buckets}
        nowMs={NOW_MS}
        onSelectDay={vi.fn()}
        onPing={vi.fn()}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Healthchecks' })).toBeInTheDocument();
    expect(screen.getByText('Backup')).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run src/components/HealthchecksPanel.test.tsx src/views/OverviewView.test.tsx`
Expected: FAIL

- [ ] **Step 3: Implement** `frontend/src/components/HealthchecksPanel.tsx`

```tsx
import type { JSX } from 'react';
import type { HealthchecksProject, ProjectRuntime } from '../types';
import { DISPLAY_LABEL, ago, checkDisplayStatus } from '../utils';
import { HcSummary } from './HcSummary';

export interface HealthchecksPanelProps {
  projects: HealthchecksProject[];
  runtime: Record<string, ProjectRuntime> | undefined;
  nowMs: number;
}

export function HealthchecksPanel({ projects, runtime, nowMs }: HealthchecksPanelProps): JSX.Element | null {
  const rows = projects
    .filter((p) => p.show_on_overview)
    .map((p) => ({ project: p, refs: p.checks.filter((c) => c.visible) }))
    .filter((row) => row.refs.length > 0);
  if (rows.length === 0) return null;
  return (
    <div className="panel ov-wide hc-panel">
      <div className="panel-head">
        <h4>Healthchecks</h4>
        <span className="sub">{rows.length} {rows.length === 1 ? 'project' : 'projects'}</span>
      </div>
      {rows.map(({ project, refs }) => {
        const rt = runtime?.[project.id];
        return (
          <div className="hc-row" key={project.id}>
            <div className="hc-row-name">
              <strong>{project.name}</strong>
              <HcSummary refs={refs} runtime={rt} />
            </div>
            <div className="hc-badges">
              {refs.map((ref) => {
                const display = checkDisplayStatus(rt, ref.key);
                const live = rt?.checks[ref.key];
                return (
                  <span
                    key={ref.key}
                    className={`hc-badge hc-${display}`}
                    title={`${DISPLAY_LABEL[display]} · last ping ${ago(live?.last_ping ?? null, nowMs)}`}
                  >
                    <i aria-hidden="true" />
                    <span className="hc-sr">{DISPLAY_LABEL[display]}: </span>
                    {live?.name ?? ref.name}
                  </span>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
```

In `frontend/src/views/OverviewView.tsx`:
- import `HealthchecksProject` in the types import;
- import `{ HealthchecksPanel } from '../components/HealthchecksPanel'`;
- add `projects: HealthchecksProject[];` to `OverviewViewProps` and destructure it;
- render the panel as the last child of `.ov-grid`, right after the reachability `<div className="panel ov-wide">…</div>`:

```tsx
        <HealthchecksPanel projects={projects} runtime={snapshot?.healthchecks} nowMs={nowMs} />
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run src/components/HealthchecksPanel.test.tsx src/views/OverviewView.test.tsx`
Expected: PASS. `tsc` will fail until App passes `projects`; that happens in Task 13. Do not run tsc as a gate here.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/HealthchecksPanel.tsx frontend/src/components/HealthchecksPanel.test.tsx frontend/src/views/OverviewView.tsx frontend/src/views/OverviewView.test.tsx
git commit -m "feat(healthchecks): Overview panel with per-project badge rows"
```

---

### Task 11: ChecksTable and ProjectCard

**Files:**
- Create: `frontend/src/components/ChecksTable.tsx`, `frontend/src/components/ProjectCard.tsx`
- Test: `frontend/src/components/ChecksTable.test.tsx`, `frontend/src/components/ProjectCard.test.tsx`

**Interfaces:**
- Consumes: `IconButton` `expanded`/`disabled` and `HcSummary` (Task 9); the utils (Task 8).
- Produces:
  - `ChecksTable({ project, runtime, nowMs, onToggleCheck: (key: string, visible: boolean) => void })`
  - `ProjectCard({ project, runtime, nowMs, onToggleOverview: (next: boolean) => void, onToggleCheck, onFetch: () => Promise<void>, onEdit: () => void, onDelete: () => void })`

- [ ] **Step 1: Write the failing tests.** Create `frontend/src/components/ChecksTable.test.tsx`:

```tsx
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { CheckStatus, HealthchecksProject, ProjectRuntime } from '../types';
import { ChecksTable } from './ChecksTable';

const NOW_MS = new Date(2026, 8, 25, 12, 0, 0).getTime();
const NOW_S = NOW_MS / 1000;
const st = (over: Partial<CheckStatus>): CheckStatus => ({
  name: 'x', slug: 'x', status: 'up', last_ping: null, next_ping: null, timeout: 86400, schedule: null, tz: null, grace: 3600, ...over,
});
const project: HealthchecksProject = {
  id: 'p1', name: 'Homelab', base_url: 'https://healthchecks.io/', api_key: '********', poll_interval: 120,
  show_on_overview: true, fetched_at: NOW_S - 3 * 86400,
  checks: [
    { key: 'ssl', name: 'SSL (hydrogen)', slug: 'ssl-hydrogen', visible: true },
    { key: 'check', name: 'Check', slug: 'check', visible: false },
    { key: 'old', name: 'Old job', slug: 'old-job', visible: true },
  ],
};
const runtime: ProjectRuntime = {
  polled_at: NOW_S - 14, ok: true, error: null, offline: false,
  checks: {
    ssl: st({ name: 'SSL (hydrogen)', slug: 'ssl-hydrogen', status: 'down', last_ping: NOW_S - 130 * 86400, grace: 93600 }),
    check: st({ name: 'Check', slug: 'check', timeout: null, schedule: '*-*-1 04:30:00', tz: 'UTC', grace: 10800, last_ping: NOW_S - 3 * 604800 }),
  },
};

describe('ChecksTable', () => {
  it('renders a row per fetched check with status, slug, period and last ping', () => {
    render(<ChecksTable project={project} runtime={runtime} nowMs={NOW_MS} onToggleCheck={vi.fn()} />);
    const rows = screen.getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);
    const ssl = within(rows[0]);
    expect(ssl.getByText('down', { selector: '.hc-pill' })).toHaveClass('hc-down');
    expect(ssl.getByText('ssl-hydrogen')).toBeInTheDocument();
    expect(ssl.getByText('1 day')).toBeInTheDocument();
    expect(ssl.getByText('1 day 2 hours')).toBeInTheDocument();
    expect(ssl.getByText('4 months ago')).toBeInTheDocument();
    expect(ssl.getByText('4mo ago')).toBeInTheDocument();
    const cron = within(rows[1]);
    expect(cron.getAllByText('*-*-1 04:30:00')[0]).toHaveClass('mono');
    expect(cron.getByText('3 weeks ago')).toBeInTheDocument();
  });

  it('marks a check missing from the last poll as gone', () => {
    render(<ChecksTable project={project} runtime={runtime} nowMs={NOW_MS} onToggleCheck={vi.fn()} />);
    const gone = screen.getAllByRole('row')[3];
    expect(gone).toHaveClass('hc-gone-row');
    expect(within(gone).getByText('Not in last poll — Fetch to remove')).toBeInTheDocument();
    expect(within(gone).getByText('gone', { selector: '.hc-pill' })).toHaveClass('hc-gone');
  });

  it('shows unknown but keeps the last good values after a failed poll', () => {
    render(<ChecksTable project={project} runtime={{ ...runtime, ok: false, error: 'HTTP 503' }} nowMs={NOW_MS} onToggleCheck={vi.fn()} />);
    const ssl = within(screen.getAllByRole('row')[1]);
    expect(ssl.getByText('unknown', { selector: '.hc-pill' })).toHaveClass('hc-unknown');
    expect(ssl.getByText('4 months ago')).toBeInTheDocument();
  });

  it('toggles a check on the Overview', () => {
    const onToggleCheck = vi.fn();
    render(<ChecksTable project={project} runtime={runtime} nowMs={NOW_MS} onToggleCheck={onToggleCheck} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Show Check on Overview' }));
    expect(onToggleCheck).toHaveBeenCalledWith('check', true);
  });

  it('renders a placeholder row for an empty project', () => {
    render(<ChecksTable project={{ ...project, checks: [] }} runtime={runtime} nowMs={NOW_MS} onToggleCheck={vi.fn()} />);
    expect(screen.getByText('No checks in this project.')).toBeInTheDocument();
  });
});
```

Create `frontend/src/components/ProjectCard.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { HealthchecksProject, ProjectRuntime } from '../types';
import { ProjectCard } from './ProjectCard';

const NOW_MS = new Date(2026, 8, 25, 12, 0, 0).getTime();
const NOW_S = NOW_MS / 1000;
const project: HealthchecksProject = {
  id: 'p1', name: 'Homelab', base_url: 'https://hc.example.lan/', api_key: '********', poll_interval: 120,
  show_on_overview: true, fetched_at: NOW_S - 3 * 86400,
  checks: [{ key: 'a', name: 'Backup', slug: 'backup', visible: true }],
};
const ok: ProjectRuntime = {
  polled_at: NOW_S - 14, ok: true, error: null, offline: false,
  checks: { a: { name: 'Backup', slug: 'backup', status: 'up', last_ping: null, next_ping: null, timeout: 60, schedule: null, tz: null, grace: 60 } },
};
const handlers = () => ({
  onToggleOverview: vi.fn(), onToggleCheck: vi.fn(), onFetch: vi.fn(async () => undefined), onEdit: vi.fn(), onDelete: vi.fn(),
});

describe('ProjectCard', () => {
  it('shows the summary and facts, collapsed by default', () => {
    render(<ProjectCard project={project} runtime={ok} nowMs={NOW_MS} {...handlers()} />);
    expect(screen.getByText('Homelab')).toBeInTheDocument();
    expect(screen.getByText('1 up · 1 check', { exact: false })).toBeInTheDocument();
    expect(screen.getByText('hc.example.lan')).toBeInTheDocument();
    expect(screen.getByText('2 min')).toBeInTheDocument();
    expect(screen.getByText('14s ago')).toBeInTheDocument();
    expect(screen.getByText('3d ago')).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('expands into the checks table', () => {
    render(<ProjectCard project={project} runtime={ok} nowMs={NOW_MS} {...handlers()} />);
    const chevron = screen.getByRole('button', { name: 'Expand Homelab' });
    expect(chevron).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(chevron);
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Collapse Homelab' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('wires the Overview switch, edit and delete', () => {
    const h = handlers();
    render(<ProjectCard project={project} runtime={ok} nowMs={NOW_MS} {...h} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Show on Overview' }));
    expect(h.onToggleOverview).toHaveBeenCalledWith(false);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(h.onEdit).toHaveBeenCalledOnce();
    expect(h.onDelete).toHaveBeenCalledOnce();
  });

  it('spins the fetch button until the fetch settles', async () => {
    let settle: () => void = () => undefined;
    const h = { ...handlers(), onFetch: vi.fn(() => new Promise<void>((resolve) => { settle = resolve; })) };
    render(<ProjectCard project={project} runtime={ok} nowMs={NOW_MS} {...h} />);
    const button = screen.getByRole('button', { name: 'Fetch checks' });
    fireEvent.click(button);
    expect(h.onFetch).toHaveBeenCalledOnce();
    expect(button).toBeDisabled();
    expect(button).toHaveClass('spin');
    settle();
    await waitFor(() => expect(button).not.toBeDisabled());
  });

  it('shows the failed-poll banner', () => {
    render(<ProjectCard project={project} runtime={{ ...ok, ok: false, error: '401 Unauthorized — API key invalid or revoked' }} nowMs={NOW_MS} {...handlers()} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Last poll failed: 401 Unauthorized — API key invalid or revoked');
    expect(screen.getByText('1 check · status unknown')).toBeInTheDocument();
  });

  it('shows the offline banner instead of a stale error', () => {
    render(<ProjectCard project={project} runtime={{ ...ok, ok: false, error: 'HTTP 503', offline: true }} nowMs={NOW_MS} {...handlers()} />);
    expect(screen.getByText('System is offline — polling paused.')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run src/components/ChecksTable.test.tsx src/components/ProjectCard.test.tsx`
Expected: FAIL (the modules don't exist)

- [ ] **Step 3: Implement.** Create `frontend/src/components/ChecksTable.tsx`:

```tsx
import type { JSX } from 'react';
import type { CheckStatus, HealthchecksProject, ProjectRuntime } from '../types';
import { DISPLAY_LABEL, ago, checkDisplayStatus, humanDuration } from '../utils';

export interface ChecksTableProps {
  project: HealthchecksProject;
  runtime: ProjectRuntime | undefined;
  nowMs: number;
  onToggleCheck: (key: string, visible: boolean) => void;
}

function Period({ live }: { live: CheckStatus }): JSX.Element {
  if (live.schedule) {
    return <><span className="mono">{live.schedule}</span>{live.tz ? ` ${live.tz}` : null}</>;
  }
  return <>{humanDuration(live.timeout ?? 0)}</>;
}

export function ChecksTable({ project, runtime, nowMs, onToggleCheck }: ChecksTableProps): JSX.Element {
  return (
    <table className="hc-table">
      <thead>
        <tr>
          <th className="hc-c-status">Status</th>
          <th>Name</th>
          <th className="hc-c-slug">Slug</th>
          <th className="hc-c-period">Period / Grace</th>
          <th>Last ping</th>
          <th className="hc-c-ov">Overview</th>
        </tr>
      </thead>
      <tbody>
        {project.checks.length === 0 ? (
          <tr><td colSpan={6} className="hc-empty-row">No checks in this project.</td></tr>
        ) : project.checks.map((ref) => {
          const display = checkDisplayStatus(runtime, ref.key);
          const live = runtime?.checks[ref.key];
          const name = live?.name ?? ref.name;
          const label = DISPLAY_LABEL[display];
          const lastPing = live?.last_ping ?? null;
          return (
            <tr key={ref.key} className={display === 'gone' ? 'hc-gone-row' : undefined}>
              <td className="hc-c-status">
                <span className={`hc-pill hc-${display}`}><i aria-hidden="true" />{label}</span>
              </td>
              <td className="hc-c-name">
                <span className="hc-mob">
                  <i className={`hc-dot hc-${display}`} aria-hidden="true" />
                  <span className="hc-sr">{label}: </span>
                </span>
                {name}
                {display === 'gone' ? <span className="hc-sub">Not in last poll — Fetch to remove</span> : null}
                {live ? (
                  <span className="hc-sub hc-period-sub"><Period live={live} /> · grace {humanDuration(live.grace)}</span>
                ) : null}
              </td>
              <td className="hc-c-slug mono">{live?.slug ?? ref.slug}</td>
              <td className="hc-c-period">
                {live ? <><Period live={live} /><span className="hc-sub">{humanDuration(live.grace)}</span></> : '—'}
              </td>
              <td title={lastPing !== null ? new Date(lastPing * 1000).toLocaleString() : undefined}>
                <span className="hc-long">{ago(lastPing, nowMs)}</span>
                <span className="hc-short">{ago(lastPing, nowMs, true)}</span>
              </td>
              <td className="hc-c-ov">
                <label className="switch">
                  <input
                    type="checkbox"
                    aria-label={`Show ${name} on Overview`}
                    checked={ref.visible}
                    onChange={() => onToggleCheck(ref.key, !ref.visible)}
                  />
                  <span className="slider" />
                </label>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
```

> Testing Library matches an element's *own* text nodes. The Period cell's own text is exactly `1 day`, while the mobile sub-line's is `1 day · grace 1 day 2 hours`, so `getByText('1 day')` finds exactly one element.

Create `frontend/src/components/ProjectCard.tsx`:

```tsx
import { useState, type JSX } from 'react';
import type { HealthchecksProject, ProjectRuntime } from '../types';
import { ago, formatInterval, hostOf } from '../utils';
import { ChecksTable } from './ChecksTable';
import { HcSummary } from './HcSummary';
import { IconButton } from './IconButton';
import { IconChevronDown, IconEdit, IconRefresh, IconTrash } from './icons';

export interface ProjectCardProps {
  project: HealthchecksProject;
  runtime: ProjectRuntime | undefined;
  nowMs: number;
  onToggleOverview: (next: boolean) => void;
  onToggleCheck: (key: string, visible: boolean) => void;
  onFetch: () => Promise<void>;
  onEdit: () => void;
  onDelete: () => void;
}

export function ProjectCard(props: ProjectCardProps): JSX.Element {
  const { project, runtime, nowMs, onToggleOverview, onToggleCheck, onFetch, onEdit, onDelete } = props;
  const [open, setOpen] = useState(false);
  const [fetching, setFetching] = useState(false);

  const runFetch = async () => {
    if (fetching) return;
    setFetching(true);
    try {
      await onFetch();
    } finally {
      setFetching(false);
    }
  };

  let banner: JSX.Element | null = null;
  if (runtime?.offline) {
    banner = <div className="hc-banner">System is offline — polling paused.</div>;
  } else if (runtime && !runtime.ok && runtime.error) {
    banner = <div className="hc-banner hc-banner-err" role="alert">Last poll failed: {runtime.error}</div>;
  }

  return (
    <div className="hc-card">
      <div className="hc-card-head">
        <IconButton
          label={`${open ? 'Collapse' : 'Expand'} ${project.name}`}
          variant="act"
          expanded={open}
          className={`hc-chevron${open ? ' open' : ''}`}
          onClick={() => setOpen((v) => !v)}
        >
          <IconChevronDown />
        </IconButton>
        <div className="hc-card-title">
          <strong>{project.name}</strong>
          <HcSummary refs={project.checks} runtime={runtime} withTotal />
        </div>
        <div className="hc-card-actions">
          <label className="hc-ov-toggle">
            <span className="switch">
              <input
                type="checkbox"
                checked={project.show_on_overview}
                onChange={() => onToggleOverview(!project.show_on_overview)}
              />
              <span className="slider" />
            </span>
            Show on Overview
          </label>
          <IconButton
            label="Fetch checks"
            variant="act"
            disabled={fetching}
            className={fetching ? 'spin' : undefined}
            onClick={() => { void runFetch(); }}
          >
            <IconRefresh />
          </IconButton>
          <IconButton label="Edit" variant="act" onClick={onEdit}><IconEdit /></IconButton>
          <IconButton label="Delete" variant="act" danger onClick={onDelete}><IconTrash /></IconButton>
        </div>
      </div>
      <div className="hc-facts">
        <span className="mono">{hostOf(project.base_url)}</span>
        <span>Poll every <b>{formatInterval(project.poll_interval)}</b></span>
        <span>Last poll <b>{ago(runtime?.polled_at ?? null, nowMs, true)}</b></span>
        <span>Fetched <b>{ago(project.fetched_at, nowMs, true)}</b></span>
      </div>
      {banner}
      {open ? (
        <div className="hc-inner">
          <ChecksTable project={project} runtime={runtime} nowMs={nowMs} onToggleCheck={onToggleCheck} />
        </div>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run src/components/ChecksTable.test.tsx src/components/ProjectCard.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/ChecksTable.tsx frontend/src/components/ChecksTable.test.tsx frontend/src/components/ProjectCard.tsx frontend/src/components/ProjectCard.test.tsx
git commit -m "feat(healthchecks): accordion project card and checks table"
```

---

### Task 12: ProjectModal

**Files:**
- Create: `frontend/src/components/ProjectModal.tsx`
- Test: `frontend/src/components/ProjectModal.test.tsx`

**Interfaces:**
- Consumes: `Modal`, and `ApiError` from `../api`.
- Produces:
  - `interface ProjectFormValue { name: string; base_url: string; api_key: string; poll_interval: number }`
  - `ProjectModal({ open, editing: HealthchecksProject | null, onClose, onSave: (v: ProjectFormValue) => Promise<void> })`. `onSave` **rejects** on failure, and the modal renders the errors inline.

- [ ] **Step 1: Write the failing tests** in `frontend/src/components/ProjectModal.test.tsx`

```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api';
import type { HealthchecksProject } from '../types';
import { ProjectModal } from './ProjectModal';

const editing: HealthchecksProject = {
  id: 'p1', name: 'Homelab', base_url: 'https://hc.example.lan/', api_key: '********', poll_interval: 900,
  show_on_overview: true, fetched_at: 1, checks: [],
};

describe('ProjectModal', () => {
  it('adds with healthchecks.io and a 5-minute poll by default', async () => {
    const onSave = vi.fn(async () => undefined);
    render(<ProjectModal open editing={null} onClose={vi.fn()} onSave={onSave} />);
    expect(screen.getByRole('heading', { name: 'Add project' })).toBeInTheDocument();
    expect(screen.getByLabelText(/Base URL/)).toHaveValue('https://healthchecks.io');
    expect(screen.getByRole('button', { name: '5 min' })).toHaveClass('active');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Homelab' } });
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'ro-key' } });
    fireEvent.click(screen.getByRole('button', { name: '2 min' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add & fetch' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({
      name: 'Homelab', base_url: 'https://healthchecks.io', api_key: 'ro-key', poll_interval: 120,
    }));
  });

  it('shows upstream errors inline on their field', async () => {
    const error = new ApiError('/api/healthchecks -> 422', 422, { api_key: '401 Unauthorized — API key invalid or revoked' });
    render(<ProjectModal open editing={null} onClose={vi.fn()} onSave={vi.fn(async () => { throw error; })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add & fetch' }));
    expect(await screen.findByText('401 Unauthorized — API key invalid or revoked')).toBeInTheDocument();
    expect(screen.getByLabelText('API key')).toHaveAttribute('aria-invalid', 'true');
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'x' } });
    expect(screen.getByLabelText('API key')).not.toHaveAttribute('aria-invalid');
  });

  it('shows a generic error when the failure has no field', async () => {
    render(<ProjectModal open editing={null} onClose={vi.fn()} onSave={vi.fn(async () => { throw new Error('boom'); })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add & fetch' }));
    expect(await screen.findByText('Failed to save project')).toBeInTheDocument();
  });

  it('edits with the stored values and an unchanged key', async () => {
    const onSave = vi.fn(async () => undefined);
    render(<ProjectModal open editing={editing} onClose={vi.fn()} onSave={onSave} />);
    expect(screen.getByRole('heading', { name: 'Edit project' })).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveValue('Homelab');
    expect(screen.getByLabelText('API key')).toHaveValue('');
    expect(screen.getByLabelText('API key')).toHaveAttribute('placeholder', 'unchanged');
    expect(screen.getByRole('button', { name: '15 min' })).toHaveClass('active');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({
      name: 'Homelab', base_url: 'https://hc.example.lan/', api_key: '', poll_interval: 900,
    }));
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run src/components/ProjectModal.test.tsx`
Expected: FAIL (the module doesn't exist)

- [ ] **Step 3: Implement** `frontend/src/components/ProjectModal.tsx`

```tsx
import { useEffect, useState, type JSX, type ReactNode } from 'react';
import { ApiError } from '../api';
import type { HealthchecksProject } from '../types';
import { Modal } from './Modal';

export interface ProjectFormValue {
  name: string;
  base_url: string;
  api_key: string;
  poll_interval: number;
}

export interface ProjectModalProps {
  open: boolean;
  editing: HealthchecksProject | null;
  onClose: () => void;
  onSave: (value: ProjectFormValue) => Promise<void>;
}

const POLL_INTERVALS = [
  { value: 60, label: '1 min' },
  { value: 120, label: '2 min' },
  { value: 300, label: '5 min' },
  { value: 900, label: '15 min' },
  { value: 3600, label: '1 hr' },
];

const EMPTY: ProjectFormValue = { name: '', base_url: 'https://healthchecks.io', api_key: '', poll_interval: 300 };

export function ProjectModal({ open, editing, onClose, onSave }: ProjectModalProps): JSX.Element {
  const [form, setForm] = useState<ProjectFormValue>(EMPTY);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setForm(editing
      ? { name: editing.name, base_url: editing.base_url, api_key: '', poll_interval: editing.poll_interval }
      : EMPTY);
    setErrors({});
    setFormError(null);
  }, [editing, open]);

  const update = (patch: Partial<ProjectFormValue>) => {
    setForm((f) => ({ ...f, ...patch }));
    setErrors((e) => {
      const next = { ...e };
      for (const key of Object.keys(patch)) delete next[key];
      return next;
    });
    setFormError(null);
  };

  const submit = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await onSave(form);
    } catch (err) {
      const fields = err instanceof ApiError ? err.fieldErrors : {};
      setErrors(fields);
      setFormError(Object.keys(fields).length === 0 ? 'Failed to save project' : null);
    } finally {
      setSaving(false);
    }
  };

  const help = (key: string, fallback?: ReactNode) => (
    <div id={`hc-${key}-help`} className={`field-help${errors[key] ? ' hb-error' : ''}`}>
      {errors[key] ?? fallback}
    </div>
  );
  const invalid = (key: string) => ({
    className: errors[key] ? 'hc-invalid' : undefined,
    'aria-invalid': errors[key] ? true : undefined,
    'aria-describedby': `hc-${key}-help`,
  });

  return (
    <Modal
      open={open}
      title={editing ? 'Edit project' : 'Add project'}
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={saving} onClick={() => { void submit(); }}>
            {editing ? 'Save' : 'Add & fetch'}
          </button>
        </>
      )}
    >
      <div className="field">
        <label htmlFor="hcName">Name</label>
        <input
          id="hcName" type="text" autoComplete="off" placeholder="Homelab" value={form.name}
          {...invalid('name')} onChange={(e) => update({ name: e.target.value })}
        />
        {help('name', 'Shown on the Healthchecks view and the Overview.')}
      </div>
      <div className="field">
        <label htmlFor="hcUrl">Base URL <span className="hint">— change for a self-hosted instance</span></label>
        <input
          id="hcUrl" type="text" autoComplete="off" spellCheck={false} value={form.base_url}
          {...invalid('base_url')} onChange={(e) => update({ base_url: e.target.value })}
        />
        {help('base_url')}
      </div>
      <div className="field">
        <label htmlFor="hcKey">API key</label>
        <input
          id="hcKey" type="password" autoComplete="off" placeholder={editing ? 'unchanged' : ''} value={form.api_key}
          {...invalid('api_key')} onChange={(e) => update({ api_key: e.target.value })}
        />
        {help('api_key', <>Use a <strong>read-only</strong> API key (Healthchecks → Project Settings → API Access).</>)}
      </div>
      <div>
        <div className="sr-text" style={{ marginBottom: 10 }}>
          <span className="t">Poll interval</span>
          <span className="d">How often to refresh check status while online.</span>
        </div>
        <div className="chips" role="group" aria-label="Poll interval">
          {POLL_INTERVALS.map(({ value, label }) => (
            <button
              type="button"
              key={value}
              className={`chip${form.poll_interval === value ? ' active' : ''}`}
              onClick={() => update({ poll_interval: value })}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {formError ? <div className="field-help hb-error" role="alert">{formError}</div> : null}
    </Modal>
  );
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run src/components/ProjectModal.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/ProjectModal.tsx frontend/src/components/ProjectModal.test.tsx
git commit -m "feat(healthchecks): add/edit project modal with inline upstream errors"
```

---

### Task 13: HealthchecksView, Rail and App wiring

**Files:**
- Create: `frontend/src/views/HealthchecksView.tsx`
- Modify: `frontend/src/layout/Rail.tsx`, `frontend/src/App.tsx`
- Test:
  - `frontend/src/views/HealthchecksView.test.tsx` (new)
  - `frontend/src/layout/Rail.test.tsx` (update)
  - `frontend/src/App.runhook.test.tsx` (update the mock)

**Interfaces:**
- Consumes: `ProjectCard` (Task 11), `ProjectModal` / `ProjectFormValue` (Task 12), `HealthchecksPanel` via `OverviewView.projects` (Task 10), and the Task 7 api calls.
- Produces:
  - `ViewKey` includes `'healthchecks'`
  - `RailProps.healthchecksCount: number`
  - `HealthchecksView(props)`

- [ ] **Step 1: Write the failing tests.** Create `frontend/src/views/HealthchecksView.test.tsx`:

```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { HealthchecksProject } from '../types';
import { HealthchecksView } from './HealthchecksView';

const NOW_MS = new Date(2026, 8, 25, 12, 0, 0).getTime();
const project: HealthchecksProject = {
  id: 'p1', name: 'Homelab', base_url: 'https://healthchecks.io/', api_key: '********', poll_interval: 300,
  show_on_overview: true, fetched_at: null, checks: [{ key: 'a', name: 'Backup', slug: 'backup', visible: true }],
};
const props = () => ({
  runtime: undefined, nowMs: NOW_MS, onAdd: vi.fn(), onEdit: vi.fn(), onDelete: vi.fn(),
  onFetch: vi.fn(async () => undefined), onToggleOverview: vi.fn(), onToggleCheck: vi.fn(),
});

describe('HealthchecksView', () => {
  it('shows an empty state and an Add project button', () => {
    const p = props();
    render(<HealthchecksView projects={[]} {...p} />);
    expect(screen.getByText('No projects yet')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add project' }));
    expect(p.onAdd).toHaveBeenCalledOnce();
  });

  it('lists projects and routes card actions with the project id', async () => {
    const p = props();
    render(<HealthchecksView projects={[project]} {...p} />);
    expect(screen.getByText('1 project')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(p.onEdit).toHaveBeenCalledWith(project);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(p.onDelete).toHaveBeenCalledWith('p1');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Show on Overview' }));
    expect(p.onToggleOverview).toHaveBeenCalledWith('p1', false);
    fireEvent.click(screen.getByRole('button', { name: 'Fetch checks' }));
    expect(p.onFetch).toHaveBeenCalledWith('p1');
    fireEvent.click(screen.getByRole('button', { name: 'Expand Homelab' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Show Backup on Overview' }));
    expect(p.onToggleCheck).toHaveBeenCalledWith('p1', 'a', false);
  });
});
```

In `frontend/src/layout/Rail.test.tsx`, add `healthchecksCount: 4,` to `base`, and append:

```tsx
  it('renders the Healthchecks nav item with its project count', () => {
    const onSelect = vi.fn();
    render(<Rail {...base} onSelect={onSelect} />);
    const item = screen.getByRole('button', { name: /Healthchecks/ });
    expect(item).toHaveTextContent('4');
    fireEvent.click(item);
    expect(onSelect).toHaveBeenCalledWith('healthchecks');
  });
```

In `frontend/src/App.runhook.test.tsx`, add inside `beforeEach`:

```tsx
    vi.mocked(api.getHealthchecks).mockResolvedValue([] as never);
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run src/views/HealthchecksView.test.tsx src/layout/Rail.test.tsx`
Expected: FAIL

- [ ] **Step 3: Implement.** Create `frontend/src/views/HealthchecksView.tsx`:

```tsx
import type { JSX } from 'react';
import type { HealthchecksProject, ProjectRuntime } from '../types';
import { EmptyState } from '../components/EmptyState';
import { ProjectCard } from '../components/ProjectCard';
import { SectionHeader } from '../components/SectionHeader';
import { IconHeartPulse, IconPlus } from '../components/icons';

export interface HealthchecksViewProps {
  projects: HealthchecksProject[];
  runtime: Record<string, ProjectRuntime> | undefined;
  nowMs: number;
  onAdd: () => void;
  onEdit: (project: HealthchecksProject) => void;
  onDelete: (id: string) => void;
  onFetch: (id: string) => Promise<void>;
  onToggleOverview: (id: string, next: boolean) => void;
  onToggleCheck: (id: string, key: string, visible: boolean) => void;
}

export function HealthchecksView(props: HealthchecksViewProps): JSX.Element {
  const { projects, runtime, nowMs, onAdd, onEdit, onDelete, onFetch, onToggleOverview, onToggleCheck } = props;
  const header = (
    <SectionHeader
      title="Healthchecks"
      count={{ n: projects.length, noun: 'project' }}
      action={(
        <button type="button" className="btn btn-primary" onClick={onAdd}>
          <IconPlus strokeWidth={2.5} />
          Add project
        </button>
      )}
    />
  );
  if (projects.length === 0) {
    return (
      <>
        {header}
        <EmptyState icon={<IconHeartPulse strokeWidth={1.5} />} title="No projects yet">
          Add a healthchecks.io project with a read-only API key.
        </EmptyState>
      </>
    );
  }
  return (
    <>
      {header}
      <div className="hc-list">
        {projects.map((p) => (
          <ProjectCard
            key={p.id}
            project={p}
            runtime={runtime?.[p.id]}
            nowMs={nowMs}
            onToggleOverview={(next) => onToggleOverview(p.id, next)}
            onToggleCheck={(key, visible) => onToggleCheck(p.id, key, visible)}
            onFetch={() => onFetch(p.id)}
            onEdit={() => onEdit(p)}
            onDelete={() => onDelete(p.id)}
          />
        ))}
      </div>
    </>
  );
}
```

`frontend/src/layout/Rail.tsx`:
- import `IconHeartPulse`;
- `export type ViewKey = 'overview' | 'domains' | 'hooks' | 'healthchecks' | 'logs' | 'settings' | 'about';`
- add `healthchecksCount: number;` to `RailProps` and destructure it;
- insert after the hooks item:

```tsx
    { key: 'healthchecks', label: 'Healthchecks', count: healthchecksCount, icon: <IconHeartPulse /> },
```

`frontend/src/App.tsx`. These edits are all additive:

1. Imports: add `HealthchecksProject` to the type import, plus:

```tsx
import { HealthchecksView } from './views/HealthchecksView';
import { ProjectModal, type ProjectFormValue } from './components/ProjectModal';
```

2. `TITLES`: add `healthchecks: { title: 'Healthchecks', sub: 'Check status from healthchecks.io projects' },` after `hooks`.
3. State, next to `hooks`:

```tsx
  const [projects, setProjects] = useState<HealthchecksProject[]>([]);
  const [projectModalOpen, setProjectModalOpen] = useState(false);
  const [editingProject, setEditingProject] = useState<HealthchecksProject | null>(null);
```

4. `const anyModalOpen = domainModalOpen || hookModalOpen || projectModalOpen || selectedDay !== null;`
5. In `loadConfig`:

```tsx
      const [d, h, s, p] = await Promise.all([
        api.getDomains(), api.getHooksConfig(), api.getSettings(), api.getHealthchecks(),
      ]);
      setDomains(d);
      setHooks(h);
      setSettings(s);
      setProjects(p);
```

6. Handlers, after `handleSaveSettings`:

```tsx
  // Rejects on failure so ProjectModal can render the field errors inline.
  const handleSaveProject = useCallback(
    async (value: ProjectFormValue) => {
      if (editingProject) await api.updateHealthchecks(editingProject.id, value);
      else await api.createHealthchecks(value);
      pushToast(`Saved ${value.name}`, 'success');
      setProjectModalOpen(false);
      setEditingProject(null);
      await loadConfig();
    },
    [editingProject, loadConfig, pushToast],
  );

  const handleFetchProject = useCallback(
    async (id: string) => {
      try {
        await api.fetchHealthchecks(id);
        pushToast('Checks fetched', 'success');
        await loadConfig();
      } catch (err) {
        const detail = err instanceof api.ApiError ? err.detail : undefined;
        pushToast(detail ? `Fetch failed: ${detail}` : 'Fetch failed', 'error');
      }
    },
    [loadConfig, pushToast],
  );

  const handleDeleteProject = useCallback(
    async (id: string) => {
      const p = projects.find((x) => x.id === id);
      if (p && !window.confirm(`Remove "${p.name}"?`)) return;
      try {
        await api.deleteHealthchecks(id);
        pushToast('Project removed', 'info');
        await loadConfig();
      } catch {
        pushToast('Failed to remove project', 'error');
      }
    },
    [projects, loadConfig, pushToast],
  );

  const handleToggleProjectOverview = useCallback(
    async (id: string, next: boolean) => {
      try {
        await api.updateHealthchecks(id, { show_on_overview: next });
        await loadConfig();
      } catch {
        pushToast('Failed to update project', 'error');
      }
    },
    [loadConfig, pushToast],
  );

  const handleToggleCheck = useCallback(
    async (id: string, key: string, visible: boolean) => {
      try {
        await api.setCheckVisible(id, key, visible);
        await loadConfig();
      } catch {
        pushToast('Failed to update check', 'error');
      }
    },
    [loadConfig, pushToast],
  );
```

7. `<Rail … healthchecksCount={projects.length} … />`.
8. `<OverviewView … projects={projects} … />`.
9. View block, after the `hooks` block:

```tsx
            {activeView === 'healthchecks' && (
              <HealthchecksView
                projects={projects}
                runtime={snapshot?.healthchecks}
                nowMs={nowMs}
                onAdd={() => {
                  setEditingProject(null);
                  setProjectModalOpen(true);
                }}
                onEdit={(project) => {
                  setEditingProject(project);
                  setProjectModalOpen(true);
                }}
                onDelete={handleDeleteProject}
                onFetch={handleFetchProject}
                onToggleOverview={handleToggleProjectOverview}
                onToggleCheck={handleToggleCheck}
              />
            )}
```

10. Sibling of `.shell`, after `<HookModal … />`. It MUST stay outside `.shell`:

```tsx
      <ProjectModal
        open={projectModalOpen}
        editing={editingProject}
        onClose={() => {
          setProjectModalOpen(false);
          setEditingProject(null);
        }}
        onSave={handleSaveProject}
      />
```

- [ ] **Step 4: Run the full frontend gate**

Run (from `frontend/`): `npm test && npx tsc --noEmit -p tsconfig.app.json`
Expected: every Vitest suite passes, including App.test / App.runhook.test / App.interval.test; oxlint is clean; tsc reports no errors; coverage thresholds are met.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/views/HealthchecksView.tsx frontend/src/views/HealthchecksView.test.tsx frontend/src/layout/Rail.tsx frontend/src/layout/Rail.test.tsx frontend/src/App.tsx frontend/src/App.runhook.test.tsx
git commit -m "feat(healthchecks): Healthchecks view, rail entry and app wiring"
```

---

### Task 14: End-to-end tests and README

**Files:**
- Create: `frontend/e2e/healthchecks.spec.ts`
- Modify: `frontend/e2e/dashboard.spec.ts` (nav list), `README.md`

**Interfaces:**
- Consumes: everything above. The e2e run uses the real backend (on port 8123, with a temp home). `page.route` stubs `GET/POST /api/healthchecks`, and `page.routeWebSocket` injects `healthchecks` into every `state` frame.

- [ ] **Step 1: Write the e2e tests** in `frontend/e2e/healthchecks.spec.ts`

```ts
import { test, expect, type Page } from '@playwright/test';

const NOW_S = Date.now() / 1000;
const PROJECT = {
  id: 'p1', name: 'Homelab', base_url: 'https://healthchecks.io/', api_key: '********',
  poll_interval: 120, show_on_overview: true, fetched_at: NOW_S - 3 * 86400,
  checks: [
    { key: 'k-ssl', name: 'SSL (hydrogen)', slug: 'ssl-hydrogen', visible: true },
    { key: 'k-backup', name: 'Backup', slug: 'backup', visible: true },
    { key: 'k-old', name: 'Old job', slug: 'old-job', visible: true },
  ],
};
const check = (name: string, slug: string, status: string, secondsAgo: number) => ({
  name, slug, status, last_ping: NOW_S - secondsAgo, next_ping: null,
  timeout: 86400, schedule: null, tz: null, grace: 3600,
});
const RUNTIME = {
  p1: {
    polled_at: NOW_S - 14, ok: true, error: null, offline: false,
    checks: {
      'k-ssl': check('SSL (hydrogen)', 'ssl-hydrogen', 'down', 130 * 86400),
      'k-backup': check('Backup', 'backup', 'up', 11 * 3600),
    },
  },
};

// The real backend has no projects and cannot reach healthchecks.io, so config comes
// from a REST stub and live status is spliced into every real ws `state` frame.
async function stubHealthchecks(page: Page): Promise<void> {
  await page.route('**/api/healthchecks', async (route) => {
    if (route.request().method() === 'GET') await route.fulfill({ json: [PROJECT] });
    else await route.fallback();
  });
  await page.routeWebSocket('**/api/ws', (ws) => {
    const server = ws.connectToServer();
    server.onMessage((message) => {
      const frame = JSON.parse(String(message)) as { kind: string; payload: Record<string, unknown> };
      if (frame.kind === 'state') frame.payload.healthchecks = RUNTIME;
      ws.send(JSON.stringify(frame));
    });
  });
}

async function openHealthchecks(page: Page): Promise<void> {
  await page.getByRole('button', { name: /Healthchecks/ }).click();
  await expect(page.getByRole('heading', { name: 'Healthchecks', level: 2 })).toBeVisible();
}

test('a project card expands into its checks table without a trailing divider', async ({ page }) => {
  await stubHealthchecks(page);
  await page.goto('/');
  await openHealthchecks(page);
  const card = page.locator('.hc-card').filter({ hasText: 'Homelab' });
  await expect(card.locator('.hc-sum')).toHaveText('1 up · 1 down · 1 gone · 3 checks');
  await card.getByRole('button', { name: 'Expand Homelab' }).click();
  const rows = card.locator('.hc-table tbody tr');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(2)).toContainText('Not in last poll — Fetch to remove');
  await expect(rows.first().locator('td').first()).toHaveCSS('border-bottom-width', '1px');
  await expect(rows.last().locator('td').first()).toHaveCSS('border-bottom-width', '0px');
});

test('the overview shows healthchecks badges below reachability', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await stubHealthchecks(page);
  await page.goto('/');
  const panel = page.locator('.hc-panel');
  await expect(panel.locator('.hc-badge')).toHaveCount(3);
  await expect(panel.locator('.hc-badge.hc-down')).toContainText('SSL (hydrogen)');
  await expect(panel.locator('.hc-badge.hc-gone')).toContainText('Old job');
  const geometry = await page.evaluate(() => {
    const reach = document.querySelector('.ov-grid > .ov-wide:not(.hc-panel)')!.getBoundingClientRect();
    const hc = document.querySelector('.hc-panel')!.getBoundingClientRect();
    return { reachBottom: reach.bottom, hcTop: hc.top };
  });
  expect(geometry.hcTop).toBeGreaterThan(geometry.reachBottom);
});

test('adding a project shows the upstream error inline', async ({ page }) => {
  await page.route('**/api/healthchecks', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 422,
      json: { detail: [{ loc: ['body', 'api_key'], msg: '401 Unauthorized — API key invalid or revoked', type: 'value_error' }] },
    });
  });
  await page.goto('/');
  await openHealthchecks(page);
  await page.getByRole('main').getByRole('button', { name: 'Add project' }).click();
  const modal = page.locator('.modal-overlay.open .modal');
  await modal.getByLabel('Name').fill('Homelab');
  await modal.getByLabel('API key').fill('bad-key');
  await modal.getByRole('button', { name: 'Add & fetch' }).click();
  await expect(modal.locator('#hc-api_key-help')).toHaveText('401 Unauthorized — API key invalid or revoked');
  await expect(modal.getByLabel('API key')).toHaveAttribute('aria-invalid', 'true');
});

// jsdom has no layout or media queries; only a real browser proves the responsive table.
test('the checks table drops columns on narrow screens and stays inside its card', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await stubHealthchecks(page);
  await page.goto('/');
  await openHealthchecks(page);
  const card = page.locator('.hc-card').first();
  await card.getByRole('button', { name: 'Expand Homelab' }).click();
  await expect(card.locator('th.hc-c-slug')).toBeVisible();
  await expect(card.locator('.hc-mob').first()).toBeHidden();

  await page.setViewportSize({ width: 800, height: 900 });
  await expect(card.locator('th.hc-c-slug')).toBeHidden();
  await expect(card.locator('th.hc-c-status')).toBeVisible();

  await page.setViewportSize({ width: 375, height: 812 });
  await expect(card.locator('th.hc-c-status')).toBeHidden();
  await expect(card.locator('th.hc-c-period')).toBeHidden();
  await expect(card.locator('.hc-mob .hc-dot').first()).toBeVisible();
  await expect(card.locator('.hc-period-sub').first()).toBeVisible();
  const fits = await card.locator('.hc-inner').evaluate((el) => el.scrollWidth <= el.clientWidth);
  expect(fits).toBe(true);
});
```

In `frontend/e2e/dashboard.spec.ts`, add `['Healthchecks', 'Healthchecks'],` to `viewPairs` after `['Hooks', 'Hooks']`. The existing "keyboard cannot reach a closed modal" test now also covers the always-mounted `ProjectModal`.

- [ ] **Step 2: Run the e2e suite**

Run (from `frontend/`; port 8123 must be free): `npm run test:e2e`
Expected: all specs pass, old and new. If a narrow-screen assertion fails, fix the CSS in `styles.css`, not the test; the geometry is the requirement.

- [ ] **Step 3: Document.** In `README.md`:
- add a "Healthchecks" bullet to the Features list, matching the surrounding style;
- insert this section right after the `## Heartbeat` section, before `## Docker`:

```markdown
## Healthchecks

Show the status of your [healthchecks.io](https://healthchecks.io) (or self-hosted
Healthchecks) checks next to your DNS records. Add projects in **Healthchecks → Add project**:

- **Name** — your label; the API has no project names.
- **Base URL** — `https://healthchecks.io` by default; point it at your own instance if you
  self-host (sub-paths work).
- **API key** — a **read-only** key from *Project Settings → API Access*. Read-write keys are
  rejected. Keys are stored in the config file and always masked in the API and UI.
- **Poll interval** — 1, 2, 5 (default), or 15 min, or 1 h. The API accepts 60 s to 1 day.

Behaviour:

- Adding a project **fetches** its checks. The check list only changes when you fetch again
  (↻ *Fetch checks*). A fetch keeps each surviving check's Overview toggle, shows new
  checks, and drops removed ones along with their settings. Upstream checks you have not
  fetched yet are ignored.
- Status is **polled** on the project's interval with `GET /api/v3/checks/`. Polls are
  skipped while the link is offline and run again as soon as it returns.
- A failed poll, or an offline link, shows every badge of that project as stateless on the
  Overview. The Healthchecks view shows *Last poll failed: …* or *System is offline*.
  A check that disappears upstream shows as **gone** until the next fetch.
- Each check and each project has a *Show on Overview* toggle. The Overview panel lists one
  row per shown project.
- One log line when polling starts failing, one when it recovers. Live status is not
  persisted.
```

- [ ] **Step 4: Run every gate one last time**

```bash
source .venv/bin/activate
pytest test/ -q --cov=tether_ddns --cov-fail-under=90
flake8 tether_ddns/ test/ && mypy . && pyright && ruff check .
cd frontend && npm test && npx tsc --noEmit -p tsconfig.app.json && npm run test:e2e
```

Expected: everything is green. The only pytest warning is the known `StarletteDeprecationWarning`.

- [ ] **Step 5: Commit**

```bash
git add frontend/e2e/healthchecks.spec.ts frontend/e2e/dashboard.spec.ts README.md
git commit -m "test(e2e): healthchecks view, overview panel and responsive table; docs"
```
