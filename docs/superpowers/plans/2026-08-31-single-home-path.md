# Single Home Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `TETHER_DDNS_CONFIG_PATH` and `TETHER_DDNS_STATE_PATH` with a single `TETHER_DDNS_HOME_PATH` directory variable holding all three JSON files under hardcoded filenames, and bring the README and Dockerfile back in sync with reality.

**Architecture:** A new `tether_ddns/paths.py` becomes the sole owner of the on-disk layout — the env var name, the three filenames, and four lazy resolver functions. Each of the three stores drops its own env/filename constants and its `resolve_path` static method, defaulting instead to the matching `paths` function. `create_app` gains a third injectable store so tests stay hermetic once incidents no longer follow the state file.

**Tech Stack:** Python 3.12+, pydantic v2, FastAPI, pytest; Playwright for e2e; Docker (Alpine multi-stage).

**Spec:** `docs/superpowers/specs/2026-08-31-single-home-path-design.md`

## Global Constraints

- Python `>=3.12`. Every module and function needs a docstring (flake8 `pep257`), including **every test function** — a one-line docstring ending with a period (`D103`).
- Single quotes throughout Python (ruff). Max line length **99** (`.flake8`).
- Imports strictly alphabetical (`I101`). Application imports (`tether_ddns...`) form their own group **after** third-party (`pydantic`, `pytest`, `fastapi`).
- This is a **hard break**. `TETHER_DDNS_CONFIG_PATH` and `TETHER_DDNS_STATE_PATH` must not survive anywhere outside `docs/` and `.superpowers/` (historical records). No fallback, no deprecation warning, no startup error.
- Filenames are constants, never string literals in consuming code: `CONFIG_FILENAME = 'tether-ddns.config.json'`, `STATE_FILENAME = 'tether-ddns.state.json'`, `INCIDENTS_FILENAME = 'tether-ddns.incidents.json'`. Test assertions may spell them literally — that is the point of the assertion.
- Gates that must pass before any commit is considered done:
  - `pytest` (backend coverage gate `>=90%`)
  - `flake8 test/ tether_ddns/` — the repo's meta-tests lint `test/` too, not just the package
  - `ruff check .`, `mypy .`, `pyright`
- Do **not** add a `--home` CLI flag, an XDG default, a `JsonStore` base class, or backward-compatible env var reading. All explicitly out of scope.

---

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `tether_ddns/paths.py` | Sole owner of the on-disk layout: env var name, three filenames, four lazy resolvers. Imports only `os` and `pathlib` — no project imports, so it can never form a cycle. |
| `test/unit/test_paths.py` | Covers env-var resolution and cwd fallback for all four resolvers. |

**Modified:**

| File | Change |
|---|---|
| `tether_ddns/config_store.py` | Drop `ENV_VAR`, `DEFAULT_FILENAME`, `resolve_path`; default to `paths.config_path()`. |
| `tether_ddns/state_store.py` | Drop `ENV_VAR`, `DEFAULT_FILENAME`, `resolve_path`; default to `paths.state_path()`. |
| `tether_ddns/incident_store.py` | Drop `DEFAULT_FILENAME`, `resolve_path`, `beside`, and the `StateStore` import; default to `paths.incidents_path()`. |
| `tether_ddns/app.py` | `create_app` gains `incident_store: IncidentStore \| None = None`. |
| `test/unit/test_config_store.py` | Replace two `resolve_path` tests with one home-dir default test. |
| `test/unit/test_state_store.py` | Same. |
| `test/unit/test_incident_store.py` | Replace `resolve_path` + `beside` tests with one home-dir default test. |
| `test/unit/test_api.py` | Inject an `IncidentStore` at both `create_app` call sites. |
| `Dockerfile` | Two `ENV` path lines become one. |
| `frontend/playwright.config.ts` | Two `webServer` env assignments become one. |
| `README.md` | Intro, Features, Configuration, Docker. |
| `frontend/e2e/README.md` | Env var references plus pre-existing port drift. |

**Deliberately unchanged:** `docker-compose.yml` (the image sets the variable; the volume is already `tether-data:/data`) and `.gitignore` (already lists all three filenames).

**Task ordering rationale — read before resequencing.** `IncidentStore.resolve_path()` currently calls `StateStore.resolve_path()`. Deleting the latter without the former in the same commit leaves a broken tree, so Task 3 migrates both stores together. The `Dockerfile` and `playwright.config.ts` changes are also in Task 3, not the docs task: once the code ignores the old variables, the container would resolve its home to `WORKDIR /app` — owned by root, while the process runs as `app` — and the Playwright webServer would resolve to the **repository root** and overwrite the developer's real `tether-ddns.config.json`.

---

### Task 1: The `paths` layout module

**Files:**
- Create: `tether_ddns/paths.py`
- Test: `test/unit/test_paths.py`

**Interfaces:**
- Consumes: nothing.
- Produces: module `tether_ddns.paths` with `ENV_VAR: str`, `CONFIG_FILENAME: str`, `STATE_FILENAME: str`, `INCIDENTS_FILENAME: str`, and `home() -> Path`, `config_path() -> Path`, `state_path() -> Path`, `incidents_path() -> Path`. Tasks 2 and 3 import it as `from tether_ddns import paths` and call `paths.config_path()` etc.

- [ ] **Step 1: Write the failing test**

Create `test/unit/test_paths.py`:

```python
"""Tests for the on-disk layout resolvers."""
from pathlib import Path

import pytest

from tether_ddns import paths


def test_home_uses_env(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """home honours TETHER_DDNS_HOME_PATH."""
    monkeypatch.setenv('TETHER_DDNS_HOME_PATH', str(tmp_path))
    assert paths.home() == tmp_path


def test_home_falls_back_to_cwd(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Without the env var, the working directory is the home."""
    monkeypatch.delenv('TETHER_DDNS_HOME_PATH', raising=False)
    monkeypatch.chdir(tmp_path)
    assert paths.home() == tmp_path


def test_files_resolve_into_the_env_home(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """All three files sit in the configured home under fixed names."""
    monkeypatch.setenv('TETHER_DDNS_HOME_PATH', str(tmp_path))
    assert paths.config_path() == tmp_path / 'tether-ddns.config.json'
    assert paths.state_path() == tmp_path / 'tether-ddns.state.json'
    assert paths.incidents_path() == tmp_path / 'tether-ddns.incidents.json'


def test_files_fall_back_to_cwd(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """All three files sit in the cwd when the env var is unset."""
    monkeypatch.delenv('TETHER_DDNS_HOME_PATH', raising=False)
    monkeypatch.chdir(tmp_path)
    assert paths.config_path() == tmp_path / 'tether-ddns.config.json'
    assert paths.state_path() == tmp_path / 'tether-ddns.state.json'
    assert paths.incidents_path() == tmp_path / 'tether-ddns.incidents.json'


def test_home_is_resolved_lazily(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Changing the env var after import changes later resolutions."""
    monkeypatch.setenv('TETHER_DDNS_HOME_PATH', str(tmp_path / 'a'))
    first = paths.config_path()
    monkeypatch.setenv('TETHER_DDNS_HOME_PATH', str(tmp_path / 'b'))
    assert first != paths.config_path()
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `pytest test/unit/test_paths.py -v`
Expected: collection error — `ModuleNotFoundError: No module named 'tether_ddns.paths'`.

- [ ] **Step 3: Write the module**

Create `tether_ddns/paths.py`:

```python
"""Filesystem layout for the JSON-backed stores.

Every persisted file lives in one home directory so an operator points a
single variable at a volume. Resolution is deliberately lazy: reading the
environment and the working directory per call keeps the layout responsive
to `monkeypatch.chdir` and to a home set after import.
"""
from __future__ import annotations

import os
from pathlib import Path

ENV_VAR = 'TETHER_DDNS_HOME_PATH'
CONFIG_FILENAME = 'tether-ddns.config.json'
STATE_FILENAME = 'tether-ddns.state.json'
INCIDENTS_FILENAME = 'tether-ddns.incidents.json'


def home() -> Path:
    """Resolve the data home from the env var, else the working directory."""
    env = os.environ.get(ENV_VAR)
    return Path(env) if env else Path.cwd()


def config_path() -> Path:
    """Return the configuration file path."""
    return home() / CONFIG_FILENAME


def state_path() -> Path:
    """Return the runtime-state file path."""
    return home() / STATE_FILENAME


def incidents_path() -> Path:
    """Return the incident-window file path."""
    return home() / INCIDENTS_FILENAME
```

Do **not** create the directory here. Each store's `save` already calls `self._path.parent.mkdir(parents=True, exist_ok=True)`, which is sufficient, and keeping `paths` side-effect-free means importing it can never touch the filesystem.

- [ ] **Step 4: Run the test and watch it pass**

Run: `pytest test/unit/test_paths.py -v`
Expected: 5 passed.

- [ ] **Step 5: Run the linters**

Run: `flake8 test/ tether_ddns/ && ruff check . && mypy . && pyright`
Expected: all clean. If `pyright` reports the module is unused, ignore — it is consumed in Task 2.

- [ ] **Step 6: Commit**

```bash
git add tether_ddns/paths.py test/unit/test_paths.py
git commit -m "feat: add a paths module owning the on-disk layout"
```

---

### Task 2: Migrate `ConfigStore`

**Files:**
- Modify: `tether_ddns/config_store.py:12-13` (constants), `:60-71` (`__init__` and `resolve_path`)
- Test: `test/unit/test_config_store.py:9-24`

**Interfaces:**
- Consumes: `tether_ddns.paths.config_path()` from Task 1.
- Produces: `ConfigStore(path: Path | None = None)` unchanged in signature, but a `None` path now resolves to `paths.config_path()`. `ConfigStore.resolve_path` no longer exists. `ConfigStore.path` property is unchanged.

Nothing else in the codebase calls `ConfigStore.resolve_path`, so this task stands alone and leaves a green tree.

- [ ] **Step 1: Rewrite the tests to describe the new behaviour**

In `test/unit/test_config_store.py`, delete `test_resolve_path_uses_env` and `test_resolve_path_falls_back_to_cwd` entirely, and put this in their place:

```python
def test_default_path_sits_in_the_home_dir(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """A default-constructed store writes into TETHER_DDNS_HOME_PATH."""
    monkeypatch.setenv('TETHER_DDNS_HOME_PATH', str(tmp_path))
    assert ConfigStore().path == tmp_path / 'tether-ddns.config.json'
```

The `import pytest` and `from pathlib import Path` lines stay — the new test still uses both.

- [ ] **Step 2: Run the test and watch it fail**

Run: `pytest test/unit/test_config_store.py -v`
Expected: `test_default_path_sits_in_the_home_dir` FAILS — the store still resolves from `TETHER_DDNS_CONFIG_PATH`, so with that unset it falls back to the real cwd (the repository root) rather than `tmp_path`.

- [ ] **Step 3: Migrate the store**

In `tether_ddns/config_store.py`, delete these two module constants:

```python
ENV_VAR = 'TETHER_DDNS_CONFIG_PATH'
DEFAULT_FILENAME = 'tether-ddns.config.json'
```

Add the import to the application group, after the `pydantic` import and separated by a blank line:

```python
from pydantic import BaseModel, Field

from tether_ddns import paths
```

Change the constructor default and delete the `resolve_path` static method:

```python
    def __init__(self, path: Path | None = None) -> None:
        """Create a store bound to a path (resolved if omitted)."""
        self._path = path if path is not None else paths.config_path()
```

Leave `import os` in place — `save` still uses `os.fdopen`, `os.replace`, `os.path.exists` and `os.unlink`.

- [ ] **Step 4: Run the tests and watch them pass**

Run: `pytest test/unit/test_config_store.py -v`
Expected: all pass.

- [ ] **Step 5: Run the full suite and the linters**

Run: `pytest && flake8 test/ tether_ddns/ && ruff check . && mypy . && pyright`
Expected: all green, coverage still `>=90%`.

- [ ] **Step 6: Commit**

```bash
git add tether_ddns/config_store.py test/unit/test_config_store.py
git commit -m "refactor: resolve the config path from the shared data home"
```

---

### Task 3: Migrate `StateStore` and `IncidentStore`, and the deployment surfaces

**Files:**
- Modify: `tether_ddns/state_store.py:18-19`, `:27-39`
- Modify: `tether_ddns/incident_store.py:17-18`, `:26-42`
- Modify: `tether_ddns/app.py:54-60`, `:75-76`
- Modify: `Dockerfile:30-33`
- Modify: `frontend/playwright.config.ts:22-28`
- Test: `test/unit/test_state_store.py:11-26`, `test/unit/test_incident_store.py:11-22`, `test/unit/test_api.py:39-46`, `:63`

**Interfaces:**
- Consumes: `tether_ddns.paths.state_path()` and `tether_ddns.paths.incidents_path()` from Task 1.
- Produces:
  - `StateStore(path: Path | None = None)` — `None` resolves to `paths.state_path()`; `StateStore.resolve_path` removed.
  - `IncidentStore(path: Path | None = None)` — `None` resolves to `paths.incidents_path()`; `IncidentStore.resolve_path` and `IncidentStore.beside` **both removed**.
  - `create_app(config_store: ConfigStore | None = None, state_store: StateStore | None = None, incident_store: IncidentStore | None = None) -> FastAPI`.

These are one task because `IncidentStore.resolve_path` calls `StateStore.resolve_path`; splitting them leaves a broken tree between commits.

- [ ] **Step 1: Rewrite the store tests**

In `test/unit/test_state_store.py`, delete `test_resolve_path_uses_env` and `test_resolve_path_falls_back_to_cwd`, replacing them with:

```python
def test_default_path_sits_in_the_home_dir(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """A default-constructed store writes into TETHER_DDNS_HOME_PATH."""
    monkeypatch.setenv('TETHER_DDNS_HOME_PATH', str(tmp_path))
    assert StateStore().path == tmp_path / 'tether-ddns.state.json'
```

In `test/unit/test_incident_store.py`, delete `test_resolve_path_sits_beside_the_state_file` and `test_beside_derives_from_a_given_state_path`, replacing them with:

```python
def test_default_path_sits_in_the_home_dir(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """A default-constructed store writes into TETHER_DDNS_HOME_PATH."""
    monkeypatch.setenv('TETHER_DDNS_HOME_PATH', str(tmp_path))
    assert IncidentStore().path == tmp_path / 'tether-ddns.incidents.json'
```

- [ ] **Step 2: Write the failing `create_app` test**

Add to `test/unit/test_api.py`. This is the test that pins down *why* the third parameter exists — without it the app writes its incident file outside `tmp_path`:

```python
def test_incident_store_is_injectable(tmp_path: Path) -> None:
    """An injected incident store keeps the app off the shared data home."""
    store = ConfigStore(tmp_path / 'cfg.json')
    config = AppConfig()
    config.settings.update_on_startup = False
    store.save(config)
    incidents = tmp_path / 'incidents.json'
    app = create_app(
        config_store=store,
        state_store=StateStore(tmp_path / 'state.json'),
        incident_store=IncidentStore(incidents))
    with TestClient(app):
        pass
    assert incidents.exists()
```

Add the import in the application group, **before** `from tether_ddns.incidents import ...` — `incident_store` sorts ahead of `incidents` because `_` (0x5F) precedes `s` (0x73):

```python
from tether_ddns.incident_store import IncidentStore
from tether_ddns.incidents import WINDOW_SECONDS
```

- [ ] **Step 3: Run the tests and watch them fail**

Run: `pytest test/unit/test_state_store.py test/unit/test_incident_store.py test/unit/test_api.py -v`
Expected: the three new tests FAIL — the two store tests because the old env vars are still consulted, and `test_incident_store_is_injectable` with `TypeError: create_app() got an unexpected keyword argument 'incident_store'`.

- [ ] **Step 4: Migrate `StateStore`**

In `tether_ddns/state_store.py`, delete:

```python
ENV_VAR = 'TETHER_DDNS_STATE_PATH'
DEFAULT_FILENAME = 'tether-ddns.state.json'
```

Add `from tether_ddns import paths` to the application import group — it sorts before `from tether_ddns.runtime import RuntimeState`:

```python
from pydantic import ValidationError

from tether_ddns import paths
from tether_ddns.runtime import RuntimeState
```

Set the default and delete the `resolve_path` static method:

```python
    def __init__(self, path: Path | None = None) -> None:
        """Create a store bound to a path (resolved if omitted)."""
        self._path = path if path is not None else paths.state_path()
```

Keep `import os` — `save` still needs it.

- [ ] **Step 5: Migrate `IncidentStore`**

In `tether_ddns/incident_store.py`, delete the `DEFAULT_FILENAME` constant, the `resolve_path` static method, the `beside` classmethod, and the `from tether_ddns.state_store import StateStore` import. The application import group becomes:

```python
from tether_ddns import paths
from tether_ddns.incidents import IncidentWindow
```

Set the default:

```python
    def __init__(self, path: Path | None = None) -> None:
        """Create a store bound to a path (resolved if omitted)."""
        self._path = path if path is not None else paths.incidents_path()
```

- [ ] **Step 6: Add the third store to `create_app`**

In `tether_ddns/app.py`, extend the signature and resolve alongside the others:

```python
def create_app(
    config_store: ConfigStore | None = None,
    state_store: StateStore | None = None,
    incident_store: IncidentStore | None = None,
) -> FastAPI:
    """Create the configured FastAPI application."""
    resolved_config_store = config_store if config_store is not None else ConfigStore()
    resolved_state_store = (state_store if state_store is not None else StateStore())
    resolved_incident_store = (
        incident_store if incident_store is not None else IncidentStore())
```

Then replace the two-line recorder construction:

```python
        recorder = IncidentRecorder(
            IncidentStore.beside(resolved_state_store.path))
```

with:

```python
        recorder = IncidentRecorder(resolved_incident_store)
```

- [ ] **Step 7: Inject the store at the existing `test_api.py` call sites**

In `_client`:

```python
def _client(tmp_path: Path) -> Any:
    """Build a TestClient with startup checks disabled for hermetic tests."""
    store = ConfigStore(tmp_path / 'cfg.json')
    config = AppConfig()
    config.settings.update_on_startup = False
    store.save(config)
    state_store = StateStore(tmp_path / 'state.json')
    incident_store = IncidentStore(tmp_path / 'incidents.json')
    return TestClient(create_app(store, state_store, incident_store))
```

In `test_restores_domain_status_on_startup`:

```python
    app = create_app(
        config_store=store, state_store=state_store,
        incident_store=IncidentStore(tmp_path / 'incidents.json'))
```

- [ ] **Step 8: Run the tests and watch them pass**

Run: `pytest -v`
Expected: all pass, coverage `>=90%`.

- [ ] **Step 9: Prove no incident file leaked into the repository root**

Run: `git status --porcelain --ignored | grep 'tether-ddns.incidents.json' || echo 'clean'`
Expected: `clean`. If the file appears, an injection site was missed — find it before continuing, do not just delete the file.

- [ ] **Step 10: Update the Dockerfile**

Replace the `ENV` block:

```dockerfile
ENV PATH=/app/.venv/bin:$PATH \
    TETHER_DDNS_HOME_PATH=/data \
    PYTHONUNBUFFERED=1
```

The `mkdir /data && chown app:app /data` line above is unchanged and is what makes the home writable by the non-root `app` user.

- [ ] **Step 11: Update the Playwright webServer**

In `frontend/playwright.config.ts`, replace the file docstring and the `command`:

```typescript
/**
 * Playwright e2e config for the production SPA served by FastAPI.
 *
 * The webServer builds the frontend (output goes to ../tether_ddns/static),
 * then launches the backend on a dedicated port with its whole data home
 * pointed at a temp dir, so a run is hermetic: it can never reuse a
 * developer's instance on the default port, write to the real config, or
 * leave state/incident files in the repository root.
 */
```

```typescript
    command:
      'npm run build && cd .. && ' +
      'TETHER_DDNS_HOME_PATH=$(mktemp -d) ' +
      'TETHER_DDNS_PORT=8123 .venv/bin/python -m tether_ddns',
```

The `E2E_DIR` shell variable is no longer needed — one temp dir now holds all three files.

- [ ] **Step 12: Smoke-test the new variable end to end**

```bash
rm -rf /tmp/td-home && source .venv/bin/activate && \
  TETHER_DDNS_HOME_PATH=/tmp/td-home TETHER_DDNS_PORT=8124 \
  timeout 20 python -m tether_ddns; ls -la /tmp/td-home
```

Expected: `/tmp/td-home` was created and contains `tether-ddns.incidents.json`.
That file is the deterministic signal — `IncidentRecorder.__init__` writes it on
every first-ever start so `monitoring_since` is stable across restarts.
`tether-ddns.state.json` only appears once a reachability check completes, and
`tether-ddns.config.json` only once a setting is saved, so neither is required
for this step to pass.

- [ ] **Step 13: Run the e2e suite**

First confirm nothing is already listening, because `reuseExistingServer` is enabled outside CI and would silently run the tests against a stale server:

```bash
ss -ltn 2>/dev/null | grep -E ':(8000|8123) ' && echo 'STOP: port in use' || echo 'ports free'
```

If `ss` is unavailable, use `lsof -i :8123` instead. Kill any listener before continuing.

Then:

```bash
cd frontend && npx playwright test
```

Expected: all pass. Afterwards re-run the Step 9 check — the repository root must still be free of `tether-ddns.config.json`, `tether-ddns.state.json` and `tether-ddns.incidents.json` changes.

- [ ] **Step 14: Run the linters**

Run: `flake8 test/ tether_ddns/ && ruff check . && mypy . && pyright`
Expected: all clean.

- [ ] **Step 15: Commit**

```bash
git add tether_ddns/state_store.py tether_ddns/incident_store.py tether_ddns/app.py \
        test/unit/test_state_store.py test/unit/test_incident_store.py \
        test/unit/test_api.py Dockerfile frontend/playwright.config.ts
git commit -m "refactor: resolve state and incident paths from the shared data home

BREAKING CHANGE: TETHER_DDNS_CONFIG_PATH and TETHER_DDNS_STATE_PATH are gone.
Set TETHER_DDNS_HOME_PATH to a directory instead; it holds
tether-ddns.config.json, tether-ddns.state.json and tether-ddns.incidents.json
under fixed names. Existing bare-metal installs must move the three files into
one directory, or the app will start unconfigured. Docker users are unaffected:
the image sets the variable and the on-volume filenames are unchanged."
```

---

### Task 4: Refresh the documentation

**Files:**
- Modify: `README.md:10-13` (intro), `:29-32` (Features), `:80-93` (Configuration), `:100-110` (Docker)
- Modify: `frontend/e2e/README.md:4`, `:12-15`, `:27-32`

**Interfaces:**
- Consumes: the behaviour established in Tasks 1–3. Produces nothing consumed by code.

Line numbers are approximate — match on the quoted text, not the number.

- [ ] **Step 1: Correct the intro paragraph**

The current text claims uptime% is rebuilt on start. That stopped being true when the incident window landed: `tether-ddns.incidents.json` is persisted and is the source of uptime%. Only `reachability_history` — a capped deque of per-check records covering roughly 30 minutes — is rebuilt. Replace:

```markdown
Configuration and last-known runtime state are pydantic-modelled and persisted
as JSON on disk, so a restart keeps your public IPs, per-domain status, and
"IP stable since" timestamps. Ephemeral telemetry (the reachability history and
since-boot uptime%) is intentionally rebuilt on start.
```

with:

```markdown
Configuration, last-known runtime state, and a 30-day reachability incident
window are pydantic-modelled and persisted as JSON on disk, so a restart keeps
your public IPs, per-domain status, "IP stable since" timestamps, and your
uptime history. Only the short per-check reachability sparkline is rebuilt on
start.
```

- [ ] **Step 2: Update the Features list**

Replace the final bullet:

```markdown
- **Runtime state persisted across restarts** — last-known public IPs,
  per-domain status, and "IP stable since" timestamps survive a restart;
  reachability history and uptime% rebuild on start.
```

with two bullets:

```markdown
- **Runtime state persisted across restarts** — last-known public IPs,
  per-domain status, and "IP stable since" timestamps survive a restart; only
  the short per-check reachability sparkline is rebuilt.
- **30-day reachability incident history** — outages and degraded periods are
  recorded to disk with a write-on-change policy, shown as a per-day history
  strip with a per-day incident modal, and used to compute window uptime%.
```

- [ ] **Step 3: Rewrite the Configuration section**

Replace both path bullets — the `TETHER_DDNS_CONFIG_PATH` one and the `TETHER_DDNS_STATE_PATH` one — with:

```markdown
- `TETHER_DDNS_HOME_PATH` — the directory holding everything the app persists.
  If unset, the current working directory is used. The directory is created on
  first write, and the filenames inside it are fixed:

  | File | Contents | If deleted |
  |---|---|---|
  | `tether-ddns.config.json` | settings, domains, hooks, secrets | **durable** — the only file worth backing up |
  | `tether-ddns.state.json` | last-known public IPs, per-domain status, "IP stable since" | cold-starts with rebuilt state |
  | `tether-ddns.incidents.json` | 30-day incident window, source of uptime% | history and uptime% reset |

  Both state files are disposable and fail-soft: a missing or corrupt file is
  discarded with a warning rather than stopping the app. Only the config file
  is authored by you, through the UI or API.
```

This also fixes the first stale claim — the README says the config default is `./tether-ddns.json`, but the filename has always been `tether-ddns.config.json`. Leave the `TETHER_DDNS_HOST` / `TETHER_DDNS_PORT` bullet exactly as it is.

- [ ] **Step 4: Update the Docker section**

Replace:

```markdown
Config and runtime state persist in the `tether-config` named volume (mounted at
`/data`, via `TETHER_DDNS_CONFIG_PATH=/data/tether-ddns.json` and
`TETHER_DDNS_STATE_PATH=/data/tether-ddns.state.json`), so restarts keep your
last-known status.
```

with:

```markdown
Config, runtime state, and incident history persist in the `tether-data` named
volume (mounted at `/data`, via `TETHER_DDNS_HOME_PATH=/data`), so restarts keep
your last-known status and uptime history.
```

That corrects the second stale claim: the volume was renamed from `tether-config` to `tether-data` in `265cbd6`.

- [ ] **Step 5: Update the e2e README**

In `frontend/e2e/README.md`:

Line 4 — the suite has bound port 8123 since `d969b49`, not 8000:

```markdown
frontend (`tether_ddns/static`) is served by `python -m tether_ddns` on port 8123.
```

The prerequisites paragraph:

```markdown
The `webServer` in `playwright.config.ts` handles building the frontend and
launching the backend automatically, so you do not need to build or start the
server manually. Each run points `TETHER_DDNS_HOME_PATH` at a fresh temp
directory, so tests begin from an empty configuration and leave no files in the
repository.
```

The first two Notes bullets — the quoted command is copied by hand and had drifted from the config on both the port and the config path:

```markdown
- The webServer command is:
  `npm run build && cd .. && TETHER_DDNS_HOME_PATH=$(mktemp -d) TETHER_DDNS_PORT=8123 .venv/bin/python -m tether_ddns`
  (the `.venv/bin/python` path is relative to the repo root, which is the cwd after `cd ..`)
- `reuseExistingServer` is enabled outside CI, so an already-running server on
  port 8123 will be reused.
```

- [ ] **Step 6: Verify the old variables are completely gone**

```bash
grep -rn 'TETHER_DDNS_CONFIG_PATH\|TETHER_DDNS_STATE_PATH' \
  --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=docs \
  --exclude-dir=.superpowers --exclude-dir=__pycache__ \
  --exclude-dir=coverage --exclude-dir=test-results . \
  || echo 'PASS: both variables fully removed'
```

Expected: `PASS: both variables fully removed`. Hits under `docs/` and `.superpowers/` are historical plans and specs and are correctly excluded — do not rewrite them.

- [ ] **Step 7: Confirm every documented filename matches the constants**

```bash
grep -c 'tether-ddns.config.json\|tether-ddns.state.json\|tether-ddns.incidents.json' README.md
grep -rn 'tether-ddns.json' README.md || echo 'PASS: no stale bare filename'
```

Expected: a non-zero count from the first command, and `PASS: no stale bare filename` from the second.

- [ ] **Step 8: Commit**

```bash
git add README.md frontend/e2e/README.md
git commit -m "docs: document the single data home and the incident history"
```

---

## Final Verification

- [ ] Run the whole backend suite with the coverage gate: `pytest`
- [ ] Run every linter: `flake8 test/ tether_ddns/ && ruff check . && mypy . && pyright`
- [ ] Run the frontend suites: `cd frontend && npm test && npx playwright test`
- [ ] Build the container and confirm the home is writable by the non-root user:

```bash
docker build -t tether-ddns:homepath-check . && \
docker run --rm -e TETHER_DDNS_PORT=8125 tether-ddns:homepath-check \
  sh -c 'timeout 15 tether-ddns; ls -la /data'
```

Expected: `/data` is owned by `app` and contains `tether-ddns.incidents.json`
(written unconditionally on first start). This is the check that would catch a
forgotten Dockerfile `ENV`: without it the home resolves to `WORKDIR /app`,
which is root-owned, and the run fails with a permission error instead.

- [ ] Confirm a clean tree: `git status --porcelain && echo '(clean)'`
