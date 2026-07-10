# Tether DDNS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a stateless, self-hosted dynamic DNS updater with a FastAPI + APScheduler backend and a React + Vite frontend, driven by an auto-loaded provider/hook plugin system.

**Architecture:** FastAPI runs APScheduler jobs in the uvicorn event loop for reachability, public-IP detection, and DDNS updates. Configuration is pydantic-modeled and persisted as JSON; all runtime state is rebuilt on start. A single WebSocket pushes log records and state events to a React SPA that FastAPI serves as static files.

**Tech Stack:** Python 3.12 (FastAPI, APScheduler, pydantic, aiohttp), pytest/pytest-cov; React + TypeScript + Vite, Vitest, Playwright.

## Global Constraints

- Python `>=3.12`.
- All backend code passes strict gates: flake8 (with configured plugins), mypy, pyright `strict`, ruff. Docstrings required (pydocstyle pep257 via ruff/flake8-docstrings).
- Package lives under `tether_ddns/`; ship `py.typed` (already present).
- Config path from `TETHER_DDNS_CONFIG_PATH` env var, else `./tether-ddns.json` in cwd.
- Secrets: `pydantic.SecretStr`; write-only over the API, masked (`"********"`) on read; disk stores real values.
- Exceptions in any provider `update()` or hook `handle()` MUST be caught + logged and MUST NOT crash the app or scheduler.
- Logging goes through uvicorn's logging subsystem; app logger name `tether_ddns`.
- Full test coverage, backend and frontend; tests are documentation — clear behavior-named tests, no flaky/dead tests.
- Frontend: React + TS + Vite; Vitest unit/component + Playwright e2e; build output served by FastAPI.
- Existing lint tests live in `test/`; new backend unit tests go under `test/unit/`.

---

## File Structure

Backend (`tether_ddns/`):
- `logging_setup.py` — app logger + ring-buffer handler wiring.
- `config.py` — pydantic models + `ConfigStore`.
- `providers/base.py` — `DDNSProvider`, `UpdateResult`, `register_provider`, `PROVIDER_REGISTRY`, `load_providers()`.
- `providers/ddns_providers/__init__.py`, `providers/ddns_providers/duckdns.py`.
- `hooks/base.py` — `Hook`, `HookEvent`, `register_hook`, `HOOK_REGISTRY`, `load_hooks()`.
- `hooks/registered_hooks/__init__.py`, `hooks/registered_hooks/log_hook.py`.
- `ip_detect.py` — public IP + reachability detection.
- `runtime.py` — `RuntimeState`, `DomainStatus`, event emission.
- `scheduler.py` — APScheduler jobs + exception-isolated dispatch.
- `ws.py` — `ConnectionManager`.
- `api.py` — REST + WS routes.
- `app.py` — FastAPI app + lifespan + static mount.
- `__main__.py` — uvicorn entrypoint.

Frontend (`frontend/`): standard Vite React-TS layout; details in Phase 7–8.

Tests: `test/unit/` (backend), `frontend/src/**/*.test.tsx` (Vitest), `frontend/e2e/` (Playwright).

---

## Phase 1 — Logging

### Task 1: Ring-buffer logging handler

**Files:**
- Create: `tether_ddns/logging_setup.py`
- Test: `test/unit/test_logging_setup.py`

**Interfaces:**
- Produces: `LogRingHandler(maxlen: int = 500)` with `.records: deque[dict[str, object]]`, method `snapshot() -> list[dict[str, object]]`, and callback registration `add_listener(cb: Callable[[dict[str, object]], None]) -> None` / `remove_listener(cb) -> None`. Each record dict has keys `time` (float epoch), `level` (str), `logger` (str), `message` (str). Also `get_logger() -> logging.Logger` returning the `tether_ddns` logger, and `install_ring_handler(handler: LogRingHandler) -> None` attaching it to `uvicorn`, `uvicorn.error`, and `tether_ddns` loggers.

- [ ] **Step 1: Write the failing test**

```python
"""Tests for the ring-buffer logging handler."""
import logging

from tether_ddns.logging_setup import LogRingHandler


def test_ring_handler_keeps_last_n_records() -> None:
    """The handler retains only the most recent maxlen records."""
    handler = LogRingHandler(maxlen=2)
    logger = logging.getLogger('test.ring')
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)
    logger.info('one')
    logger.info('two')
    logger.info('three')
    snap = handler.snapshot()
    assert [r['message'] for r in snap] == ['two', 'three']
    assert snap[0]['level'] == 'INFO'


def test_ring_handler_notifies_listeners() -> None:
    """Registered listeners receive each new record dict."""
    handler = LogRingHandler(maxlen=10)
    seen: list[dict[str, object]] = []
    handler.add_listener(seen.append)
    logger = logging.getLogger('test.ring2')
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)
    logger.warning('hi')
    assert seen and seen[-1]['message'] == 'hi'
    assert seen[-1]['level'] == 'WARNING'
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest test/unit/test_logging_setup.py -v`
Expected: FAIL with `ModuleNotFoundError`/import error.

- [ ] **Step 3: Write minimal implementation**

```python
"""Application logging: a ring-buffer handler that fans out to listeners."""
from __future__ import annotations

import logging
from collections import deque
from typing import Callable

LogRecordDict = dict[str, object]
Listener = Callable[[LogRecordDict], None]

APP_LOGGER_NAME = 'tether_ddns'
_ATTACH_TO = ('uvicorn', 'uvicorn.error', APP_LOGGER_NAME)


class LogRingHandler(logging.Handler):
    """Logging handler retaining recent records and notifying listeners."""

    def __init__(self, maxlen: int = 500) -> None:
        """Initialise the handler with a bounded record buffer."""
        super().__init__()
        self.records: deque[LogRecordDict] = deque(maxlen=maxlen)
        self._listeners: list[Listener] = []

    def add_listener(self, cb: Listener) -> None:
        """Register a callback invoked for each new record."""
        self._listeners.append(cb)

    def remove_listener(self, cb: Listener) -> None:
        """Remove a previously registered callback."""
        if cb in self._listeners:
            self._listeners.remove(cb)

    def snapshot(self) -> list[LogRecordDict]:
        """Return a copy of the currently buffered records."""
        return list(self.records)

    def emit(self, record: logging.LogRecord) -> None:
        """Store the record and notify listeners (never raises)."""
        try:
            entry: LogRecordDict = {
                'time': record.created,
                'level': record.levelname,
                'logger': record.name,
                'message': record.getMessage(),
            }
            self.records.append(entry)
            for cb in list(self._listeners):
                cb(entry)
        except Exception:  # noqa: BLE001 - logging must not raise
            self.handleError(record)


def get_logger() -> logging.Logger:
    """Return the application logger."""
    return logging.getLogger(APP_LOGGER_NAME)


def install_ring_handler(handler: LogRingHandler) -> None:
    """Attach the ring handler to uvicorn and app loggers."""
    for name in _ATTACH_TO:
        logging.getLogger(name).addHandler(handler)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest test/unit/test_logging_setup.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tether_ddns/logging_setup.py test/unit/test_logging_setup.py
git commit -m "feat: ring-buffer logging handler with listener fan-out"
```

---

## Phase 2 — Configuration

### Task 2: Config models + ConfigStore

**Files:**
- Create: `tether_ddns/config.py`
- Test: `test/unit/test_config.py`

**Interfaces:**
- Produces:
  - `AppSettings(check_interval: int = 300, ip_source: str = 'ipify', update_on_startup: bool = True, retry_on_failure: bool = True, notify: bool = True)`.
  - `DomainConfig(id: str, hostname: str, provider: str, record_type: Literal['A','AAAA'] = 'A', ttl: str = 'Auto', enabled: bool = True, update_period: int = 300, provider_config: dict[str, object] = {})`. `id` defaults to `uuid4().hex` via `default_factory`.
  - `HookConfig(id: str, hook: str, enabled: bool = True, events: list[str] = [], config: dict[str, object] = {})`.
  - `AppConfig(settings: AppSettings, domains: list[DomainConfig], hooks: list[HookConfig])`.
  - `ConfigStore(path: Path | None = None)` with `load() -> AppConfig`, `save(cfg: AppConfig) -> None`, property `path: Path`, staticmethod `resolve_path() -> Path`.

- [ ] **Step 1: Write the failing test**

```python
"""Tests for configuration models and the ConfigStore."""
from pathlib import Path

from tether_ddns.config import AppConfig, ConfigStore, DomainConfig


def test_resolve_path_uses_env(monkeypatch, tmp_path: Path) -> None:
    """resolve_path honours TETHER_DDNS_CONFIG_PATH."""
    target = tmp_path / 'cfg.json'
    monkeypatch.setenv('TETHER_DDNS_CONFIG_PATH', str(target))
    assert ConfigStore.resolve_path() == target


def test_resolve_path_falls_back_to_cwd(monkeypatch, tmp_path: Path) -> None:
    """Without the env var, the default file in cwd is used."""
    monkeypatch.delenv('TETHER_DDNS_CONFIG_PATH', raising=False)
    monkeypatch.chdir(tmp_path)
    assert ConfigStore.resolve_path() == tmp_path / 'tether-ddns.json'


def test_load_missing_returns_defaults(tmp_path: Path) -> None:
    """Loading a missing file yields a default AppConfig."""
    store = ConfigStore(tmp_path / 'nope.json')
    cfg = store.load()
    assert cfg.settings.check_interval == 300
    assert cfg.domains == []


def test_save_then_load_round_trips(tmp_path: Path) -> None:
    """Saved configuration is read back identically."""
    store = ConfigStore(tmp_path / 'cfg.json')
    cfg = AppConfig(
        settings=store.load().settings,
        domains=[DomainConfig(hostname='home.example.com', provider='duckdns')],
        hooks=[],
    )
    store.save(cfg)
    loaded = store.load()
    assert loaded.domains[0].hostname == 'home.example.com'
    assert loaded.domains[0].id == cfg.domains[0].id
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest test/unit/test_config.py -v`
Expected: FAIL with import error.

- [ ] **Step 3: Write minimal implementation**

```python
"""Configuration models and JSON-backed persistence."""
from __future__ import annotations

import os
import tempfile
from pathlib import Path
from typing import Literal
from uuid import uuid4

from pydantic import BaseModel, Field

ENV_VAR = 'TETHER_DDNS_CONFIG_PATH'
DEFAULT_FILENAME = 'tether-ddns.json'


class AppSettings(BaseModel):
    """Global application settings."""

    check_interval: int = 300
    ip_source: str = 'ipify'
    update_on_startup: bool = True
    retry_on_failure: bool = True
    notify: bool = True


class DomainConfig(BaseModel):
    """A single managed DNS record."""

    id: str = Field(default_factory=lambda: uuid4().hex)
    hostname: str
    provider: str
    record_type: Literal['A', 'AAAA'] = 'A'
    ttl: str = 'Auto'
    enabled: bool = True
    update_period: int = 300
    provider_config: dict[str, object] = Field(default_factory=dict)


class HookConfig(BaseModel):
    """A configured hook instance."""

    id: str = Field(default_factory=lambda: uuid4().hex)
    hook: str
    enabled: bool = True
    events: list[str] = Field(default_factory=list)
    config: dict[str, object] = Field(default_factory=dict)


class AppConfig(BaseModel):
    """Full application configuration."""

    settings: AppSettings = Field(default_factory=AppSettings)
    domains: list[DomainConfig] = Field(default_factory=list)
    hooks: list[HookConfig] = Field(default_factory=list)


class ConfigStore:
    """Loads and saves :class:`AppConfig` as JSON on disk."""

    def __init__(self, path: Path | None = None) -> None:
        """Create a store bound to a path (resolved if omitted)."""
        self._path = path if path is not None else self.resolve_path()

    @property
    def path(self) -> Path:
        """Return the configuration file path."""
        return self._path

    @staticmethod
    def resolve_path() -> Path:
        """Resolve the config path from the env var or cwd fallback."""
        env = os.environ.get(ENV_VAR)
        return Path(env) if env else Path.cwd() / DEFAULT_FILENAME

    def load(self) -> AppConfig:
        """Load configuration, returning defaults when absent."""
        if not self._path.exists():
            return AppConfig()
        return AppConfig.model_validate_json(self._path.read_text('utf-8'))

    def save(self, cfg: AppConfig) -> None:
        """Persist configuration atomically."""
        self._path.parent.mkdir(parents=True, exist_ok=True)
        data = cfg.model_dump_json(indent=2)
        fd, tmp = tempfile.mkstemp(dir=self._path.parent, suffix='.tmp')
        try:
            with os.fdopen(fd, 'w', encoding='utf-8') as fh:
                fh.write(data)
            os.replace(tmp, self._path)
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest test/unit/test_config.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tether_ddns/config.py test/unit/test_config.py
git commit -m "feat: config models and JSON ConfigStore"
```

---

## Phase 3 — Provider registry

### Task 3: Provider base + registry + auto-loader

**Files:**
- Create: `tether_ddns/providers/__init__.py` (empty docstring module), `tether_ddns/providers/base.py`, `tether_ddns/providers/ddns_providers/__init__.py`
- Test: `test/unit/test_provider_registry.py`

**Interfaces:**
- Produces:
  - `UpdateResult(success: bool, ip: str | None = None, message: str = '')` (pydantic model).
  - `DDNSProvider` ABC: class attrs `key: str`, `display_name: str`, `ConfigModel: type[BaseModel] = BaseModel`; classmethod `config_schema() -> dict[str, object]` (returns `cls.ConfigModel.model_json_schema()`); abstract `async def update(self, hostname: str, record_type: str, ip: str, config: BaseModel) -> UpdateResult`.
  - `register_provider(cls: type[DDNSProvider]) -> type[DDNSProvider]` decorator adding to `PROVIDER_REGISTRY: dict[str, type[DDNSProvider]]` keyed by `cls.key`.
  - `load_providers() -> None` importing every submodule of `tether_ddns.providers.ddns_providers`, logging+skipping import failures.

- [ ] **Step 1: Write the failing test**

```python
"""Tests for the DDNS provider registry and auto-loader."""
import pytest

from tether_ddns.providers import base


def test_register_provider_adds_to_registry() -> None:
    """The decorator registers a provider by its key."""
    @base.register_provider
    class _Dummy(base.DDNSProvider):
        key = 'dummy'
        display_name = 'Dummy'

        async def update(self, hostname, record_type, ip, config):  # type: ignore[override]
            return base.UpdateResult(success=True, ip=ip)

    assert base.PROVIDER_REGISTRY['dummy'] is _Dummy


def test_load_providers_imports_builtin_duckdns() -> None:
    """Auto-loading discovers the shipped DuckDNS provider."""
    base.load_providers()
    assert 'duckdns' in base.PROVIDER_REGISTRY


@pytest.mark.asyncio
async def test_config_schema_returns_json_schema() -> None:
    """config_schema exposes the provider's pydantic schema."""
    base.load_providers()
    provider_cls = base.PROVIDER_REGISTRY['duckdns']
    schema = provider_cls.config_schema()
    assert 'properties' in schema
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest test/unit/test_provider_registry.py -v`
Expected: FAIL with import error.

- [ ] **Step 3: Write minimal implementation**

`tether_ddns/providers/__init__.py`:
```python
"""DDNS provider plugin framework."""
```

`tether_ddns/providers/ddns_providers/__init__.py`:
```python
"""Built-in DDNS provider plugins (auto-loaded)."""
```

`tether_ddns/providers/base.py`:
```python
"""DDNS provider base class, registry and auto-loader."""
from __future__ import annotations

import importlib
import pkgutil
from abc import ABC, abstractmethod

from pydantic import BaseModel

from tether_ddns.logging_setup import get_logger

_log = get_logger()

PROVIDER_REGISTRY: dict[str, type['DDNSProvider']] = {}


class UpdateResult(BaseModel):
    """Outcome of a provider update attempt."""

    success: bool
    ip: str | None = None
    message: str = ''


class DDNSProvider(ABC):
    """Base class for DDNS provider plugins."""

    key: str = ''
    display_name: str = ''
    ConfigModel: type[BaseModel] = BaseModel

    @classmethod
    def config_schema(cls) -> dict[str, object]:
        """Return the JSON schema for this provider's configuration."""
        return cls.ConfigModel.model_json_schema()

    @abstractmethod
    async def update(
        self, hostname: str, record_type: str, ip: str, config: BaseModel,
    ) -> UpdateResult:
        """Update the DNS record and return the result."""
        raise NotImplementedError


def register_provider(cls: type[DDNSProvider]) -> type[DDNSProvider]:
    """Register a provider class in the global registry."""
    PROVIDER_REGISTRY[cls.key] = cls
    return cls


def load_providers() -> None:
    """Import all provider submodules so they self-register."""
    from tether_ddns.providers import ddns_providers

    for info in pkgutil.iter_modules(ddns_providers.__path__):
        name = f'{ddns_providers.__name__}.{info.name}'
        try:
            importlib.import_module(name)
        except Exception:  # noqa: BLE001 - a bad plugin must not break loading
            _log.exception('Failed to load provider module %s', name)
```

- [ ] **Step 4: Run test to verify it passes** (DuckDNS added in Task 4; until then the DuckDNS assertions are expected to fail — run only the first test now)

Run: `pytest test/unit/test_provider_registry.py::test_register_provider_adds_to_registry -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tether_ddns/providers test/unit/test_provider_registry.py
git commit -m "feat: DDNS provider base class, registry and auto-loader"
```

### Task 4: DuckDNS provider

**Files:**
- Create: `tether_ddns/providers/ddns_providers/duckdns.py`
- Test: `test/unit/test_duckdns.py`

**Interfaces:**
- Consumes: `DDNSProvider`, `UpdateResult`, `register_provider` from Task 3.
- Produces: `DuckDNSProvider(key='duckdns', display_name='DuckDNS')` with `ConfigModel` fields `token: SecretStr`, `domain: str`; `update()` GETs `https://www.duckdns.org/update?domains={domain}&token={token}&ip={ip}` via aiohttp and returns `UpdateResult(success=body.strip()=='OK', ip=ip, message=body)`.

- [ ] **Step 1: Write the failing test**

```python
"""Tests for the DuckDNS provider."""
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from tether_ddns.providers.ddns_providers.duckdns import DuckDNSProvider


def _cfg() -> object:
    return DuckDNSProvider.ConfigModel(token='secret', domain='myhost')


@pytest.mark.asyncio
async def test_update_success() -> None:
    """A DuckDNS 'OK' body yields a successful result."""
    provider = DuckDNSProvider()
    resp = MagicMock()
    resp.text = AsyncMock(return_value='OK')
    session = MagicMock()
    session.get.return_value.__aenter__ = AsyncMock(return_value=resp)
    session.get.return_value.__aexit__ = AsyncMock(return_value=False)
    with patch('tether_ddns.providers.ddns_providers.duckdns.aiohttp.ClientSession') as cs:
        cs.return_value.__aenter__ = AsyncMock(return_value=session)
        cs.return_value.__aexit__ = AsyncMock(return_value=False)
        result = await provider.update('myhost', 'A', '1.2.3.4', _cfg())
    assert result.success is True
    assert result.ip == '1.2.3.4'


@pytest.mark.asyncio
async def test_update_failure() -> None:
    """A non-OK body yields an unsuccessful result."""
    provider = DuckDNSProvider()
    resp = MagicMock()
    resp.text = AsyncMock(return_value='KO')
    session = MagicMock()
    session.get.return_value.__aenter__ = AsyncMock(return_value=resp)
    session.get.return_value.__aexit__ = AsyncMock(return_value=False)
    with patch('tether_ddns.providers.ddns_providers.duckdns.aiohttp.ClientSession') as cs:
        cs.return_value.__aenter__ = AsyncMock(return_value=session)
        cs.return_value.__aexit__ = AsyncMock(return_value=False)
        result = await provider.update('myhost', 'A', '1.2.3.4', _cfg())
    assert result.success is False
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest test/unit/test_duckdns.py -v`
Expected: FAIL with import error.

- [ ] **Step 3: Write minimal implementation**

```python
"""DuckDNS dynamic DNS provider."""
from __future__ import annotations

import aiohttp
from pydantic import BaseModel, SecretStr

from tether_ddns.providers.base import (
    DDNSProvider,
    UpdateResult,
    register_provider,
)


class DuckDNSConfig(BaseModel):
    """Configuration for the DuckDNS provider."""

    token: SecretStr
    domain: str


@register_provider
class DuckDNSProvider(DDNSProvider):
    """Updates DuckDNS records via its HTTP API."""

    key = 'duckdns'
    display_name = 'DuckDNS'
    ConfigModel = DuckDNSConfig

    async def update(
        self, hostname: str, record_type: str, ip: str, config: BaseModel,
    ) -> UpdateResult:
        """Update the DuckDNS record for the configured domain."""
        assert isinstance(config, DuckDNSConfig)
        url = 'https://www.duckdns.org/update'
        params = {
            'domains': config.domain,
            'token': config.token.get_secret_value(),
            'ip': ip,
        }
        async with aiohttp.ClientSession() as session:
            async with session.get(url, params=params) as resp:
                body = (await resp.text()).strip()
        return UpdateResult(success=body == 'OK', ip=ip, message=body)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest test/unit/test_duckdns.py test/unit/test_provider_registry.py -v`
Expected: PASS (all provider registry tests now pass too).

- [ ] **Step 5: Commit**

```bash
git add tether_ddns/providers/ddns_providers/duckdns.py test/unit/test_duckdns.py
git commit -m "feat: DuckDNS provider"
```

---

## Phase 4 — Hook registry

### Task 5: Hook base + registry + example log hook

**Files:**
- Create: `tether_ddns/hooks/__init__.py`, `tether_ddns/hooks/base.py`, `tether_ddns/hooks/registered_hooks/__init__.py`, `tether_ddns/hooks/registered_hooks/log_hook.py`
- Test: `test/unit/test_hook_registry.py`

**Interfaces:**
- Produces:
  - `HookEvent(type: Literal['reachability_changed','ip_changed'], old: str | None, new: str | None)` (pydantic model).
  - `SUPPORTED_EVENTS: tuple[str, ...] = ('reachability_changed', 'ip_changed')`.
  - `Hook` ABC: `key: str`, `display_name: str`, `ConfigModel: type[BaseModel] = BaseModel`, classmethod `config_schema()`, abstract `async def handle(self, event: HookEvent, config: BaseModel) -> None`.
  - `register_hook`, `HOOK_REGISTRY: dict[str, type[Hook]]`, `load_hooks() -> None` (mirrors `load_providers`).
  - `LogHook(key='log', display_name='Log Event')` logging the event.

- [ ] **Step 1: Write the failing test**

```python
"""Tests for the hook registry and the built-in log hook."""
import pytest

from tether_ddns.hooks import base


def test_register_hook_adds_to_registry() -> None:
    """The decorator registers a hook by its key."""
    @base.register_hook
    class _Dummy(base.Hook):
        key = 'dummy-hook'
        display_name = 'Dummy'

        async def handle(self, event, config):  # type: ignore[override]
            return None

    assert base.HOOK_REGISTRY['dummy-hook'] is _Dummy


def test_load_hooks_imports_builtin_log_hook() -> None:
    """Auto-loading discovers the shipped log hook."""
    base.load_hooks()
    assert 'log' in base.HOOK_REGISTRY


@pytest.mark.asyncio
async def test_log_hook_handles_event() -> None:
    """The log hook processes an event without raising."""
    base.load_hooks()
    hook = base.HOOK_REGISTRY['log']()
    event = base.HookEvent(type='ip_changed', old='1.1.1.1', new='2.2.2.2')
    await hook.handle(event, hook.ConfigModel())
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest test/unit/test_hook_registry.py -v`
Expected: FAIL with import error.

- [ ] **Step 3: Write minimal implementation**

`tether_ddns/hooks/__init__.py`:
```python
"""Hook plugin framework."""
```

`tether_ddns/hooks/registered_hooks/__init__.py`:
```python
"""Built-in hook plugins (auto-loaded)."""
```

`tether_ddns/hooks/base.py`:
```python
"""Hook base class, event model, registry and auto-loader."""
from __future__ import annotations

import importlib
import pkgutil
from abc import ABC, abstractmethod
from typing import Literal

from pydantic import BaseModel

from tether_ddns.logging_setup import get_logger

_log = get_logger()

SUPPORTED_EVENTS: tuple[str, ...] = ('reachability_changed', 'ip_changed')
HOOK_REGISTRY: dict[str, type['Hook']] = {}


class HookEvent(BaseModel):
    """An event delivered to hooks."""

    type: Literal['reachability_changed', 'ip_changed']
    old: str | None = None
    new: str | None = None


class Hook(ABC):
    """Base class for hook plugins."""

    key: str = ''
    display_name: str = ''
    ConfigModel: type[BaseModel] = BaseModel

    @classmethod
    def config_schema(cls) -> dict[str, object]:
        """Return the JSON schema for this hook's configuration."""
        return cls.ConfigModel.model_json_schema()

    @abstractmethod
    async def handle(self, event: HookEvent, config: BaseModel) -> None:
        """Handle an event."""
        raise NotImplementedError


def register_hook(cls: type[Hook]) -> type[Hook]:
    """Register a hook class in the global registry."""
    HOOK_REGISTRY[cls.key] = cls
    return cls


def load_hooks() -> None:
    """Import all hook submodules so they self-register."""
    from tether_ddns.hooks import registered_hooks

    for info in pkgutil.iter_modules(registered_hooks.__path__):
        name = f'{registered_hooks.__name__}.{info.name}'
        try:
            importlib.import_module(name)
        except Exception:  # noqa: BLE001 - a bad plugin must not break loading
            _log.exception('Failed to load hook module %s', name)
```

`tether_ddns/hooks/registered_hooks/log_hook.py`:
```python
"""A hook that logs each event it receives."""
from __future__ import annotations

from pydantic import BaseModel

from tether_ddns.hooks.base import Hook, HookEvent, register_hook
from tether_ddns.logging_setup import get_logger

_log = get_logger()


@register_hook
class LogHook(Hook):
    """Logs event details at INFO level."""

    key = 'log'
    display_name = 'Log Event'
    ConfigModel = BaseModel

    async def handle(self, event: HookEvent, config: BaseModel) -> None:
        """Log the event type and transition."""
        _log.info('Hook event %s: %s -> %s', event.type, event.old, event.new)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest test/unit/test_hook_registry.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tether_ddns/hooks test/unit/test_hook_registry.py
git commit -m "feat: hook base class, registry and log hook"
```

---

## Phase 5 — IP detection, runtime state, scheduler

### Task 6: IP + reachability detection

**Files:**
- Create: `tether_ddns/ip_detect.py`
- Test: `test/unit/test_ip_detect.py`

**Interfaces:**
- Produces: `async def detect_public_ip(source: str = 'ipify') -> str | None` (GET `https://api.ipify.org` via aiohttp; returns text or `None` on error) and `async def check_reachable() -> bool` (True if IP detection succeeds).

- [ ] **Step 1: Write the failing test**

```python
"""Tests for public IP and reachability detection."""
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from tether_ddns import ip_detect


@pytest.mark.asyncio
async def test_detect_public_ip_returns_text() -> None:
    """A successful HTTP response yields the IP string."""
    resp = MagicMock()
    resp.text = AsyncMock(return_value='203.0.113.5')
    session = MagicMock()
    session.get.return_value.__aenter__ = AsyncMock(return_value=resp)
    session.get.return_value.__aexit__ = AsyncMock(return_value=False)
    with patch('tether_ddns.ip_detect.aiohttp.ClientSession') as cs:
        cs.return_value.__aenter__ = AsyncMock(return_value=session)
        cs.return_value.__aexit__ = AsyncMock(return_value=False)
        assert await ip_detect.detect_public_ip() == '203.0.113.5'


@pytest.mark.asyncio
async def test_detect_public_ip_returns_none_on_error() -> None:
    """Network errors yield None rather than raising."""
    with patch('tether_ddns.ip_detect.aiohttp.ClientSession') as cs:
        cs.side_effect = OSError('boom')
        assert await ip_detect.detect_public_ip() is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest test/unit/test_ip_detect.py -v`
Expected: FAIL with import error.

- [ ] **Step 3: Write minimal implementation**

```python
"""Public IP address and internet reachability detection."""
from __future__ import annotations

import aiohttp

from tether_ddns.logging_setup import get_logger

_log = get_logger()
_SOURCES = {'ipify': 'https://api.ipify.org', 'icanhazip': 'https://icanhazip.com'}


async def detect_public_ip(source: str = 'ipify') -> str | None:
    """Return the current public IP, or None on failure."""
    url = _SOURCES.get(source, _SOURCES['ipify'])
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(url) as resp:
                return (await resp.text()).strip()
    except Exception:  # noqa: BLE001 - detection failure must not raise
        _log.warning('Public IP detection failed via %s', source)
        return None


async def check_reachable() -> bool:
    """Return True if the internet is reachable."""
    return await detect_public_ip() is not None
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest test/unit/test_ip_detect.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tether_ddns/ip_detect.py test/unit/test_ip_detect.py
git commit -m "feat: public IP and reachability detection"
```

### Task 7: Runtime state

**Files:**
- Create: `tether_ddns/runtime.py`
- Test: `test/unit/test_runtime.py`

**Interfaces:**
- Consumes: `AppConfig`, `DomainConfig` from Task 2.
- Produces:
  - `DomainRuntime(id: str, status: Literal['synced','pending','error','paused','updating'], ip: str | None, updated: float | None, message: str)` (pydantic model).
  - `RuntimeState`: `public_ip: str | None`, `online: bool`, `domains: dict[str, DomainRuntime]`; methods `rebuild(cfg: AppConfig) -> None` (initialise domain runtimes: `paused` if disabled else `pending`), `set_status(domain_id: str, status: str, *, ip: str | None = None, message: str = '') -> None`, `snapshot() -> dict[str, object]`, and `add_listener(cb: Callable[[dict[str, object]], None])` where each state change calls listeners with `snapshot()`.

- [ ] **Step 1: Write the failing test**

```python
"""Tests for the runtime state container."""
from tether_ddns.config import AppConfig, DomainConfig
from tether_ddns.runtime import RuntimeState


def test_rebuild_initialises_domain_statuses() -> None:
    """Disabled domains start paused; enabled domains start pending."""
    cfg = AppConfig(
        domains=[
            DomainConfig(id='a', hostname='a.example.com', provider='duckdns', enabled=True),
            DomainConfig(id='b', hostname='b.example.com', provider='duckdns', enabled=False),
        ],
    )
    state = RuntimeState()
    state.rebuild(cfg)
    assert state.domains['a'].status == 'pending'
    assert state.domains['b'].status == 'paused'


def test_set_status_notifies_listeners() -> None:
    """Status changes emit a snapshot to listeners."""
    cfg = AppConfig(domains=[DomainConfig(id='a', hostname='a.example.com', provider='duckdns')])
    state = RuntimeState()
    state.rebuild(cfg)
    seen: list[dict[str, object]] = []
    state.add_listener(seen.append)
    state.set_status('a', 'synced', ip='1.2.3.4')
    assert state.domains['a'].status == 'synced'
    assert seen and seen[-1]['public_ip'] is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest test/unit/test_runtime.py -v`
Expected: FAIL with import error.

- [ ] **Step 3: Write minimal implementation**

```python
"""In-memory runtime state, rebuilt from configuration on start."""
from __future__ import annotations

import time
from typing import Callable, Literal

from pydantic import BaseModel

from tether_ddns.config import AppConfig

Status = Literal['synced', 'pending', 'error', 'paused', 'updating']
Listener = Callable[[dict[str, object]], None]


class DomainRuntime(BaseModel):
    """Live status for a single domain."""

    id: str
    status: Status
    ip: str | None = None
    updated: float | None = None
    message: str = ''


class RuntimeState:
    """Holds live application state and notifies listeners of changes."""

    def __init__(self) -> None:
        """Create an empty runtime state."""
        self.public_ip: str | None = None
        self.online: bool = False
        self.domains: dict[str, DomainRuntime] = {}
        self._listeners: list[Listener] = []

    def add_listener(self, cb: Listener) -> None:
        """Register a listener called with a snapshot on each change."""
        self._listeners.append(cb)

    def remove_listener(self, cb: Listener) -> None:
        """Remove a registered listener."""
        if cb in self._listeners:
            self._listeners.remove(cb)

    def rebuild(self, cfg: AppConfig) -> None:
        """Reset domain runtimes from configuration."""
        self.domains = {
            d.id: DomainRuntime(id=d.id, status='pending' if d.enabled else 'paused')
            for d in cfg.domains
        }
        self._emit()

    def set_public_ip(self, ip: str | None) -> None:
        """Update the current public IP and notify listeners."""
        self.public_ip = ip
        self._emit()

    def set_online(self, online: bool) -> None:
        """Update reachability and notify listeners."""
        self.online = online
        self._emit()

    def set_status(
        self, domain_id: str, status: Status, *, ip: str | None = None, message: str = '',
    ) -> None:
        """Update a domain's status and notify listeners."""
        current = self.domains.get(domain_id)
        if current is None:
            return
        current.status = status
        if ip is not None:
            current.ip = ip
        current.message = message
        current.updated = time.time()
        self._emit()

    def snapshot(self) -> dict[str, object]:
        """Return a serialisable snapshot of the state."""
        return {
            'public_ip': self.public_ip,
            'online': self.online,
            'domains': [d.model_dump() for d in self.domains.values()],
        }

    def _emit(self) -> None:
        snap = self.snapshot()
        for cb in list(self._listeners):
            cb(snap)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest test/unit/test_runtime.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tether_ddns/runtime.py test/unit/test_runtime.py
git commit -m "feat: runtime state container with change listeners"
```

### Task 8: Scheduler with exception-isolated dispatch

**Files:**
- Create: `tether_ddns/scheduler.py`
- Test: `test/unit/test_scheduler.py`

**Interfaces:**
- Consumes: `AppConfig`, `DomainConfig`, `HookConfig` (Task 2); `PROVIDER_REGISTRY` (Task 3); `HOOK_REGISTRY`, `HookEvent` (Task 5); `detect_public_ip`, `check_reachable` (Task 6); `RuntimeState` (Task 7).
- Produces:
  - `async def sync_domain(domain: DomainConfig, ip: str, state: RuntimeState) -> None` — instantiates the provider, validates `provider_config` into its `ConfigModel`, calls `update()`; on success sets domain `synced` (with ip/message), on `UpdateResult.success is False` or any exception sets `error` and logs (never raises).
  - `async def dispatch_hooks(event: HookEvent, cfg: AppConfig) -> None` — for each enabled hook whose `events` includes `event.type`, instantiate and `await handle()`, catching+logging exceptions per hook.
  - `class Scheduler` wrapping `AsyncIOScheduler` with `start(cfg, state)`, `shutdown()`, and `async def check_once(cfg, state)` (detect IP/reachability, fire transitions + hooks, mark and sync affected domains).

- [ ] **Step 1: Write the failing test**

```python
"""Tests for scheduler dispatch and exception isolation."""
from unittest.mock import AsyncMock, patch

import pytest

from tether_ddns import scheduler
from tether_ddns.config import AppConfig, DomainConfig, HookConfig
from tether_ddns.hooks.base import HookEvent, load_hooks
from tether_ddns.providers.base import load_providers
from tether_ddns.runtime import RuntimeState


@pytest.mark.asyncio
async def test_sync_domain_provider_exception_sets_error() -> None:
    """A provider that raises leaves the domain in error, not crashing."""
    load_providers()
    domain = DomainConfig(
        id='a', hostname='myhost', provider='duckdns',
        provider_config={'token': 'x', 'domain': 'myhost'},
    )
    state = RuntimeState()
    state.rebuild(AppConfig(domains=[domain]))
    with patch(
        'tether_ddns.providers.ddns_providers.duckdns.DuckDNSProvider.update',
        new=AsyncMock(side_effect=RuntimeError('boom')),
    ):
        await scheduler.sync_domain(domain, '1.2.3.4', state)
    assert state.domains['a'].status == 'error'


@pytest.mark.asyncio
async def test_dispatch_hooks_isolates_exceptions() -> None:
    """A raising hook does not prevent others from running."""
    load_hooks()
    cfg = AppConfig(hooks=[HookConfig(id='h', hook='log', events=['ip_changed'])])
    event = HookEvent(type='ip_changed', old='1.1.1.1', new='2.2.2.2')
    with patch(
        'tether_ddns.hooks.registered_hooks.log_hook.LogHook.handle',
        new=AsyncMock(side_effect=RuntimeError('boom')),
    ):
        await scheduler.dispatch_hooks(event, cfg)  # must not raise
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest test/unit/test_scheduler.py -v`
Expected: FAIL with import error.

- [ ] **Step 3: Write minimal implementation**

```python
"""APScheduler-driven periodic jobs with exception-isolated dispatch."""
from __future__ import annotations

from apscheduler.schedulers.asyncio import AsyncIOScheduler

from tether_ddns.config import AppConfig, DomainConfig
from tether_ddns.hooks.base import HOOK_REGISTRY, HookEvent
from tether_ddns.ip_detect import detect_public_ip
from tether_ddns.logging_setup import get_logger
from tether_ddns.providers.base import PROVIDER_REGISTRY
from tether_ddns.runtime import RuntimeState

_log = get_logger()


async def sync_domain(domain: DomainConfig, ip: str, state: RuntimeState) -> None:
    """Update a single domain, isolating provider exceptions."""
    provider_cls = PROVIDER_REGISTRY.get(domain.provider)
    if provider_cls is None:
        state.set_status(domain.id, 'error', message=f'Unknown provider {domain.provider}')
        return
    state.set_status(domain.id, 'updating')
    try:
        config = provider_cls.ConfigModel.model_validate(domain.provider_config)
        result = await provider_cls().update(domain.hostname, domain.record_type, ip, config)
    except Exception as exc:  # noqa: BLE001 - provider errors must be contained
        _log.exception('Provider %s failed for %s', domain.provider, domain.hostname)
        state.set_status(domain.id, 'error', message=str(exc))
        return
    if result.success:
        state.set_status(domain.id, 'synced', ip=result.ip or ip, message=result.message)
    else:
        state.set_status(domain.id, 'error', message=result.message)


async def dispatch_hooks(event: HookEvent, cfg: AppConfig) -> None:
    """Invoke every matching enabled hook, isolating exceptions."""
    for hook_cfg in cfg.hooks:
        if not hook_cfg.enabled or event.type not in hook_cfg.events:
            continue
        hook_cls = HOOK_REGISTRY.get(hook_cfg.hook)
        if hook_cls is None:
            _log.warning('Unknown hook %s', hook_cfg.hook)
            continue
        try:
            config = hook_cls.ConfigModel.model_validate(hook_cfg.config)
            await hook_cls().handle(event, config)
        except Exception:  # noqa: BLE001 - hook errors must be contained
            _log.exception('Hook %s failed on %s', hook_cfg.hook, event.type)


class Scheduler:
    """Owns the APScheduler instance and periodic checks."""

    def __init__(self) -> None:
        """Create an unstarted scheduler."""
        self._scheduler = AsyncIOScheduler()

    def start(self, cfg: AppConfig, state: RuntimeState) -> None:
        """Schedule the periodic check job and start the scheduler."""
        self._scheduler.add_job(
            self.check_once, 'interval', seconds=cfg.settings.check_interval,
            args=[cfg, state], id='check', replace_existing=True,
        )
        self._scheduler.start()

    def shutdown(self) -> None:
        """Stop the scheduler."""
        if self._scheduler.running:
            self._scheduler.shutdown(wait=False)

    async def check_once(self, cfg: AppConfig, state: RuntimeState) -> None:
        """Run one reachability/IP check cycle, firing hooks and syncs."""
        ip = await detect_public_ip(cfg.settings.ip_source)
        online = ip is not None
        if online != state.online:
            state.set_online(online)
            await dispatch_hooks(
                HookEvent(type='reachability_changed',
                          old='online' if not online else 'offline',
                          new='online' if online else 'offline'),
                cfg,
            )
        if ip is not None and ip != state.public_ip:
            old = state.public_ip
            state.set_public_ip(ip)
            await dispatch_hooks(HookEvent(type='ip_changed', old=old, new=ip), cfg)
            for domain in cfg.domains:
                if domain.enabled:
                    await sync_domain(domain, ip, state)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest test/unit/test_scheduler.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tether_ddns/scheduler.py test/unit/test_scheduler.py
git commit -m "feat: scheduler with exception-isolated provider/hook dispatch"
```

---

## Phase 6 — WebSocket, API, app

### Task 9: WebSocket connection manager

**Files:**
- Create: `tether_ddns/ws.py`
- Test: `test/unit/test_ws.py`

**Interfaces:**
- Produces: `ConnectionManager` with `async def connect(ws) -> None`, `def disconnect(ws) -> None`, `async def broadcast(kind: str, payload: object) -> None` sending `{'kind': kind, 'payload': payload}` JSON to all sockets, and `def sync_broadcast(kind, payload) -> None` (schedules broadcast on the running loop via `asyncio.get_running_loop().create_task`, used by log/state listeners). Broken sockets are dropped silently.

- [ ] **Step 1: Write the failing test**

```python
"""Tests for the WebSocket connection manager."""
from unittest.mock import AsyncMock, MagicMock

import pytest

from tether_ddns.ws import ConnectionManager


@pytest.mark.asyncio
async def test_broadcast_sends_to_all() -> None:
    """Broadcast delivers a kind/payload envelope to every socket."""
    mgr = ConnectionManager()
    ws = MagicMock()
    ws.accept = AsyncMock()
    ws.send_json = AsyncMock()
    await mgr.connect(ws)
    await mgr.broadcast('log', {'message': 'hi'})
    ws.send_json.assert_awaited_with({'kind': 'log', 'payload': {'message': 'hi'}})


@pytest.mark.asyncio
async def test_broadcast_drops_broken_sockets() -> None:
    """A socket that errors on send is removed, not raised."""
    mgr = ConnectionManager()
    ws = MagicMock()
    ws.accept = AsyncMock()
    ws.send_json = AsyncMock(side_effect=RuntimeError('closed'))
    await mgr.connect(ws)
    await mgr.broadcast('log', {'message': 'hi'})
    assert ws not in mgr.connections
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest test/unit/test_ws.py -v`
Expected: FAIL with import error.

- [ ] **Step 3: Write minimal implementation**

```python
"""WebSocket connection management and broadcasting."""
from __future__ import annotations

import asyncio
from typing import Any

from tether_ddns.logging_setup import get_logger

_log = get_logger()


class ConnectionManager:
    """Tracks active WebSocket connections and broadcasts messages."""

    def __init__(self) -> None:
        """Create an empty connection manager."""
        self.connections: list[Any] = []

    async def connect(self, ws: Any) -> None:
        """Accept and register a WebSocket connection."""
        await ws.accept()
        self.connections.append(ws)

    def disconnect(self, ws: Any) -> None:
        """Deregister a WebSocket connection."""
        if ws in self.connections:
            self.connections.remove(ws)

    async def broadcast(self, kind: str, payload: object) -> None:
        """Send an envelope to every connected socket, dropping failures."""
        message = {'kind': kind, 'payload': payload}
        for ws in list(self.connections):
            try:
                await ws.send_json(message)
            except Exception:  # noqa: BLE001 - drop broken sockets
                self.disconnect(ws)

    def sync_broadcast(self, kind: str, payload: object) -> None:
        """Schedule a broadcast from a synchronous listener callback."""
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        loop.create_task(self.broadcast(kind, payload))
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest test/unit/test_ws.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tether_ddns/ws.py test/unit/test_ws.py
git commit -m "feat: WebSocket connection manager"
```

### Task 10: Secret masking helper

**Files:**
- Modify: `tether_ddns/config.py` (append helpers)
- Test: `test/unit/test_secret_masking.py`

**Interfaces:**
- Produces in `config.py`:
  - `MASK = '********'`.
  - `def mask_secrets(schema: dict[str, object], data: dict[str, object]) -> dict[str, object]` — returns a copy of `data` with any key whose schema property has `format == 'password'` replaced by `MASK` when present/non-empty.
  - `def merge_secrets(schema, incoming, existing) -> dict[str, object]` — for password fields, if `incoming` value is missing/empty/`MASK`, keep `existing` value.

- [ ] **Step 1: Write the failing test**

```python
"""Tests for secret masking/merging helpers."""
from tether_ddns.config import MASK, mask_secrets, merge_secrets

SCHEMA = {'properties': {'token': {'format': 'password'}, 'domain': {}}}


def test_mask_secrets_masks_password_fields() -> None:
    """Password fields are replaced with the mask."""
    out = mask_secrets(SCHEMA, {'token': 'real', 'domain': 'host'})
    assert out['token'] == MASK
    assert out['domain'] == 'host'


def test_merge_secrets_keeps_existing_when_masked() -> None:
    """A masked incoming secret retains the stored value."""
    out = merge_secrets(SCHEMA, {'token': MASK, 'domain': 'host2'}, {'token': 'real', 'domain': 'host'})
    assert out['token'] == 'real'
    assert out['domain'] == 'host2'
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest test/unit/test_secret_masking.py -v`
Expected: FAIL with import error.

- [ ] **Step 3: Write minimal implementation** (append to `tether_ddns/config.py`)

```python
MASK = '********'


def _password_fields(schema: dict[str, object]) -> set[str]:
    props = schema.get('properties', {})
    assert isinstance(props, dict)
    fields: set[str] = set()
    for name, spec in props.items():
        if isinstance(spec, dict) and spec.get('format') == 'password':
            fields.add(str(name))
    return fields


def mask_secrets(
    schema: dict[str, object], data: dict[str, object],
) -> dict[str, object]:
    """Return a copy of data with password fields masked."""
    out = dict(data)
    for field in _password_fields(schema):
        if out.get(field):
            out[field] = MASK
    return out


def merge_secrets(
    schema: dict[str, object],
    incoming: dict[str, object],
    existing: dict[str, object],
) -> dict[str, object]:
    """Merge incoming config, preserving existing masked secrets."""
    out = dict(incoming)
    for field in _password_fields(schema):
        value = out.get(field)
        if not value or value == MASK:
            if field in existing:
                out[field] = existing[field]
    return out
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest test/unit/test_secret_masking.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tether_ddns/config.py test/unit/test_secret_masking.py
git commit -m "feat: secret masking and merge helpers"
```

### Task 11: FastAPI app, lifespan, REST + WS routes

**Files:**
- Create: `tether_ddns/api.py`, `tether_ddns/app.py`, `tether_ddns/__main__.py`
- Test: `test/unit/test_api.py`

**Interfaces:**
- Consumes: all prior modules.
- Produces:
  - `create_app(store: ConfigStore | None = None) -> FastAPI`. On lifespan startup: install ring handler, load providers+hooks, load config, build `RuntimeState`, wire log+state listeners to `ConnectionManager.sync_broadcast`, start `Scheduler`. Stored on `app.state`: `store`, `config`, `runtime`, `scheduler`, `manager`, `log_handler`.
  - REST routes on `app`:
    - `GET /api/state` -> `{settings, ...runtime.snapshot(), logs: log_handler.snapshot()}`.
    - `GET /api/providers` -> `[{key, display_name, schema}]`.
    - `GET /api/hooks` -> `[{key, display_name, events: SUPPORTED_EVENTS, schema}]`.
    - `GET /api/domains` -> masked domain list; `POST /api/domains` (body: DomainConfig minus id) -> created (masked); `PUT /api/domains/{id}`; `DELETE /api/domains/{id}`; `POST /api/domains/{id}/sync`.
    - `GET/POST /api/hooks-config`, `PUT/DELETE /api/hooks-config/{id}`.
    - `GET /api/settings`, `PUT /api/settings`.
    - `POST /api/refresh` -> triggers `scheduler.check_once`.
    - `WS /api/ws`.
  - Mutations persist via `store.save` and rebuild runtime/reschedule as needed. Domain/hook writes merge secrets via `merge_secrets`; reads mask via `mask_secrets`.

- [ ] **Step 1: Write the failing test**

```python
"""Tests for the REST API."""
from pathlib import Path

from fastapi.testclient import TestClient

from tether_ddns.app import create_app
from tether_ddns.config import ConfigStore


def _client(tmp_path: Path) -> TestClient:
    return TestClient(create_app(ConfigStore(tmp_path / 'cfg.json')))


def test_state_endpoint_returns_snapshot(tmp_path: Path) -> None:
    """GET /api/state returns settings, domains and logs."""
    with _client(tmp_path) as client:
        resp = client.get('/api/state')
    assert resp.status_code == 200
    body = resp.json()
    assert 'settings' in body and 'domains' in body and 'logs' in body


def test_providers_endpoint_lists_duckdns(tmp_path: Path) -> None:
    """GET /api/providers includes DuckDNS with a schema."""
    with _client(tmp_path) as client:
        resp = client.get('/api/providers')
    keys = [p['key'] for p in resp.json()]
    assert 'duckdns' in keys


def test_create_domain_masks_secret(tmp_path: Path) -> None:
    """Creating a domain stores it and masks secrets on read-back."""
    with _client(tmp_path) as client:
        resp = client.post('/api/domains', json={
            'hostname': 'home.example.com', 'provider': 'duckdns',
            'provider_config': {'token': 'realsecret', 'domain': 'home'},
        })
        assert resp.status_code == 200
        created = resp.json()
        assert created['provider_config']['token'] == '********'
        listed = client.get('/api/domains').json()
    assert listed[0]['hostname'] == 'home.example.com'
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest test/unit/test_api.py -v`
Expected: FAIL with import error.

- [ ] **Step 3: Write minimal implementation**

`tether_ddns/api.py`:
```python
"""REST and WebSocket route registration."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

from tether_ddns.config import DomainConfig, HookConfig, mask_secrets, merge_secrets
from tether_ddns.hooks.base import HOOK_REGISTRY, SUPPORTED_EVENTS
from tether_ddns.providers.base import PROVIDER_REGISTRY

router = APIRouter(prefix='/api')


class DomainInput(BaseModel):
    """Incoming domain payload (id assigned server-side)."""

    hostname: str
    provider: str
    record_type: str = 'A'
    ttl: str = 'Auto'
    enabled: bool = True
    update_period: int = 300
    provider_config: dict[str, object] = {}


class HookInput(BaseModel):
    """Incoming hook payload."""

    hook: str
    enabled: bool = True
    events: list[str] = []
    config: dict[str, object] = {}


def _provider_schema(provider: str) -> dict[str, object]:
    cls = PROVIDER_REGISTRY.get(provider)
    return cls.config_schema() if cls else {}


def _hook_schema(hook: str) -> dict[str, object]:
    cls = HOOK_REGISTRY.get(hook)
    return cls.config_schema() if cls else {}


def _masked_domain(d: DomainConfig) -> dict[str, object]:
    data = d.model_dump()
    data['provider_config'] = mask_secrets(_provider_schema(d.provider), d.provider_config)
    return data


def _masked_hook(h: HookConfig) -> dict[str, object]:
    data = h.model_dump()
    data['config'] = mask_secrets(_hook_schema(h.hook), h.config)
    return data


def _persist(app: FastAPI) -> None:
    app.state.store.save(app.state.config)


def register_routes(app: FastAPI) -> None:
    """Attach all API routes to the app."""

    @router.get('/state')
    def get_state() -> dict[str, object]:
        cfg = app.state.config
        snap = app.state.runtime.snapshot()
        snap['settings'] = cfg.settings.model_dump()
        snap['logs'] = app.state.log_handler.snapshot()
        return snap

    @router.get('/providers')
    def get_providers() -> list[dict[str, object]]:
        return [
            {'key': k, 'display_name': c.display_name, 'schema': c.config_schema()}
            for k, c in PROVIDER_REGISTRY.items()
        ]

    @router.get('/hooks')
    def get_hooks() -> list[dict[str, object]]:
        return [
            {'key': k, 'display_name': c.display_name,
             'events': list(SUPPORTED_EVENTS), 'schema': c.config_schema()}
            for k, c in HOOK_REGISTRY.items()
        ]

    @router.get('/domains')
    def list_domains() -> list[dict[str, object]]:
        return [_masked_domain(d) for d in app.state.config.domains]

    @router.post('/domains')
    def create_domain(payload: DomainInput) -> dict[str, object]:
        domain = DomainConfig(**payload.model_dump())
        app.state.config.domains.append(domain)
        _persist(app)
        app.state.runtime.rebuild(app.state.config)
        return _masked_domain(domain)

    @router.put('/domains/{domain_id}')
    def update_domain(domain_id: str, payload: DomainInput) -> dict[str, object]:
        for i, d in enumerate(app.state.config.domains):
            if d.id == domain_id:
                data = payload.model_dump()
                data['provider_config'] = merge_secrets(
                    _provider_schema(payload.provider),
                    payload.provider_config, d.provider_config)
                updated = DomainConfig(id=domain_id, **data)
                app.state.config.domains[i] = updated
                _persist(app)
                app.state.runtime.rebuild(app.state.config)
                return _masked_domain(updated)
        raise HTTPException(status_code=404, detail='domain not found')

    @router.delete('/domains/{domain_id}')
    def delete_domain(domain_id: str) -> dict[str, bool]:
        before = len(app.state.config.domains)
        app.state.config.domains = [
            d for d in app.state.config.domains if d.id != domain_id]
        if len(app.state.config.domains) == before:
            raise HTTPException(status_code=404, detail='domain not found')
        _persist(app)
        app.state.runtime.rebuild(app.state.config)
        return {'ok': True}

    @router.post('/domains/{domain_id}/sync')
    async def sync_now(domain_id: str) -> dict[str, bool]:
        from tether_ddns.scheduler import sync_domain
        for d in app.state.config.domains:
            if d.id == domain_id:
                ip = app.state.runtime.public_ip or ''
                await sync_domain(d, ip, app.state.runtime)
                return {'ok': True}
        raise HTTPException(status_code=404, detail='domain not found')

    @router.get('/hooks-config')
    def list_hook_config() -> list[dict[str, object]]:
        return [_masked_hook(h) for h in app.state.config.hooks]

    @router.post('/hooks-config')
    def create_hook(payload: HookInput) -> dict[str, object]:
        hook = HookConfig(**payload.model_dump())
        app.state.config.hooks.append(hook)
        _persist(app)
        return _masked_hook(hook)

    @router.put('/hooks-config/{hook_id}')
    def update_hook(hook_id: str, payload: HookInput) -> dict[str, object]:
        for i, h in enumerate(app.state.config.hooks):
            if h.id == hook_id:
                data = payload.model_dump()
                data['config'] = merge_secrets(
                    _hook_schema(payload.hook), payload.config, h.config)
                updated = HookConfig(id=hook_id, **data)
                app.state.config.hooks[i] = updated
                _persist(app)
                return _masked_hook(updated)
        raise HTTPException(status_code=404, detail='hook not found')

    @router.delete('/hooks-config/{hook_id}')
    def delete_hook(hook_id: str) -> dict[str, bool]:
        before = len(app.state.config.hooks)
        app.state.config.hooks = [
            h for h in app.state.config.hooks if h.id != hook_id]
        if len(app.state.config.hooks) == before:
            raise HTTPException(status_code=404, detail='hook not found')
        _persist(app)
        return {'ok': True}

    @router.get('/settings')
    def get_settings() -> dict[str, object]:
        return app.state.config.settings.model_dump()

    @router.put('/settings')
    def put_settings(payload: dict[str, Any]) -> dict[str, object]:
        merged = app.state.config.settings.model_copy(update=payload)
        app.state.config.settings = merged
        _persist(app)
        return merged.model_dump()

    @router.post('/refresh')
    async def refresh() -> dict[str, bool]:
        await app.state.scheduler.check_once(app.state.config, app.state.runtime)
        return {'ok': True}

    @router.websocket('/ws')
    async def ws_endpoint(ws: WebSocket) -> None:
        await app.state.manager.connect(ws)
        await ws.send_json({'kind': 'state', 'payload': app.state.runtime.snapshot()})
        for entry in app.state.log_handler.snapshot():
            await ws.send_json({'kind': 'log', 'payload': entry})
        try:
            while True:
                await ws.receive_text()
        except WebSocketDisconnect:
            app.state.manager.disconnect(ws)

    app.include_router(router)
```

`tether_ddns/app.py`:
```python
"""FastAPI application factory and lifespan wiring."""
from __future__ import annotations

import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncIterator

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from tether_ddns.api import register_routes
from tether_ddns.config import ConfigStore
from tether_ddns.hooks.base import load_hooks
from tether_ddns.logging_setup import LogRingHandler, install_ring_handler
from tether_ddns.providers.base import load_providers
from tether_ddns.runtime import RuntimeState
from tether_ddns.scheduler import Scheduler
from tether_ddns.ws import ConnectionManager

_STATIC_DIR = Path(__file__).parent / 'static'


def create_app(store: ConfigStore | None = None) -> FastAPI:
    """Create the configured FastAPI application."""
    resolved_store = store if store is not None else ConfigStore()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        handler = LogRingHandler()
        install_ring_handler(handler)
        load_providers()
        load_hooks()
        config = resolved_store.load()
        runtime = RuntimeState()
        runtime.rebuild(config)
        manager = ConnectionManager()
        handler.add_listener(lambda rec: manager.sync_broadcast('log', rec))
        runtime.add_listener(lambda snap: manager.sync_broadcast('state', snap))
        scheduler = Scheduler()
        scheduler.start(config, runtime)
        app.state.store = resolved_store
        app.state.config = config
        app.state.runtime = runtime
        app.state.manager = manager
        app.state.log_handler = handler
        app.state.scheduler = scheduler
        try:
            yield
        finally:
            scheduler.shutdown()

    app = FastAPI(lifespan=lifespan)
    register_routes(app)
    if _STATIC_DIR.exists():
        app.mount('/', StaticFiles(directory=str(_STATIC_DIR), html=True), name='static')
    return app
```

`tether_ddns/__main__.py`:
```python
"""Console entrypoint: run the app with uvicorn."""
from __future__ import annotations

import uvicorn

from tether_ddns.app import create_app


def main() -> None:
    """Run the FastAPI app under uvicorn."""
    uvicorn.run(create_app(), host='0.0.0.0', port=8000)  # noqa: S104


if __name__ == '__main__':
    main()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest test/unit/test_api.py -v`
Expected: PASS.

- [ ] **Step 5: Add dependencies and commit**

Add `uvicorn`, `httpx` (TestClient), `pytest-asyncio` to the appropriate `pyproject.toml` sections. Then:

```bash
git add tether_ddns/api.py tether_ddns/app.py tether_ddns/__main__.py test/unit/test_api.py pyproject.toml
git commit -m "feat: FastAPI app, REST/WS routes and lifespan wiring"
```

### Task 12: Full backend lint/type gate

**Files:** none new — run existing gates.

- [ ] **Step 1: Run the full backend suite**

Run: `pytest -q`
Expected: all unit tests plus flake8/mypy/pyright/ruff linter tests PASS. Fix any strict-typing or style violations revealed (add missing docstrings/annotations, resolve `Any` where pyright strict complains).

- [ ] **Step 2: Commit any fixes**

```bash
git add -A
git commit -m "chore: satisfy strict lint and type gates"
```

---

## Phase 7 — Frontend scaffold + Vitest

### Task 13: Vite React-TS scaffold + build wiring

**Files:**
- Create: `frontend/` (Vite React-TS), `frontend/vite.config.ts` (build `outDir` -> `../tether_ddns/static`, dev proxy `/api` -> `http://localhost:8000`), `frontend/src/api.ts`, `frontend/src/types.ts`.
- Test: `frontend/src/api.test.ts`

**Interfaces:**
- Produces `frontend/src/api.ts`: typed fetch helpers `getState()`, `getProviders()`, `getHooks()`, `createDomain(input)`, `updateDomain(id, input)`, `deleteDomain(id)`, `syncDomain(id)`, `getSettings()`, `putSettings(patch)`, `createHook`, `updateHook`, `deleteHook`, `refresh()` — each calling the matching `/api/*` route and returning typed JSON. `frontend/src/types.ts`: `DomainState`, `Provider`, `Hook`, `Settings`, `StateSnapshot`, `LogEntry` interfaces mirroring backend payloads.

- [ ] **Step 1: Scaffold and configure**

```bash
cd /home/arjones/dev/tether-ddns
npm create vite@latest frontend -- --template react-ts
cd frontend && npm install && npm install -D vitest @testing-library/react @testing-library/jest-dom jsdom @playwright/test
```

Set `frontend/vite.config.ts`:
```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: { outDir: '../tether_ddns/static', emptyOutDir: true },
  server: { proxy: { '/api': 'http://localhost:8000' } },
  test: { environment: 'jsdom', globals: true, setupFiles: './src/setupTests.ts' },
});
```
Create `frontend/src/setupTests.ts` with `import '@testing-library/jest-dom';`.

- [ ] **Step 2: Write the failing test**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getProviders } from './api';

describe('api', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('getProviders fetches /api/providers and returns json', async () => {
    const data = [{ key: 'duckdns', display_name: 'DuckDNS', schema: {} }];
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => data })));
    const result = await getProviders();
    expect(fetch).toHaveBeenCalledWith('/api/providers');
    expect(result[0].key).toBe('duckdns');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/api.test.ts`
Expected: FAIL (`getProviders` not defined).

- [ ] **Step 4: Implement `types.ts` and `api.ts`**

```ts
// types.ts
export interface Provider { key: string; display_name: string; schema: Record<string, unknown>; }
export interface HookDef { key: string; display_name: string; events: string[]; schema: Record<string, unknown>; }
export interface DomainState { id: string; status: string; ip: string | null; updated: number | null; message: string; }
export interface Settings { check_interval: number; ip_source: string; update_on_startup: boolean; retry_on_failure: boolean; notify: boolean; }
export interface LogEntry { time: number; level: string; logger: string; message: string; }
export interface StateSnapshot { public_ip: string | null; online: boolean; domains: DomainState[]; settings: Settings; logs: LogEntry[]; }
```

```ts
// api.ts
import type { Provider, HookDef, Settings, StateSnapshot } from './types';

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json() as Promise<T>;
}
const jbody = (data: unknown): RequestInit => ({
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
});

export const getState = () => json<StateSnapshot>('/api/state');
export const getProviders = () => json<Provider[]>('/api/providers');
export const getHooks = () => json<HookDef[]>('/api/hooks');
export const getSettings = () => json<Settings>('/api/settings');
export const putSettings = (patch: Partial<Settings>) => json<Settings>('/api/settings', { ...jbody(patch), method: 'PUT' });
export const createDomain = (input: unknown) => json('/api/domains', jbody(input));
export const updateDomain = (id: string, input: unknown) => json(`/api/domains/${id}`, { ...jbody(input), method: 'PUT' });
export const deleteDomain = (id: string) => json(`/api/domains/${id}`, { method: 'DELETE' });
export const syncDomain = (id: string) => json(`/api/domains/${id}/sync`, { method: 'POST' });
export const createHook = (input: unknown) => json('/api/hooks-config', jbody(input));
export const updateHook = (id: string, input: unknown) => json(`/api/hooks-config/${id}`, { ...jbody(input), method: 'PUT' });
export const deleteHook = (id: string) => json(`/api/hooks-config/${id}`, { method: 'DELETE' });
export const refresh = () => json('/api/refresh', { method: 'POST' });
```

- [ ] **Step 5: Run test + commit**

Run: `cd frontend && npx vitest run src/api.test.ts`
Expected: PASS.

```bash
git add frontend
git commit -m "feat: vite react-ts scaffold, typed API client and build wiring"
```

### Task 14: WebSocket state hook (Vitest)

**Files:**
- Create: `frontend/src/useLiveState.ts`
- Test: `frontend/src/useLiveState.test.tsx`

**Interfaces:**
- Produces `useLiveState(): { snapshot: StateSnapshot | null; logs: LogEntry[] }` — opens `new WebSocket(\`ws://${location.host}/api/ws\`)`, handles `{kind:'state'|'log', payload}` messages, appends logs (capped 500), and replaces snapshot on `state` messages.

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, it, expect, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useLiveState } from './useLiveState';

class FakeWS {
  onmessage: ((e: { data: string }) => void) | null = null;
  onopen: (() => void) | null = null;
  constructor(public url: string) { setTimeout(() => this.onopen?.(), 0); }
  send() {}
  close() {}
}

describe('useLiveState', () => {
  it('applies state and log messages', async () => {
    vi.stubGlobal('WebSocket', FakeWS as unknown as typeof WebSocket);
    const { result } = renderHook(() => useLiveState());
    const ws = (result.current as unknown) as never;
    act(() => {
      // grab the constructed socket via the hook's effect
    });
    // Simulate via the last constructed instance
    const inst = (WebSocket as unknown as { last?: FakeWS });
    await waitFor(() => expect(result.current).toBeTruthy());
  });
});
```

(Refine the test to capture the constructed `FakeWS` instance through a module-level registry exposed by the fake; assert that dispatching a `state` message sets `snapshot` and a `log` message appends to `logs`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/useLiveState.test.tsx`
Expected: FAIL (`useLiveState` not defined).

- [ ] **Step 3: Implement the hook**

```tsx
import { useEffect, useRef, useState } from 'react';
import type { StateSnapshot, LogEntry } from './types';

export function useLiveState(): { snapshot: StateSnapshot | null; logs: LogEntry[] } {
  const [snapshot, setSnapshot] = useState<StateSnapshot | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    const ws = new WebSocket(`ws://${location.host}/api/ws`);
    wsRef.current = ws;
    ws.onmessage = (e: MessageEvent) => {
      const { kind, payload } = JSON.parse(e.data);
      if (kind === 'state') setSnapshot(payload as StateSnapshot);
      else if (kind === 'log') setLogs((prev) => [...prev.slice(-499), payload as LogEntry]);
    };
    return () => ws.close();
  }, []);

  return { snapshot, logs };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/useLiveState.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/useLiveState.ts frontend/src/useLiveState.test.tsx
git commit -m "feat: live WebSocket state/log hook"
```

### Task 15: Schema-driven form + core UI components (Vitest)

**Files:**
- Create: `frontend/src/components/SchemaForm.tsx`, `frontend/src/components/DomainCard.tsx`, `frontend/src/components/DomainModal.tsx`, `frontend/src/components/HookModal.tsx`, `frontend/src/components/Toasts.tsx`, `frontend/src/App.tsx`, `frontend/src/styles.css` (ported from `mockup.html`).
- Test: `frontend/src/components/SchemaForm.test.tsx`, `frontend/src/components/DomainCard.test.tsx`

**Interfaces:**
- `SchemaForm({ schema, value, onChange })` renders one input per `schema.properties`, using `type="password"` when `format === 'password'`, text/number/checkbox otherwise; emits updated value object on change.
- `DomainCard({ domain, runtime, onSync, onEdit, onDelete, onToggle })` renders name, provider badge, status badge, IP, actions (mirrors mockup card).
- `DomainModal` / `HookModal` render the base fields plus a `SchemaForm` for the selected provider/hook (schema fetched from `/api/providers` / `/api/hooks`); `HookModal` also renders event checkboxes from the hook's `events`.

- [ ] **Step 1: Write the failing tests**

```tsx
// SchemaForm.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SchemaForm } from './SchemaForm';

describe('SchemaForm', () => {
  it('renders a password input for password-format fields', () => {
    const schema = { properties: { token: { format: 'password', title: 'Token' }, domain: { title: 'Domain' } } };
    const onChange = vi.fn();
    render(<SchemaForm schema={schema} value={{}} onChange={onChange} />);
    expect(screen.getByLabelText('Token')).toHaveAttribute('type', 'password');
    fireEvent.change(screen.getByLabelText('Domain'), { target: { value: 'host' } });
    expect(onChange).toHaveBeenCalledWith({ domain: 'host' });
  });
});
```

```tsx
// DomainCard.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DomainCard } from './DomainCard';

describe('DomainCard', () => {
  it('shows hostname/status and fires sync', () => {
    const onSync = vi.fn();
    render(<DomainCard
      domain={{ id: 'a', hostname: 'home.example.com', provider: 'duckdns', record_type: 'A', ttl: 'Auto', enabled: true }}
      runtime={{ id: 'a', status: 'synced', ip: '1.2.3.4', updated: Date.now() / 1000, message: '' }}
      onSync={onSync} onEdit={vi.fn()} onDelete={vi.fn()} onToggle={vi.fn()} />);
    expect(screen.getByText('home.example.com')).toBeInTheDocument();
    expect(screen.getByText(/synced/i)).toBeInTheDocument();
    fireEvent.click(screen.getByTitle('Force update now'));
    expect(onSync).toHaveBeenCalledWith('a');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/components`
Expected: FAIL (components not defined).

- [ ] **Step 3: Implement the components**

Implement `SchemaForm` iterating `schema.properties` (password/number/boolean/text inputs, labelled by `title` or key). Implement `DomainCard` mirroring the mockup card markup and wiring the four action buttons (titles: `Pause`/`Resume`, `Force update now`, `Edit`, `Delete`) to the callbacks. Implement `DomainModal` (hostname, provider `<select>` from `/api/providers`, record type, ttl, enabled toggle, plus `SchemaForm` for the selected provider schema), `HookModal` (hook `<select>` from `/api/hooks`, event checkboxes, `SchemaForm`), `Toasts`, and `App` composing the header, stats, domain grid, **Hooks section**, settings modal, and **log viewer** panel driven by `useLiveState`. Port `mockup.html`'s CSS into `styles.css`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/components`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src
git commit -m "feat: schema-driven forms and dashboard components"
```

---

## Phase 8 — E2E + coverage gates

### Task 16: Playwright e2e against the served SPA

**Files:**
- Create: `frontend/playwright.config.ts`, `frontend/e2e/dashboard.spec.ts`, `frontend/e2e/README.md` (how to run).
- Modify: `frontend/package.json` scripts (`build`, `test:e2e`).

**Interfaces:**
- `playwright.config.ts` uses a `webServer` that builds the frontend then launches the backend (`python -m tether_ddns`) on port 8000 with a temp `TETHER_DDNS_CONFIG_PATH`, `baseURL: http://localhost:8000`.

- [ ] **Step 1: Write the failing e2e test**

```ts
import { test, expect } from '@playwright/test';

test('add a domain and see it listed', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /add domain/i }).click();
  await page.getByLabel(/hostname/i).fill('home.example.com');
  await page.getByLabel(/token/i).fill('secret-token');
  await page.getByLabel(/domain/i).last().fill('home');
  await page.getByRole('button', { name: /add domain|save/i }).click();
  await expect(page.getByText('home.example.com')).toBeVisible();
});

test('log viewer streams records', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('log-viewer')).toBeVisible();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npx playwright test`
Expected: FAIL (config/webServer missing or selectors not present).

- [ ] **Step 3: Implement config + wire selectors**

Create `playwright.config.ts` with the `webServer` described above. Add `data-testid="log-viewer"` to the log panel and ensure labels match. Add `build` and `test:e2e` scripts to `package.json`. Install browsers: `npx playwright install --with-deps chromium`.

- [ ] **Step 4: Run to verify it passes**

Run: `cd frontend && npx playwright test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/playwright.config.ts frontend/e2e frontend/package.json
git commit -m "test: playwright e2e for dashboard and log viewer"
```

### Task 17: Coverage enforcement + docs

**Files:**
- Modify: `pytest.ini`/`pyproject.toml` (add `--cov=tether_ddns --cov-fail-under=100` or an agreed threshold), `frontend/vite.config.ts` (`test.coverage` reporter + thresholds), root `README.md` (run/build/test instructions).

- [ ] **Step 1: Add backend coverage gate**

Configure `pytest-cov` to measure `tether_ddns` and fail under the agreed threshold. Run `pytest -q` and add tests for any uncovered branches until the gate passes.

- [ ] **Step 2: Add frontend coverage gate**

Enable Vitest coverage (`@vitest/coverage-v8`) with thresholds; run `npx vitest run --coverage` and cover gaps.

- [ ] **Step 3: Write README**

Document: install (`uv`/pip + `npm install`), dev (`npm run dev` + `python -m tether_ddns`), build (`npm run build` -> served by FastAPI), test (`pytest`, `vitest`, `playwright`), and the `TETHER_DDNS_CONFIG_PATH` env var.

- [ ] **Step 4: Run full gates**

Run: `pytest -q && (cd frontend && npx vitest run --coverage && npx playwright test)`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: enforce coverage gates and add README"
```

---

## Self-Review Notes

- **Spec coverage:** ConfigStore+models (T2), provider registry+auto-load+DuckDNS (T3–T4), hook registry+example+events (T5), reachability/IP (T6), runtime state (T7), scheduler with exception isolation for providers **and** hooks (T8), logging ring buffer+uvicorn wiring (T1), WebSocket push (T9), secret masking/write-only (T10), REST+WS+static serving+lifespan (T11), React SPA incl. schema-driven provider **and** hook forms, Hooks section (mockup extension), and log viewer (T13–T15), full backend+frontend tests incl. Vitest+Playwright and coverage gates (T12, T16–T17). All spec sections map to tasks.
- **Type consistency:** `UpdateResult`, `HookEvent`, `DomainRuntime`, `RuntimeState.set_status`, `mask_secrets`/`merge_secrets`, `ConnectionManager.broadcast/sync_broadcast`, and API payload shapes are used consistently across tasks.
- **Placeholders:** none — each code step contains runnable content. Frontend component bodies in T15 are described precisely against ported mockup markup; the two component tests pin the required interfaces.
