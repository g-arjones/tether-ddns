# Heartbeat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Periodically `GET` a configurable push-monitor URL (healthchecks.io), surface the last result on an Overview stat card with a "Ping now" button, and configure it from a new Settings panel.

**Architecture:** A new `HeartbeatService` (like `SyncService`/`DispatchService`) owns the ping and its single exception-handling point. It records a non-persisted `HeartbeatStatus` on `RuntimeState`, and that status is broadcast over `/api/ws`. The `Scheduler` runs the service on its own interval job. Settings validation lives on Pydantic models (`HttpUrl`, `Field(ge, le)`). The frontend parses FastAPI 422 bodies into field errors so the Settings panel can show them inline.

**Tech Stack:** Python 3.12, FastAPI, Pydantic v2, aiohttp, APScheduler; React 19 + Vite + Vitest + Playwright.

**Spec:** `docs/superpowers/specs/2026-09-25-heartbeat-design.md`

## Global Constraints

- Settings: `heartbeat_url: HttpUrl | None = None`, `heartbeat_interval: HeartbeatInterval = 300`, where `HeartbeatInterval = Annotated[int, Field(ge=30, le=86400)]`.
- A scheduled ping is **skipped while `runtime.online` is false**. `POST /api/heartbeat/ping` uses `force=True` and **ignores** the offline check.
- A successful ping is **never logged**. A failure is logged exactly once, with `_log.exception('Heartbeat to %s failed', url)`.
- Exceptions propagate out of `_ping`. `HeartbeatService.run()` is the only `except Exception`.
- Error text format everywhere is `'ExcType: message'`, or `'ExcType'` when `str(exc)` is empty. It is produced by one helper, `describe_exception`, in `tether_ddns/logging_setup.py`.
- The heartbeat status is NOT persisted (`Field(..., exclude=True)`).
- URL shown in plain text (no masking).
- Heartbeat chips are exactly `30 s / 1 min / 5 min / 15 min` = `30/60/300/900`, default 5 min.
- Python gates cover BOTH `tether_ddns/` and `test/`: flake8 (pep257 incl. D103 on every test function; one-line docstring ending in a period; single quotes; alphabetical imports, ASCII order so `CONST` sorts before `lowercase`), mypy `mypy .`, pyright strict `pyright`, ruff, and `pytest test/ --cov=tether_ddns --cov-fail-under=90`.
- Async tests: `@pytest.mark.asyncio` + `async def`. Protected members are patched via `patch.object(obj, '_name')`, never called directly.
- Under pyright strict, `HttpUrl` fields do not accept `str` in constructors. In tests, build settings with `AppConfig.model_validate({...})` / `AppSettings.model_validate({...})`.
- Frontend: `npm test` (vitest + oxlint) does NOT type-check. Always also run `npx tsc --noEmit -p tsconfig.app.json`. `tsconfig` has `erasableSyntaxOnly` (no TS parameter properties) and `noUnusedLocals`.
- Frontend class names for new CSS are namespaced `hb-*`. Global utilities like `.empty` collide.
- Component tests that depend on the clock fake ONLY Date: `vi.useFakeTimers({ toFake: ['Date'] })` + `vi.setSystemTime(new Date(2026, 7, 29, 12, 0, 0))`.
- `aria-*` booleans: use `cond ? true : undefined`, never a bare boolean `false`.
- Run all commands from the repo root with `source .venv/bin/activate`, unless a step says `cd frontend`.

## File Map

| File | Change |
|---|---|
| `tether_ddns/logging_setup.py` | add `describe_exception`; `LogRingHandler.emit` uses it |
| `tether_ddns/config_store.py` | `HeartbeatInterval`, two `AppSettings` fields |
| `tether_ddns/runtime.py` | `HeartbeatStatus`, `RuntimeState.heartbeat`, `set_heartbeat`, snapshot key |
| `tether_ddns/services/heartbeat.py` | **new** `HeartbeatService` |
| `tether_ddns/scheduler.py` | takes `HeartbeatService`; `heartbeat` job; `reschedule_heartbeat()` |
| `tether_ddns/app.py` | wire service into scheduler and `app.state.heartbeat` |
| `tether_ddns/api.py` | `SettingsUpdate` fields, `mode='json'` dumps, reschedule, `POST /api/heartbeat/ping` |
| `test/unit/test_logging_setup.py`, `test_config_store.py`, `test_runtime.py`, `test_heartbeat_service.py` (new), `test_scheduler.py`, `test_api.py` | tests |
| `frontend/src/types.ts` | `Settings` fields, `HeartbeatStatus`, `StateSnapshot.heartbeat?` |
| `frontend/src/api.ts` | `ApiError`, 422 parsing, `pingHeartbeat()` |
| `frontend/src/components/icons.tsx` | `IconActivity` |
| `frontend/src/components/IconButton.tsx` | optional `disabled` prop |
| `frontend/src/components/HeartbeatCard.tsx` | **new** Overview card |
| `frontend/src/views/OverviewView.tsx` | swap "Update Interval" card for `HeartbeatCard`; `onPing` prop |
| `frontend/src/views/SettingsView.tsx` | Heartbeat panel; `onSave` returns a Promise; chip groups |
| `frontend/src/App.tsx` | `handlePing`; `handleSaveSettings` rethrows |
| `frontend/src/styles.css` | `hb-*` rules |
| `frontend/e2e/dashboard.spec.ts` | inline-422 e2e test |

---

### Task 1: `describe_exception` and the `LogRingHandler` empty-message fix

**Files:**
- Modify: `tether_ddns/logging_setup.py` (the `emit` method and a new module-level function)
- Test: `test/unit/test_logging_setup.py`

**Interfaces:**
- Produces: `describe_exception(exc: BaseException) -> str` in `tether_ddns.logging_setup`. Task 4 uses it.

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/test_logging_setup.py`. Also add `describe_exception` to the existing `from tether_ddns.logging_setup import (...)` block, keeping ASCII order: `APP_LOGGER_NAME, LogRingHandler, describe_exception, install_ring_handler, install_stdout_handler`.

```python
def test_describe_exception_with_message() -> None:
    """An exception with a message renders as 'Type: message'."""
    assert describe_exception(ValueError('bad')) == 'ValueError: bad'


def test_describe_exception_without_message() -> None:
    """An exception with an empty message renders as the bare type name."""
    assert describe_exception(TimeoutError()) == 'TimeoutError'


def test_ring_handler_exception_without_message_has_no_trailing_colon() -> None:
    """A logged exception with no message does not leave a dangling ': '."""
    handler = LogRingHandler(maxlen=10)
    logger = logging.getLogger('test.ring.exc')
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)
    try:
        raise TimeoutError()
    except TimeoutError:
        logger.exception('ping failed')
    assert handler.snapshot()[-1]['message'] == 'ping failed: TimeoutError'


def test_ring_handler_exception_with_message_is_unchanged() -> None:
    """A logged exception with a message keeps the 'msg: Type: text' form."""
    handler = LogRingHandler(maxlen=10)
    logger = logging.getLogger('test.ring.exc2')
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)
    try:
        raise ValueError('boom')
    except ValueError:
        logger.exception('hook failed')
    assert handler.snapshot()[-1]['message'] == 'hook failed: ValueError: boom'
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pytest test/unit/test_logging_setup.py -v`
Expected: ImportError / collection failure (`describe_exception` does not exist).

- [ ] **Step 3: Implement**

In `tether_ddns/logging_setup.py`, add this function above `class LogRingHandler`:

```python
def describe_exception(exc: BaseException) -> str:
    """Return 'Type: message', or just 'Type' when the message is empty."""
    text = str(exc)
    return f'{type(exc).__name__}: {text}' if text else type(exc).__name__
```

Replace these lines in `LogRingHandler.emit`:

```python
            if record.exc_info and record.exc_info[1] is not None:
                exc = record.exc_info[1]
                message = f'{message}: {type(exc).__name__}: {exc}'
```

with:

```python
            if record.exc_info and record.exc_info[1] is not None:
                message = f'{message}: {describe_exception(record.exc_info[1])}'
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pytest test/unit/test_logging_setup.py -v`
Expected: all PASS.

- [ ] **Step 5: Lint gates**

Run: `flake8 tether_ddns/ test/ && ruff check . && mypy . && pyright`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add tether_ddns/logging_setup.py test/unit/test_logging_setup.py
git commit -m "fix(logging): drop the trailing ': ' for exceptions without a message"
```

---

### Task 2: Heartbeat settings with Pydantic validation

**Files:**
- Modify: `tether_ddns/config_store.py` (imports; `AppSettings`)
- Modify: `tether_ddns/api.py` (imports; `SettingsUpdate`; `get_state`, `get_settings`, `put_settings` dumps)
- Test: `test/unit/test_config_store.py`, `test/unit/test_api.py`

**Interfaces:**
- Produces: `HeartbeatInterval` (type alias) in `tether_ddns.config_store`; `AppSettings.heartbeat_url: HttpUrl | None`; `AppSettings.heartbeat_interval: int`. All settings endpoints now return JSON-mode dumps, so `heartbeat_url` is a `str | None` on the wire.

- [ ] **Step 1: Write the failing config tests**

Append to `test/unit/test_config_store.py`. Update its imports to:

```python
from pathlib import Path

from pydantic import ValidationError

import pytest

from tether_ddns.config_store import AppConfig, AppSettings, ConfigStore, DomainConfig
```

```python
URL = 'https://hc-ping.com/5b1c7f0a'


def test_heartbeat_defaults() -> None:
    """The heartbeat is off with a five-minute interval by default."""
    settings = AppSettings()
    assert settings.heartbeat_url is None
    assert settings.heartbeat_interval == 300


@pytest.mark.parametrize('url', ['ftp://hc-ping.com/x', 'hc-ping.com/x', 'not a url'])
def test_heartbeat_url_rejects_non_http(url: str) -> None:
    """Only absolute http/https URLs are accepted."""
    with pytest.raises(ValidationError):
        AppSettings.model_validate({'heartbeat_url': url})


@pytest.mark.parametrize('seconds', [30, 86400])
def test_heartbeat_interval_accepts_bounds(seconds: int) -> None:
    """The interval bounds 30 s and 1 day are inclusive."""
    assert AppSettings.model_validate(
        {'heartbeat_interval': seconds}).heartbeat_interval == seconds


@pytest.mark.parametrize('seconds', [29, 86401, 0])
def test_heartbeat_interval_rejects_out_of_range(seconds: int) -> None:
    """Intervals outside 30 s .. 1 day are rejected."""
    with pytest.raises(ValidationError):
        AppSettings.model_validate({'heartbeat_interval': seconds})


def test_heartbeat_url_round_trips_as_string(tmp_path: Path) -> None:
    """A saved heartbeat URL is written as a JSON string and read back."""
    store = ConfigStore(tmp_path / 'cfg.json')
    store.save(AppConfig.model_validate({'settings': {'heartbeat_url': URL}}))
    assert f'"heartbeat_url": "{URL}"' in store.path.read_text('utf-8')
    assert str(store.load().settings.heartbeat_url) == URL
```

- [ ] **Step 2: Write the failing API tests**

Append to `test/unit/test_api.py`. It already imports `Any`, `Path` and `_client`.

```python
HB_URL = 'https://hc-ping.com/5b1c7f0a'


def test_settings_heartbeat_url_round_trips_as_string(tmp_path: Path) -> None:
    """A heartbeat URL is accepted, persisted and returned as a string."""
    with _client(tmp_path) as client:
        resp: Any = client.put('/api/settings', json={'heartbeat_url': HB_URL})
        assert resp.status_code == 200
        assert resp.json()['heartbeat_url'] == HB_URL
        state: Any = client.get('/api/state')
    assert state.json()['settings']['heartbeat_url'] == HB_URL


def test_settings_heartbeat_url_invalid_returns_422(tmp_path: Path) -> None:
    """A schemeless heartbeat URL is a 422 naming the field; config is unchanged."""
    with _client(tmp_path) as client:
        resp: Any = client.put('/api/settings', json={'heartbeat_url': 'hc-ping.com/x'})
        assert resp.status_code == 422
        assert resp.json()['detail'][0]['loc'][-1] == 'heartbeat_url'
        read_back: Any = client.get('/api/settings')
    assert read_back.json()['heartbeat_url'] is None


def test_settings_heartbeat_url_null_clears(tmp_path: Path) -> None:
    """An explicit null turns the heartbeat off."""
    with _client(tmp_path) as client:
        client.put('/api/settings', json={'heartbeat_url': HB_URL})
        resp: Any = client.put('/api/settings', json={'heartbeat_url': None})
    assert resp.status_code == 200
    assert resp.json()['heartbeat_url'] is None


def test_settings_heartbeat_interval_out_of_range_returns_422(tmp_path: Path) -> None:
    """A heartbeat interval below 30 s is rejected with 422."""
    with _client(tmp_path) as client:
        resp: Any = client.put('/api/settings', json={'heartbeat_interval': 29})
    assert resp.status_code == 422
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pytest test/unit/test_config_store.py test/unit/test_api.py -v -k "heartbeat"`
Expected: FAIL. The attributes don't exist yet, and `extra='forbid'` makes the API tests return 422.

- [ ] **Step 4: Implement `config_store.py`**

Change the imports:

```python
from typing import Annotated, Literal, cast
from uuid import uuid4

from pydantic import BaseModel, Field, HttpUrl
```

Add the alias above `class AppSettings`, and the two fields at the end of `AppSettings`:

```python
HeartbeatInterval = Annotated[int, Field(ge=30, le=86400)]


class AppSettings(BaseModel):
    """Global application settings."""

    check_interval: int = 300
    ip_source: str = 'ipify'
    update_on_startup: bool = True
    retry_on_failure: bool = True
    notify: bool = True
    heartbeat_url: HttpUrl | None = None
    heartbeat_interval: HeartbeatInterval = 300
```

- [ ] **Step 5: Implement `api.py`**

Change the pydantic import to `from pydantic import BaseModel, ConfigDict, HttpUrl`. Add `HeartbeatInterval` to the `tether_ddns.config_store` import block, keeping ASCII order: `AppSettings, DomainConfig, HeartbeatInterval, HookConfig, mask_secrets, merge_secrets`.

Extend `SettingsUpdate`:

```python
    notify: bool | None = None
    heartbeat_url: HttpUrl | None = None
    heartbeat_interval: HeartbeatInterval | None = None
```

In `get_state`, change `snap['settings'] = cfg.settings.model_dump()` to `snap['settings'] = cfg.settings.model_dump(mode='json')`.

In `get_settings`, change `settings: dict[str, object] = app.state.config.settings.model_dump()` to `... .model_dump(mode='json')`.

In `put_settings`, change `dumped: dict[str, object] = merged.model_dump()` to `dumped: dict[str, object] = merged.model_dump(mode='json')`. Leave the `AppSettings(**{**current.model_dump(), **set_fields})` merge line alone. It passes `HttpUrl` objects, which is valid.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pytest test/unit/test_config_store.py test/unit/test_api.py -v`
Expected: all PASS, including the pre-existing settings tests.

- [ ] **Step 7: Lint gates**

Run: `flake8 tether_ddns/ test/ && ruff check . && mypy . && pyright`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add tether_ddns/config_store.py tether_ddns/api.py test/unit/test_config_store.py test/unit/test_api.py
git commit -m "feat(settings): heartbeat URL and interval with pydantic validation"
```

---

### Task 3: `HeartbeatStatus` on `RuntimeState`

**Files:**
- Modify: `tether_ddns/runtime.py`
- Test: `test/unit/test_runtime.py`

**Interfaces:**
- Produces: `class HeartbeatStatus(BaseModel)` with fields `at: float`, `ok: bool`, `skipped: bool`, `error: str | None = None`; `RuntimeState.heartbeat: HeartbeatStatus | None`; `RuntimeState.set_heartbeat(status: HeartbeatStatus) -> None`; `snapshot()['heartbeat']` is `dict | None`.

- [ ] **Step 1: Write the failing tests**

In `test/unit/test_runtime.py`, change the runtime import block to:

```python
from tether_ddns.runtime import (
    CheckRecord,
    HeartbeatStatus,
    REACHABILITY_HISTORY_SIZE,
    RuntimeState,
)
```

Append:

```python
def _hb() -> HeartbeatStatus:
    return HeartbeatStatus(at=1.0, ok=False, skipped=False, error='TimeoutError')


def test_set_heartbeat_notifies_listeners() -> None:
    """Setting the heartbeat emits a snapshot that carries it."""
    state = RuntimeState()
    seen: list[dict[str, object]] = []
    state.add_listener(seen.append)
    state.set_heartbeat(_hb())
    assert state.heartbeat == _hb()
    assert seen[-1]['heartbeat'] == {
        'at': 1.0, 'ok': False, 'skipped': False, 'error': 'TimeoutError'}


def test_snapshot_heartbeat_defaults_to_none() -> None:
    """A fresh state reports no heartbeat attempt yet."""
    assert RuntimeState().snapshot()['heartbeat'] is None


def test_heartbeat_is_not_persisted() -> None:
    """The heartbeat status is excluded from the persisted payload."""
    state = RuntimeState()
    state.set_heartbeat(_hb())
    assert 'heartbeat' not in state.model_dump_json()
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pytest test/unit/test_runtime.py -v -k heartbeat`
Expected: ImportError on `HeartbeatStatus`.

- [ ] **Step 3: Implement**

In `tether_ddns/runtime.py`, add below `class CheckRecord`:

```python
class HeartbeatStatus(BaseModel):
    """Outcome of the most recent heartbeat attempt."""

    at: float
    ok: bool
    skipped: bool
    error: str | None = None
```

In `RuntimeState`, add after the `next_check_at` field:

```python
    heartbeat: HeartbeatStatus | None = Field(default=None, exclude=True)
```

Add after `set_next_check_at`:

```python
    def set_heartbeat(self, status: HeartbeatStatus) -> None:
        """Record the latest heartbeat outcome and notify listeners."""
        self.heartbeat = status
        self._emit()
```

In `snapshot()`, add after the `'next_check_at'` entry:

```python
            'heartbeat': (
                self.heartbeat.model_dump() if self.heartbeat is not None else None),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pytest test/unit/test_runtime.py test/unit/test_scheduler.py -v`
Expected: all PASS. The scheduler's `flush_state` tests prove that the excluded field causes no extra writes.

- [ ] **Step 5: Lint gates**

Run: `flake8 tether_ddns/ test/ && ruff check . && mypy . && pyright`

- [ ] **Step 6: Commit**

```bash
git add tether_ddns/runtime.py test/unit/test_runtime.py
git commit -m "feat(runtime): live, non-persisted heartbeat status"
```

---

### Task 4: `HeartbeatService`

**Files:**
- Create: `tether_ddns/services/heartbeat.py`
- Test: `test/unit/test_heartbeat_service.py` (new)

**Interfaces:**
- Consumes: `describe_exception` (Task 1); `AppSettings.heartbeat_url` (Task 2); `HeartbeatStatus`, `RuntimeState.set_heartbeat`, `RuntimeState.online` (Task 3); `AppContext(config, runtime, config_store, state_store, manager, incidents)`.
- Produces: `class HeartbeatService` with `__init__(self, ctx: AppContext)`, `async run(self, *, force: bool = False) -> HeartbeatStatus | None`, and protected `async _ping(self, url: str) -> None`.

- [ ] **Step 1: Write the failing tests**

Create `test/unit/test_heartbeat_service.py`:

```python
"""Tests for the heartbeat service."""
import logging
from unittest.mock import AsyncMock, MagicMock, patch

import aiohttp

import pytest

from tether_ddns.config_store import AppConfig
from tether_ddns.context import AppContext
from tether_ddns.runtime import RuntimeState
from tether_ddns.services.heartbeat import HeartbeatService

URL = 'https://hc-ping.com/5b1c7f0a'


def _service(
    url: str | None = URL, online: bool = True,
) -> tuple[HeartbeatService, RuntimeState]:
    """Build a service over a config with the given URL and link state."""
    cfg = AppConfig.model_validate({'settings': {'heartbeat_url': url}})
    state = RuntimeState()
    state.online = online
    ctx = AppContext(cfg, state, MagicMock(), MagicMock(), MagicMock(), MagicMock())
    return HeartbeatService(ctx), state


def _session(resp: MagicMock) -> MagicMock:
    """Build a ClientSession double whose GET yields resp."""
    session = MagicMock()
    session.get.return_value.__aenter__ = AsyncMock(return_value=resp)
    session.get.return_value.__aexit__ = AsyncMock(return_value=False)
    return session


@pytest.mark.asyncio
async def test_run_without_url_does_nothing() -> None:
    """With no URL configured, run sends nothing and records nothing."""
    service, state = _service(url=None)
    with patch.object(service, '_ping', new=AsyncMock()) as ping:
        assert await service.run() is None
    ping.assert_not_awaited()
    assert state.heartbeat is None


@pytest.mark.asyncio
async def test_run_offline_is_skipped() -> None:
    """A scheduled run while offline records a skip and sends nothing."""
    service, state = _service(online=False)
    with patch.object(service, '_ping', new=AsyncMock()) as ping:
        status = await service.run()
    ping.assert_not_awaited()
    assert status is not None
    assert status.skipped is True and status.ok is False and status.error is None
    assert state.heartbeat == status


@pytest.mark.asyncio
async def test_forced_run_ignores_offline() -> None:
    """A forced run pings even while offline."""
    service, _ = _service(online=False)
    with patch.object(service, '_ping', new=AsyncMock()) as ping:
        status = await service.run(force=True)
    ping.assert_awaited_once_with(URL)
    assert status is not None and status.ok is True and status.skipped is False


@pytest.mark.asyncio
async def test_success_is_recorded_and_not_logged(caplog: pytest.LogCaptureFixture) -> None:
    """A successful ping updates state and emits no log records."""
    service, state = _service()
    with caplog.at_level(logging.DEBUG, logger='tether_ddns'):
        with patch.object(service, '_ping', new=AsyncMock()):
            status = await service.run()
    assert status is not None and status.ok is True and status.error is None
    assert state.heartbeat == status
    assert caplog.records == []


@pytest.mark.asyncio
async def test_failure_is_recorded_and_logged_with_traceback(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """An HTTP error is logged once with exc_info and recorded as the message."""
    service, _ = _service()
    error = aiohttp.ClientResponseError(
        MagicMock(), (), status=404, message='Not Found')
    with caplog.at_level(logging.DEBUG, logger='tether_ddns'):
        with patch.object(service, '_ping', new=AsyncMock(side_effect=error)):
            status = await service.run()
    assert status is not None and status.ok is False and status.skipped is False
    assert status.error is not None
    assert status.error.startswith("ClientResponseError: 404, message='Not Found'")
    [record] = caplog.records
    assert record.levelno == logging.ERROR
    assert record.getMessage() == f'Heartbeat to {URL} failed'
    assert record.exc_info is not None


@pytest.mark.asyncio
async def test_timeout_error_is_the_bare_type_name() -> None:
    """A message-less TimeoutError is recorded as just its type name."""
    service, _ = _service()
    with patch.object(service, '_ping', new=AsyncMock(side_effect=TimeoutError())):
        status = await service.run()
    assert status is not None and status.error == 'TimeoutError'


@pytest.mark.asyncio
async def test_ping_gets_the_url_with_a_timeout() -> None:
    """The HTTP layer GETs the URL with a 10 s total timeout and checks status."""
    service, _ = _service()
    resp = MagicMock()
    session = _session(resp)
    with patch('tether_ddns.services.heartbeat.aiohttp.ClientSession') as cs:
        cs.return_value.__aenter__ = AsyncMock(return_value=session)
        cs.return_value.__aexit__ = AsyncMock(return_value=False)
        status = await service.run()
    assert status is not None and status.ok is True
    session.get.assert_called_once_with(URL)
    resp.raise_for_status.assert_called_once_with()
    assert cs.call_args.kwargs['timeout'].total == 10


@pytest.mark.asyncio
async def test_ping_http_error_propagates_to_run() -> None:
    """raise_for_status failures surface as a recorded failure."""
    service, _ = _service()
    resp = MagicMock()
    resp.raise_for_status.side_effect = aiohttp.ClientResponseError(
        MagicMock(), (), status=503, message='Service Unavailable')
    session = _session(resp)
    with patch('tether_ddns.services.heartbeat.aiohttp.ClientSession') as cs:
        cs.return_value.__aenter__ = AsyncMock(return_value=session)
        cs.return_value.__aexit__ = AsyncMock(return_value=False)
        status = await service.run()
    assert status is not None and status.ok is False
    assert status.error is not None and status.error.startswith('ClientResponseError: 503')
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pytest test/unit/test_heartbeat_service.py -v`
Expected: ModuleNotFoundError for `tether_ddns.services.heartbeat`.

- [ ] **Step 3: Implement**

Create `tether_ddns/services/heartbeat.py`:

```python
"""Heartbeat pings to a push monitor as a context-owning service."""
from __future__ import annotations

import time

import aiohttp

from tether_ddns.context import AppContext
from tether_ddns.logging_setup import describe_exception, get_logger
from tether_ddns.runtime import HeartbeatStatus

_log = get_logger()
_TIMEOUT = aiohttp.ClientTimeout(total=10)


class HeartbeatService:
    """Sends the configured heartbeat GET and records its outcome."""

    def __init__(self, ctx: AppContext) -> None:
        """Create a heartbeat service bound to a context."""
        self._ctx = ctx

    async def run(self, *, force: bool = False) -> HeartbeatStatus | None:
        """Ping the heartbeat URL; skip while offline unless forced."""
        url = self._ctx.config.settings.heartbeat_url
        if url is None:
            return None
        runtime = self._ctx.runtime
        if not force and not runtime.online:
            status = HeartbeatStatus(at=time.time(), ok=False, skipped=True)
        else:
            try:
                await self._ping(str(url))
            except Exception as exc:  # noqa: BLE001 - heartbeat errors must be contained
                _log.exception('Heartbeat to %s failed', url)
                status = HeartbeatStatus(
                    at=time.time(), ok=False, skipped=False,
                    error=describe_exception(exc))
            else:
                status = HeartbeatStatus(at=time.time(), ok=True, skipped=False)
        runtime.set_heartbeat(status)
        return status

    async def _ping(self, url: str) -> None:
        """GET the URL, raising on transport errors and non-2xx responses."""
        async with aiohttp.ClientSession(timeout=_TIMEOUT) as session:
            async with session.get(url) as resp:
                resp.raise_for_status()
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pytest test/unit/test_heartbeat_service.py -v`
Expected: all PASS.

- [ ] **Step 5: Lint gates**

Run: `flake8 tether_ddns/ test/ && ruff check . && mypy . && pyright`
Expected: no errors. If ruff flags `BLE001` differently from `dispatch.py`, mirror the exact `noqa` form used in `tether_ddns/services/dispatch.py`.

- [ ] **Step 6: Commit**

```bash
git add tether_ddns/services/heartbeat.py test/unit/test_heartbeat_service.py
git commit -m "feat(heartbeat): HeartbeatService with a single failure-handling point"
```

---

### Task 5: Scheduler job, app wiring, reschedule, and `POST /api/heartbeat/ping`

**Files:**
- Modify: `tether_ddns/scheduler.py` (imports, `__init__`, `start`, new `reschedule_heartbeat`)
- Modify: `tether_ddns/app.py` (lifespan wiring, lines ~91-107)
- Modify: `tether_ddns/api.py` (imports, `put_settings`, new route)
- Test: `test/unit/test_scheduler.py`, `test/unit/test_api.py`

**Interfaces:**
- Consumes: `HeartbeatService` (Task 4); `AppSettings.heartbeat_interval` (Task 2).
- Produces: `Scheduler(ctx, sync, dispatch, reachability, heartbeat: HeartbeatService)`; `Scheduler.reschedule_heartbeat() -> None`; `app.state.heartbeat: HeartbeatService`; `POST /api/heartbeat/ping` → `200 {at, ok, skipped, error}` or `400 {'detail': 'heartbeat URL not configured'}`.

- [ ] **Step 1: Update the existing scheduler test call sites**

The new constructor argument is required, so every `scheduler.Scheduler(...)` in `test/unit/test_scheduler.py` needs it. Add `from tether_ddns.services.heartbeat import HeartbeatService` to the imports, between the `dispatch` and `incidents` service imports.

Replace the `_sched` helper's return with:

```python
    ctx = _ctx(cfg, state)
    sync = SyncService(ctx, dispatch)
    return scheduler.Scheduler(
        ctx, sync, dispatch, ReachabilityProbe(), HeartbeatService(ctx))
```

This replaces the old two lines, which built `SyncService(_ctx(cfg, state), dispatch)` and `scheduler.Scheduler(_ctx(cfg, state), sync, dispatch, ReachabilityProbe())`.

For every other direct construction (in `test_shutdown_flushes_state`, `test_flush_state_writes`, `test_flush_state_skips_write_when_unchanged`, `test_flush_state_writes_again_after_real_change`, `test_flush_state_ignores_reachability_ticks`, `test_check_reachability_records_an_incident`, `test_check_reachability_emits_once_per_tick`, `test_shutdown_flushes_the_incident_window`), add `HeartbeatService(ctx)` as the last argument, for example:

```python
    sched = scheduler.Scheduler(
        ctx, SyncService(ctx, AsyncMock()), AsyncMock(), ReachabilityProbe(),
        HeartbeatService(ctx))
```

Use `grep -n "scheduler.Scheduler(" test/unit/test_scheduler.py` to confirm none are missed.

- [ ] **Step 2: Write the failing scheduler tests**

Append to `test/unit/test_scheduler.py`:

```python
def _heartbeat_call(fake: MagicMock) -> Any:
    """Return the add_job call that registered the heartbeat job."""
    return next(c for c in fake.add_job.call_args_list if c.kwargs.get('id') == 'heartbeat')


def test_start_schedules_the_heartbeat_job() -> None:
    """start() adds the heartbeat job at the configured interval."""
    cfg = AppConfig()
    cfg.settings.heartbeat_interval = 60
    state = RuntimeState()
    ctx = _ctx(cfg, state)
    heartbeat = HeartbeatService(ctx)
    sched = scheduler.Scheduler(
        ctx, SyncService(ctx, AsyncMock()), AsyncMock(), ReachabilityProbe(), heartbeat)
    fake = MagicMock()
    with patch.object(sched, '_scheduler', fake):
        sched.start()
    call = _heartbeat_call(fake)
    assert call.args[0] == heartbeat.run
    assert call.args[1] == 'interval'
    assert call.kwargs['seconds'] == 60
    assert call.kwargs['replace_existing'] is True


def test_reschedule_heartbeat_applies_new_interval() -> None:
    """reschedule_heartbeat re-adds the job with the current interval."""
    cfg = AppConfig()
    state = RuntimeState()
    sched = _sched(cfg, state)
    cfg.settings.heartbeat_interval = 900
    fake = MagicMock()
    with patch.object(sched, '_scheduler', fake):
        sched.reschedule_heartbeat()
    call = _heartbeat_call(fake)
    assert call.kwargs['seconds'] == 900
    assert call.kwargs['replace_existing'] is True
```

Add `from typing import Any` to the top of the file (stdlib group, after `from tempfile import mkdtemp`).

- [ ] **Step 3: Write the failing API tests**

Append to `test/unit/test_api.py`. Add `from tether_ddns.services.heartbeat import HeartbeatService` to the imports (after `from tether_ddns.runtime import RuntimeState`, before `from tether_ddns.state_store import StateStore`).

```python
def test_heartbeat_interval_change_reschedules(tmp_path: Path) -> None:
    """Changing the heartbeat interval reschedules the heartbeat job."""
    with _client(tmp_path) as client:
        with patch.object(client.app.state.scheduler, 'reschedule_heartbeat') as resched:
            client.put('/api/settings', json={'heartbeat_interval': 60})
    resched.assert_called_once_with()


def test_other_setting_change_does_not_reschedule_heartbeat(tmp_path: Path) -> None:
    """An unrelated settings change leaves the heartbeat job alone."""
    with _client(tmp_path) as client:
        with patch.object(client.app.state.scheduler, 'reschedule_heartbeat') as resched:
            client.put('/api/settings', json={'notify': False})
    resched.assert_not_called()


def test_ping_now_without_url_is_400(tmp_path: Path) -> None:
    """Ping now with no heartbeat URL configured returns 400."""
    with _client(tmp_path) as client:
        resp: Any = client.post('/api/heartbeat/ping')
    assert resp.status_code == 400
    assert resp.json()['detail'] == 'heartbeat URL not configured'


def test_ping_now_forces_a_ping_and_returns_status(tmp_path: Path) -> None:
    """Ping now pings even while offline and returns the recorded status."""
    with _client(tmp_path) as client:
        client.put('/api/settings', json={'heartbeat_url': HB_URL})
        with patch.object(HeartbeatService, '_ping', new=AsyncMock()) as ping:
            resp: Any = client.post('/api/heartbeat/ping')
    assert resp.status_code == 200
    body: dict[str, object] = resp.json()
    assert body['ok'] is True and body['skipped'] is False and body['error'] is None
    ping.assert_awaited_once_with(HB_URL)
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `pytest test/unit/test_scheduler.py test/unit/test_api.py -v`
Expected: FAIL. `Scheduler()` takes 5 positional arguments, `reschedule_heartbeat` doesn't exist, and the ping route is a 404/405.

- [ ] **Step 5: Implement the scheduler**

In `tether_ddns/scheduler.py`, add `from tether_ddns.services.heartbeat import HeartbeatService` between the `dispatch` and `sync` imports. Change `__init__`:

```python
    def __init__(
        self, ctx: AppContext, sync: SyncService,
        dispatch: DispatchService, reachability: ReachabilityProbe,
        heartbeat: HeartbeatService,
    ) -> None:
        """Create an unstarted scheduler bound to its services."""
        self._scheduler = AsyncIOScheduler()
        self._ctx = ctx
        self._sync = sync
        self._dispatch = dispatch
        self._reachability = reachability
        self._heartbeat = heartbeat
        self._last_state_json: str | None = None
```

In `start()`, add `self.reschedule_heartbeat()` immediately before `self._scheduler.start()`, and update the docstring to `"""Schedule the reachability, IP-sync, heartbeat and flush jobs and start."""`.

Add after `reschedule_sync`:

```python
    def reschedule_heartbeat(self) -> None:
        """(Re-)add the heartbeat job with the current heartbeat interval."""
        self._scheduler.add_job(  # pyright: ignore[reportUnknownMemberType]
            self._heartbeat.run, 'interval',
            seconds=self._ctx.config.settings.heartbeat_interval,
            args=[], id='heartbeat', replace_existing=True,
        )
```

- [ ] **Step 6: Wire the app**

In `tether_ddns/app.py`, add `from tether_ddns.services.heartbeat import HeartbeatService` (after the `dispatch` import). Replace:

```python
        scheduler = Scheduler(ctx, sync, dispatch, ReachabilityProbe())
```

with:

```python
        heartbeat = HeartbeatService(ctx)
        scheduler = Scheduler(ctx, sync, dispatch, ReachabilityProbe(), heartbeat)
```

Then add `app.state.heartbeat = heartbeat` after `app.state.sync = sync`.

- [ ] **Step 7: Implement the API**

In `tether_ddns/api.py`, add `from tether_ddns.services.heartbeat import HeartbeatService` after the `dispatch` import. In `put_settings`, add below `interval_changed = ...`:

```python
        heartbeat_changed = merged.heartbeat_interval != current.heartbeat_interval
```

and below the existing `if interval_changed:` block:

```python
        if heartbeat_changed:
            app.state.scheduler.reschedule_heartbeat()
```

Add the route after `put_settings`:

```python
    @router.post('/heartbeat/ping')
    async def ping_heartbeat() -> dict[str, object]:
        heartbeat: HeartbeatService = app.state.heartbeat
        status = await heartbeat.run(force=True)
        if status is None:
            raise HTTPException(status_code=400, detail='heartbeat URL not configured')
        return status.model_dump()
```

- [ ] **Step 8: Run the full backend suite**

Run: `pytest test/ --cov=tether_ddns --cov-fail-under=90`
Expected: all PASS and coverage ≥ 90%. The only expected warning is the pre-existing third-party `StarletteDeprecationWarning` from `fastapi/testclient.py`.

- [ ] **Step 9: Lint gates**

Run: `flake8 tether_ddns/ test/ && ruff check . && mypy . && pyright`

- [ ] **Step 10: Commit**

```bash
git add tether_ddns/scheduler.py tether_ddns/app.py tether_ddns/api.py test/unit/test_scheduler.py test/unit/test_api.py
git commit -m "feat(heartbeat): scheduled job, reschedule on change, and Ping now endpoint"
```

---

### Task 6: Frontend types, `ApiError`, and `pingHeartbeat`

**Files:**
- Modify: `frontend/src/types.ts`
- Modify: `frontend/src/api.ts` (the `json()` helper, plus new exports)
- Modify fixtures: `frontend/src/views/OverviewView.test.tsx`, `frontend/src/views/SettingsView.test.tsx`, `frontend/src/useLiveState.test.tsx`
- Test: `frontend/src/api.test.ts`

**Interfaces:**
- Produces: `Settings.heartbeat_url: string | null`, `Settings.heartbeat_interval: number`; `interface HeartbeatStatus { at: number; ok: boolean; skipped: boolean; error: string | null }`; `StateSnapshot.heartbeat?: HeartbeatStatus | null`; `class ApiError extends Error { status: number; fieldErrors: Record<string, string> }`; `pingHeartbeat(): Promise<HeartbeatStatus>`.

- [ ] **Step 1: Write the failing tests**

Replace `frontend/src/api.test.ts` with:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApiError, getProviders, pingHeartbeat, putSettings } from './api';

describe('api', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('getProviders fetches /api/providers and returns json', async () => {
    const data = [{ key: 'duckdns', display_name: 'DuckDNS', schema: {} }];
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => data })));
    const result = await getProviders();
    expect(fetch).toHaveBeenCalledWith('/api/providers');
    expect(result[0].key).toBe('duckdns');
  });

  it('maps a 422 detail list to fieldErrors keyed by the last loc part', async () => {
    const detail = [{ loc: ['body', 'heartbeat_url'], msg: 'Input should be a valid URL', type: 'url_parsing' }];
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 422, json: async () => ({ detail }) })));
    const err = await putSettings({ heartbeat_url: 'x' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(422);
    expect((err as ApiError).fieldErrors).toEqual({ heartbeat_url: 'Input should be a valid URL' });
    expect((err as ApiError).message).toBe('/api/settings -> 422');
  });

  it('keeps fieldErrors empty for non-422 failures', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));
    const err = await putSettings({ notify: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).fieldErrors).toEqual({});
    expect((err as ApiError).message).toBe('/api/settings -> 500');
  });

  it('tolerates a 422 body that is not a detail list', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 422, json: async () => { throw new Error('not json'); } })));
    const err = await putSettings({ notify: true }).catch((e: unknown) => e);
    expect((err as ApiError).fieldErrors).toEqual({});
  });

  it('pingHeartbeat POSTs to /api/heartbeat/ping', async () => {
    const status = { at: 1, ok: true, skipped: false, error: null };
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => status })));
    expect(await pingHeartbeat()).toEqual(status);
    expect(fetch).toHaveBeenCalledWith('/api/heartbeat/ping', { method: 'POST' });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run src/api.test.ts`
Expected: FAIL (`ApiError`/`pingHeartbeat` not exported).

- [ ] **Step 3: Implement `types.ts`**

Replace the `Settings` line with:

```ts
export interface Settings {
  check_interval: number; ip_source: string; update_on_startup: boolean; retry_on_failure: boolean; notify: boolean;
  heartbeat_url: string | null; heartbeat_interval: number;
}
export interface HeartbeatStatus { at: number; ok: boolean; skipped: boolean; error: string | null; }
```

In `StateSnapshot`, add after `next_check_at`:

```ts
  heartbeat?: HeartbeatStatus | null;
```

- [ ] **Step 4: Implement `api.ts`**

Add `HeartbeatStatus` to the type import. Replace the `json()` helper with:

```ts
export class ApiError extends Error {
  readonly status: number;
  readonly fieldErrors: Record<string, string>;

  constructor(message: string, status: number, fieldErrors: Record<string, string> = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.fieldErrors = fieldErrors;
  }
}

// FastAPI 422 bodies are {detail: [{loc: [...], msg}]}; key each message by its field name.
async function fieldErrorsOf(res: Response): Promise<Record<string, string>> {
  try {
    const body = (await res.json()) as { detail?: unknown };
    if (!Array.isArray(body.detail)) return {};
    const out: Record<string, string> = {};
    for (const entry of body.detail as { loc?: unknown[]; msg?: unknown }[]) {
      const key = entry.loc?.at(-1);
      if (key !== undefined && typeof entry.msg === 'string') out[String(key)] = entry.msg;
    }
    return out;
  } catch {
    return {};
  }
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = init ? await fetch(url, init) : await fetch(url);
  if (!res.ok) {
    const fieldErrors = res.status === 422 ? await fieldErrorsOf(res) : {};
    throw new ApiError(`${url} -> ${res.status}`, res.status, fieldErrors);
  }
  return res.json() as Promise<T>;
}
```

Append:

```ts
export const pingHeartbeat = () => json<HeartbeatStatus>('/api/heartbeat/ping', { method: 'POST' });
```

- [ ] **Step 5: Update the typed fixtures**

Add `heartbeat_url: null, heartbeat_interval: 300` to the settings objects in:
- `frontend/src/views/OverviewView.test.tsx` (the `settings:` inside `snapshot`)
- `frontend/src/views/SettingsView.test.tsx` (the top-level `const settings`; also annotate it `const settings: Settings = ...` and add `import type { Settings } from '../types';`)
- `frontend/src/useLiveState.test.tsx` (the `settings:` block near line 48)

- [ ] **Step 6: Run the tests and the type check**

Run: `cd frontend && npm test && npx tsc --noEmit -p tsconfig.app.json`
Expected: all PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/types.ts frontend/src/api.ts frontend/src/api.test.ts frontend/src/views/OverviewView.test.tsx frontend/src/views/SettingsView.test.tsx frontend/src/useLiveState.test.tsx
git commit -m "feat(frontend): ApiError with 422 field errors, heartbeat types and ping call"
```

---

### Task 7: `HeartbeatCard` component

**Files:**
- Modify: `frontend/src/components/icons.tsx` (append `IconActivity`)
- Modify: `frontend/src/components/IconButton.tsx` (optional `disabled`)
- Create: `frontend/src/components/HeartbeatCard.tsx`
- Modify: `frontend/src/styles.css` (after the `.tint-err` rule in the Stats section)
- Test: `frontend/src/components/HeartbeatCard.test.tsx` (new)

**Interfaces:**
- Consumes: `HeartbeatStatus` (Task 6); `formatInterval`, `relStable` from `../utils`; `IconButton`.
- Produces: `HeartbeatCard(props: { status: HeartbeatStatus | null; url: string | null; interval: number; onPing: () => Promise<void> })`; `IconActivity`; `IconButtonProps.disabled?: boolean`.

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/components/HeartbeatCard.test.tsx`:

```tsx
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HeartbeatCard } from './HeartbeatCard';

const NOW = new Date(2026, 7, 29, 12, 0, 0).getTime();
const URL = 'https://hc-ping.com/5b1c7f0a';
const at = (secondsAgo: number) => NOW / 1000 - secondsAgo;

describe('HeartbeatCard', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => { vi.useRealTimers(); });

  it('reads Off with no ping button when no URL is set', () => {
    render(<HeartbeatCard status={null} url={null} interval={300} onPing={vi.fn()} />);
    expect(screen.getByText('Off')).toBeInTheDocument();
    expect(screen.getByText('Set a URL in Settings')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Ping now' })).toBeNull();
  });

  it('shows a dash and the cadence before the first attempt', () => {
    render(<HeartbeatCard status={null} url={URL} interval={300} onPing={vi.fn()} />);
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.getByText('hc-ping.com')).toBeInTheDocument();
    expect(screen.getByText(/every 5 min/)).toBeInTheDocument();
  });

  it('shows the age and OK after a successful ping', () => {
    const status = { at: at(42), ok: true, skipped: false, error: null };
    const { container } = render(<HeartbeatCard status={status} url={URL} interval={300} onPing={vi.fn()} />);
    expect(screen.getByText('42s ago')).toBeInTheDocument();
    expect(screen.getByText('OK')).toBeInTheDocument();
    expect(container.querySelector('.stat')).toHaveClass('hb-ok');
  });

  it('shows Skipped while the link is offline', () => {
    const status = { at: at(5), ok: false, skipped: true, error: null };
    render(<HeartbeatCard status={status} url={URL} interval={300} onPing={vi.fn()} />);
    expect(screen.getByText('Skipped')).toBeInTheDocument();
    expect(screen.getByText('Link offline')).toBeInTheDocument();
  });

  it('shows Failed with the full error in the tooltip', () => {
    const error = "ClientResponseError: 404, message='Not Found'";
    const status = { at: at(12), ok: false, skipped: false, error };
    const { container } = render(<HeartbeatCard status={status} url={URL} interval={300} onPing={vi.fn()} />);
    expect(screen.getByText('Failed')).toBeInTheDocument();
    expect(screen.getByText(error)).toBeInTheDocument();
    expect(container.querySelector('.hb-sub')).toHaveAttribute('title', error);
    expect(container.querySelector('.stat')).toHaveClass('hb-err');
  });

  it('calls onPing and spins until it settles', async () => {
    let settle: () => void = () => undefined;
    const onPing = vi.fn(() => new Promise<void>((resolve) => { settle = resolve; }));
    render(<HeartbeatCard status={null} url={URL} interval={300} onPing={onPing} />);
    const button = screen.getByRole('button', { name: 'Ping now' });
    fireEvent.click(button);
    expect(onPing).toHaveBeenCalledOnce();
    expect(button).toBeDisabled();
    expect(button).toHaveClass('spin');
    settle();
    await waitFor(() => expect(button).not.toBeDisabled());
    expect(button).not.toHaveClass('spin');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run src/components/HeartbeatCard.test.tsx`
Expected: FAIL (module not found).

- [ ] **Step 3: Add `IconActivity`**

Append to `frontend/src/components/icons.tsx`:

```tsx
export function IconActivity(p: IconProps): JSX.Element {
  return <Svg {...p}><path d="M22 12h-4l-3 9L9 3l-3 9H2" /></Svg>;
}
```

- [ ] **Step 4: Add `disabled` to `IconButton`**

In `frontend/src/components/IconButton.tsx`, add `disabled?: boolean;` to `IconButtonProps`, destructure `disabled = false`, and pass `disabled={disabled}` on the `<button>`.

- [ ] **Step 5: Implement `HeartbeatCard`**

Create `frontend/src/components/HeartbeatCard.tsx`:

```tsx
import { useEffect, useState, type JSX, type ReactNode } from 'react';
import type { HeartbeatStatus } from '../types';
import { formatInterval, relStable } from '../utils';
import { IconButton } from './IconButton';
import { IconActivity } from './icons';

export interface HeartbeatCardProps {
  status: HeartbeatStatus | null;
  url: string | null;
  interval: number;
  onPing: () => Promise<void>;
}

type Tone = 'muted' | 'neutral' | 'ok' | 'err';

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function HeartbeatCard({ status, url, interval, onPing }: HeartbeatCardProps): JSX.Element {
  const [now, setNow] = useState(() => Date.now());
  const [pinging, setPinging] = useState(false);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const ping = () => {
    setPinging(true);
    void onPing().catch(() => undefined).finally(() => setPinging(false));
  };

  let value: string;
  let sub: ReactNode;
  let tone: Tone;
  let title: string | undefined;
  const cadence = (u: string) => (
    <>{`every ${formatInterval(interval)} · `}<span className="hb-host">{hostOf(u)}</span></>
  );
  if (url === null) {
    value = 'Off'; sub = 'Set a URL in Settings'; tone = 'muted';
  } else if (status === null) {
    value = '—'; sub = cadence(url); tone = 'neutral';
  } else if (status.skipped) {
    value = 'Skipped'; sub = 'Link offline'; tone = 'muted';
  } else if (status.ok) {
    value = `${relStable(status.at, now)} ago`;
    sub = <><span className="hb-flag">OK</span>{' · '}{cadence(url)}</>;
    tone = 'ok';
  } else {
    value = 'Failed';
    sub = <span className="hb-host">{status.error}</span>;
    title = status.error ?? undefined;
    tone = 'err';
  }

  return (
    <div className={`stat hb-${tone}`}>
      <div className="stat-top">
        <span className="stat-label">Heartbeat</span>
        {url !== null && (
          <IconButton
            variant="act"
            label="Ping now"
            onClick={ping}
            disabled={pinging}
            className={pinging ? 'spin' : undefined}
          >
            <IconActivity />
          </IconButton>
        )}
      </div>
      <div className="stat-value hb-value">{value}</div>
      <div className="stat-sub hb-sub" title={title}>{sub}</div>
    </div>
  );
}
```

- [ ] **Step 6: Add the styles**

In `frontend/src/styles.css`, insert directly after the `.tint-err { ... }` line:

```css
/* heartbeat stat card: ages like "5m 12s ago" are wider than a count */
.hb-value { font-size: 24px; }
.hb-sub { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hb-host { font-family: var(--mono); }
.hb-flag { color: var(--ok); font-weight: 650; }
.hb-muted .stat-value { color: var(--text-3); }
.hb-err { border-color: color-mix(in srgb, var(--err) 45%, transparent); }
.hb-err .stat-value, .hb-err .hb-sub { color: var(--err); }
```

- [ ] **Step 7: Run the tests and the type check**

Run: `cd frontend && npm test && npx tsc --noEmit -p tsconfig.app.json`
Expected: all PASS, including `IconButton.test.tsx` and `icons.test.tsx`.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/components/icons.tsx frontend/src/components/IconButton.tsx frontend/src/components/HeartbeatCard.tsx frontend/src/components/HeartbeatCard.test.tsx frontend/src/styles.css
git commit -m "feat(overview): HeartbeatCard stat card with Ping now"
```

---

### Task 8: Put the Heartbeat card on the Overview

**Files:**
- Modify: `frontend/src/views/OverviewView.tsx`
- Modify: `frontend/src/App.tsx` (new `handlePing`; the `<OverviewView>` element)
- Test: `frontend/src/views/OverviewView.test.tsx`

**Interfaces:**
- Consumes: `HeartbeatCard` (Task 7); `api.pingHeartbeat` (Task 6).
- Produces: `OverviewViewProps.onPing: () => Promise<void>`.

- [ ] **Step 1: Write the failing test**

In `frontend/src/views/OverviewView.test.tsx`, add `onPing={vi.fn()}` to BOTH `<OverviewView ... />` renders, then append inside the `describe`:

```tsx
  it('shows the Heartbeat card in place of Update Interval', () => {
    render(
      <OverviewView
        snapshot={snapshot}
        domains={[]}
        settings={snapshot.settings ?? null}
        incidentWindow={null}
        dayBuckets={buckets}
        nowMs={NOW_MS}
        onSelectDay={vi.fn()}
        onPing={vi.fn()}
      />,
    );
    expect(screen.queryByText('Update Interval')).toBeNull();
    expect(screen.getByText('Heartbeat')).toBeInTheDocument();
    expect(screen.getByText('Off')).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/views/OverviewView.test.tsx`
Expected: FAIL ("Update Interval" still rendered).

- [ ] **Step 3: Implement `OverviewView`**

In `frontend/src/views/OverviewView.tsx`:
- Add `onPing: () => Promise<void>;` to `OverviewViewProps` and destructure `onPing`.
- Add `import { HeartbeatCard } from '../components/HeartbeatCard';`.
- Delete the `intervalStr` and `clockIcon` constants.
- Remove `IconClock` from the icons import, and replace the utils import with `import type { DayBucket } from '../utils';`. `noUnusedLocals` fails otherwise.
- Replace the `<StatCard label="Update Interval" ... />` line with:

```tsx
        <HeartbeatCard
          status={snapshot?.heartbeat ?? null}
          url={settings?.heartbeat_url ?? null}
          interval={settings?.heartbeat_interval ?? 300}
          onPing={onPing}
        />
```

Keep `checkInterval`. `RecordHealthPanel` still uses it.

- [ ] **Step 4: Wire `App.tsx`**

Add after `handleRunHook`:

```tsx
  const handlePing = useCallback(async () => {
    try {
      await api.pingHeartbeat();
    } catch {
      pushToast('Ping request failed', 'error');
    }
  }, [pushToast]);
```

Add `onPing={handlePing}` to the `<OverviewView ... />` element.

- [ ] **Step 5: Run the tests and the type check**

Run: `cd frontend && npm test && npx tsc --noEmit -p tsconfig.app.json`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/views/OverviewView.tsx frontend/src/views/OverviewView.test.tsx frontend/src/App.tsx
git commit -m "feat(overview): replace Update Interval with the Heartbeat card"
```

---

### Task 9: Heartbeat panel in Settings

**Files:**
- Modify: `frontend/src/views/SettingsView.tsx`
- Modify: `frontend/src/App.tsx` (`handleSaveSettings` rethrows)
- Modify: `frontend/src/styles.css` (after the `.field-row` rule in the Fields section)
- Test: `frontend/src/views/SettingsView.test.tsx`

**Interfaces:**
- Consumes: `ApiError` (Task 6); `Settings.heartbeat_url` / `heartbeat_interval`.
- Produces: `SettingsViewProps.onSave: (patch: Partial<Settings>) => Promise<void>`. It rejects with the `ApiError` after App has shown its toast.

- [ ] **Step 1: Write the failing tests**

Replace `frontend/src/views/SettingsView.test.tsx` with:

```tsx
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SettingsView } from './SettingsView';
import { ApiError } from '../api';
import type { Settings } from '../types';

const settings: Settings = {
  check_interval: 300, ip_source: 'ipify', update_on_startup: true, retry_on_failure: true, notify: true,
  heartbeat_url: null, heartbeat_interval: 300,
};
const URL = 'https://hc-ping.com/5b1c7f0a';
const sources = [{ key: 'ipify', display_name: 'ipify' }];
const ok = () => vi.fn().mockResolvedValue(undefined);

function view(s: Settings, onSave = ok()) {
  const utils = render(<SettingsView settings={s} ipSources={sources} onSave={onSave} />);
  return { ...utils, onSave, input: screen.getByLabelText(/Ping URL/) as HTMLInputElement, save: screen.getByRole('button', { name: 'Save' }) };
}

describe('SettingsView', () => {
  it('marks the active interval chip and saves on change', () => {
    const { onSave } = view(settings);
    const group = screen.getByRole('group', { name: 'Check interval' });
    expect(within(group).getByRole('button', { name: '5 min' })).toHaveClass('active');
    fireEvent.click(within(group).getByRole('button', { name: '10 min' }));
    expect(onSave).toHaveBeenCalledWith({ check_interval: 600 });
  });

  it('populates ip-source options from props', () => {
    render(<SettingsView settings={settings} ipSources={[...sources, { key: 'icanhazip', display_name: 'icanhazip' }]} onSave={ok()} />);
    expect(screen.getByRole('option', { name: /icanhazip/ })).toBeInTheDocument();
  });

  it('enables Save only once the URL differs from the saved value', () => {
    const { input, save } = view(settings);
    expect(save).toBeDisabled();
    fireEvent.change(input, { target: { value: URL } });
    expect(save).toBeEnabled();
    fireEvent.change(input, { target: { value: '  ' } });
    expect(save).toBeDisabled();
  });

  it('saves the trimmed URL on Enter', () => {
    const { input, onSave } = view(settings);
    fireEvent.change(input, { target: { value: `  ${URL} ` } });
    fireEvent.submit(input.closest('form') as HTMLFormElement);
    expect(onSave).toHaveBeenCalledWith({ heartbeat_url: URL });
  });

  it('sends null when the URL is cleared', () => {
    const { input, save, onSave } = view({ ...settings, heartbeat_url: URL });
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.click(save);
    expect(onSave).toHaveBeenCalledWith({ heartbeat_url: null });
  });

  it('shows the field error inline until the draft changes', async () => {
    const onSave = vi.fn().mockRejectedValue(
      new ApiError('/api/settings -> 422', 422, { heartbeat_url: 'Input should be a valid URL' }));
    const { input, save } = view(settings, onSave);
    fireEvent.change(input, { target: { value: 'hc-ping.com/x' } });
    fireEvent.click(save);
    expect(await screen.findByText('Input should be a valid URL')).toBeInTheDocument();
    expect(input).toHaveAttribute('aria-invalid', 'true');
    fireEvent.change(input, { target: { value: 'https://hc-ping.com/x' } });
    expect(screen.queryByText('Input should be a valid URL')).toBeNull();
    expect(screen.getByText('Leave empty to disable.')).toBeInTheDocument();
    expect(input).not.toHaveAttribute('aria-invalid');
  });

  it('resets the draft to the saved (normalised) value', () => {
    const { rerender } = view(settings);
    rerender(<SettingsView settings={{ ...settings, heartbeat_url: 'https://hc-ping.com/' }} ipSources={sources} onSave={ok()} />);
    expect((screen.getByLabelText(/Ping URL/) as HTMLInputElement).value).toBe('https://hc-ping.com/');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('dims the heartbeat chips without a URL but still saves the interval', async () => {
    const { onSave } = view(settings);
    const group = screen.getByRole('group', { name: 'Heartbeat interval' });
    expect(group).toHaveClass('hb-dim');
    expect(within(group).getByRole('button', { name: '5 min' })).toHaveClass('active');
    fireEvent.click(within(group).getByRole('button', { name: '30 s' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ heartbeat_interval: 30 }));
  });

  it('does not dim the heartbeat chips once a URL is saved', () => {
    view({ ...settings, heartbeat_url: URL });
    expect(screen.getByRole('group', { name: 'Heartbeat interval' })).not.toHaveClass('hb-dim');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run src/views/SettingsView.test.tsx`
Expected: FAIL (no "Check interval" group, no Ping URL field).

- [ ] **Step 3: Implement `SettingsView`**

Rewrite `frontend/src/views/SettingsView.tsx`:

```tsx
import { useState, type JSX } from 'react';
import type { Settings } from '../types';
import { ApiError } from '../api';
import { Select } from '../components/Select';
import { SectionHeader } from '../components/SectionHeader';

export interface SettingsViewProps {
  settings: Settings | null;
  ipSources: { key: string; display_name: string }[];
  onSave: (patch: Partial<Settings>) => Promise<void>;
}

const INTERVALS = [
  { value: 60, label: '1 min' },
  { value: 300, label: '5 min' },
  { value: 600, label: '10 min' },
  { value: 1800, label: '30 min' },
  { value: 3600, label: '1 hr' },
];

const HEARTBEAT_INTERVALS = [
  { value: 30, label: '30 s' },
  { value: 60, label: '1 min' },
  { value: 300, label: '5 min' },
  { value: 900, label: '15 min' },
];

type Save = SettingsViewProps['onSave'];

// App has already toasted any failure; fire-and-forget controls just swallow it.
const fire = (onSave: Save, patch: Partial<Settings>) => { void onSave(patch).catch(() => undefined); };

function HeartbeatPanel({ settings, onSave }: { settings: Settings; onSave: Save }): JSX.Element {
  const saved = settings.heartbeat_url ?? '';
  const [draft, setDraft] = useState(saved);
  const [error, setError] = useState<string | null>(null);
  const dirty = draft.trim() !== saved;

  const submit = async () => {
    if (!dirty) return;
    try {
      await onSave({ heartbeat_url: draft.trim() || null });
    } catch (err) {
      setError(err instanceof ApiError ? err.fieldErrors.heartbeat_url ?? null : null);
    }
  };

  return (
    <div className="panel">
      <div className="settings-group">
        <div className="sg-title">Heartbeat</div>
        <div className="field">
          <label htmlFor="setHeartbeatUrl">
            Ping URL <span className="hint">— GET on every interval, while online</span>
          </label>
          <form className="hb-url" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
            <input
              id="setHeartbeatUrl"
              type="text"
              className={error ? 'hb-invalid' : undefined}
              aria-invalid={error ? true : undefined}
              aria-describedby="setHeartbeatUrlHelp"
              placeholder="https://hc-ping.com/your-uuid"
              spellCheck={false}
              autoComplete="off"
              value={draft}
              onChange={(e) => { setDraft(e.target.value); setError(null); }}
            />
            <button type="submit" className="btn btn-ghost" disabled={!dirty}>Save</button>
          </form>
          <div id="setHeartbeatUrlHelp" className={`field-help${error ? ' hb-error' : ''}`}>
            {error ?? 'Leave empty to disable.'}
          </div>
        </div>
        <div>
          <div className="sr-text" style={{ marginBottom: 10 }}>
            <span className="t">Interval</span>
            <span className="d">How often to ping while online.</span>
          </div>
          <div className={`chips${saved ? '' : ' hb-dim'}`} role="group" aria-label="Heartbeat interval">
            {HEARTBEAT_INTERVALS.map(({ value, label }) => (
              <button
                type="button"
                key={value}
                className={`chip${settings.heartbeat_interval === value ? ' active' : ''}`}
                onClick={() => fire(onSave, { heartbeat_interval: value })}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export function SettingsView({ settings, ipSources, onSave }: SettingsViewProps) {
  return (
    <>
      <SectionHeader title="Settings" />
      {settings === null ? (
        <div className="empty"><p>Loading settings…</p></div>
      ) : (
        <div className="settings-grid">
          <div className="panel">
            <div className="settings-group">
              <div className="sg-title">Scheduling</div>
              <div>
                <div className="sr-text" style={{ marginBottom: 10 }}>
                  <span className="t">Check interval</span>
                  <span className="d">How often to check for a public-IP change.</span>
                </div>
                <div className="chips" role="group" aria-label="Check interval">
                  {INTERVALS.map(({ value, label }) => (
                    <button
                      type="button"
                      key={value}
                      className={`chip${settings.check_interval === value ? ' active' : ''}`}
                      onClick={() => fire(onSave, { check_interval: value })}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>

          <div className="panel">
            <div className="settings-group">
              <div className="sg-title">Behavior</div>
              <div className="switch-row">
                <div className="sr-text">
                  <span className="t">Update on startup</span>
                  <span className="d">Force a sync when the service launches.</span>
                </div>
                <label className="switch">
                  <input
                    type="checkbox"
                    aria-label="Update on startup"
                    checked={settings.update_on_startup}
                    onChange={() => fire(onSave, { update_on_startup: !settings.update_on_startup })}
                  />
                  <span className="slider" />
                </label>
              </div>
              <div className="switch-row">
                <div className="sr-text">
                  <span className="t">Notifications</span>
                  <span className="d">Notify on IP change and update failures.</span>
                </div>
                <label className="switch">
                  <input
                    type="checkbox"
                    aria-label="Notifications"
                    checked={settings.notify}
                    onChange={() => fire(onSave, { notify: !settings.notify })}
                  />
                  <span className="slider" />
                </label>
              </div>
              <div className="switch-row">
                <div className="sr-text">
                  <span className="t">Retry on failure</span>
                  <span className="d">Auto-retry failed updates with backoff.</span>
                </div>
                <label className="switch">
                  <input
                    type="checkbox"
                    aria-label="Retry on failure"
                    checked={settings.retry_on_failure}
                    onChange={() => fire(onSave, { retry_on_failure: !settings.retry_on_failure })}
                  />
                  <span className="slider" />
                </label>
              </div>
            </div>
          </div>

          <div className="panel">
            <div className="settings-group">
              <div className="sg-title">IP source</div>
              <div className="field">
                <label htmlFor="setSource">
                  Primary source <span className="hint">— queried for the public IP</span>
                </label>
                <Select
                  id="setSource"
                  ariaLabel="Primary source"
                  value={settings.ip_source}
                  options={ipSources.map((s) => ({ value: s.key, label: s.display_name }))}
                  onChange={(ip_source) => fire(onSave, { ip_source })}
                />
              </div>
              <div className="field-help">
                Sources are pluggable; drop a new module in{' '}
                <code style={{ fontFamily: 'var(--mono)' }}>ip_sources/</code> to add one.
              </div>
            </div>
          </div>

          {/* Keyed on the saved URL so a save (incl. server normalisation) resets the draft. */}
          <HeartbeatPanel key={settings.heartbeat_url ?? ''} settings={settings} onSave={onSave} />
        </div>
      )}
    </>
  );
}
```

- [ ] **Step 4: Add the styles**

In `frontend/src/styles.css`, insert directly after the `.field-row { ... }` line:

```css
/* heartbeat URL: after the .field input rules so the invalid state wins over :focus */
.hb-url { display: flex; gap: 8px; }
.hb-url input[type="text"] { flex: 1; min-width: 0; font-family: var(--mono); font-size: 13px; }
.hb-url input.hb-invalid { border-color: var(--err); box-shadow: 0 0 0 3px var(--err-soft); }
.field-help.hb-error { color: var(--err); }
.chips.hb-dim { opacity: .45; }
```

- [ ] **Step 5: Make `handleSaveSettings` rethrow**

In `frontend/src/App.tsx`, change the `catch` in `handleSaveSettings` to:

```tsx
      } catch (err) {
        pushToast('Failed to save settings', 'error');
        throw err;
      }
```

- [ ] **Step 6: Run the tests and the type check**

Run: `cd frontend && npm test && npx tsc --noEmit -p tsconfig.app.json`
Expected: all PASS, with no "Unhandled Rejection" reported by vitest.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/views/SettingsView.tsx frontend/src/views/SettingsView.test.tsx frontend/src/App.tsx frontend/src/styles.css
git commit -m "feat(settings): Heartbeat panel with explicit save and inline validation"
```

---

### Task 10: End-to-end check of the 422 path and final gates

**Files:**
- Modify: `frontend/e2e/dashboard.spec.ts` (append)

**Interfaces:**
- Consumes: everything above. This is a real FastAPI + built SPA, served on :8123 with a temporary data home.

- [ ] **Step 1: Write the e2e test**

Append to `frontend/e2e/dashboard.spec.ts`:

```ts
test('heartbeat settings show the validation message inline', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Settings/ }).click();
  const url = page.getByLabel(/Ping URL/);
  await url.fill('hc-ping.com/x');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('#setHeartbeatUrlHelp')).toContainText(/valid URL/);
  await expect(url).toHaveAttribute('aria-invalid', 'true');
});

test('overview shows the heartbeat card as Off by default', async ({ page }) => {
  await page.goto('/');
  const card = page.locator('.stat').filter({ hasText: 'Heartbeat' });
  await expect(card).toContainText('Off');
  await expect(card.getByRole('button', { name: 'Ping now' })).toHaveCount(0);
});
```

- [ ] **Step 2: Run e2e**

Run: `cd frontend && npm run test:e2e`
Expected: all PASS. Port 8123 must be free, and the webServer builds the SPA and starts the backend.

- [ ] **Step 3: Run the full gates**

Run from the repo root:

```bash
source .venv/bin/activate
pytest test/ --cov=tether_ddns --cov-fail-under=90
flake8 tether_ddns/ test/ && ruff check . && mypy . && pyright
cd frontend && npm test && npx tsc --noEmit -p tsconfig.app.json
```

Expected: every command exits 0.

- [ ] **Step 4: Commit**

```bash
git add frontend/e2e/dashboard.spec.ts
git commit -m "test(e2e): heartbeat inline validation and default Off card"
```
