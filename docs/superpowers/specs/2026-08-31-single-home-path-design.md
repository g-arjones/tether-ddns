# Single home path for on-disk stores

**Date:** 2026-08-31
**Status:** approved, ready for implementation planning

## Problem

Three JSON files are persisted on disk, but an operator has to configure two
environment variables to place them:

- `TETHER_DDNS_CONFIG_PATH` → `tether-ddns.config.json`
- `TETHER_DDNS_STATE_PATH` → `tether-ddns.state.json`
- (no variable) → `tether-ddns.incidents.json`, derived as
  `StateStore.resolve_path().parent / DEFAULT_FILENAME`

Each variable names a *whole file path*, so nothing stops an operator pointing
them at different directories, or at filenames the rest of the code does not
expect. The incident file has no variable at all: it silently follows the state
file, which forces `IncidentStore` to import `StateStore` purely to do `.parent`
arithmetic, and forces `create_app` to wire it with `IncidentStore.beside(...)`.

The README and Dockerfile have also drifted. The README was last touched
2026-07-16; since then the entire 30-day reachability incident history landed.
It additionally states two facts that are simply wrong today.

## Goals

1. One environment variable, `TETHER_DDNS_HOME_PATH`, names a **directory**.
   All three files live in it under hardcoded, constant-defined filenames.
2. Remove the `IncidentStore` → `StateStore` coupling.
3. Bring the README and Dockerfile back in line with reality.

## Non-goals

Explicitly out of scope, decided during brainstorming:

- Backward compatibility with the old variables. This is a **hard break**: the
  two old names are deleted and are not read, warned about, or errored on.
- A `--home` CLI flag. Environment variable only; `create_app`'s signature is
  not threaded through `__main__`.
- An XDG data directory default.
- Extracting a shared `JsonStore[T]` base class. The three stores are ~90%
  identical (same `mkstemp` + `os.replace` atomic save, near-identical fail-soft
  load) and this duplication is real, but removing it is a much larger refactor
  and the repo's PEP 695 generics footguns (flake8 D101 false-positives,
  pyright `reportMissingTypeArgument`) make it a poor rider on this change.
  Worth its own spec later.
- Documenting the HTTP/WebSocket API surface in the README.
- Dockerfile hardening (`VOLUME`, `HEALTHCHECK`).
- README coverage of the PWA / installable-app work.

## Design

### New module: `tether_ddns/paths.py`

A single module owns the on-disk layout. It is the only place the environment
variable name and the three filenames appear.

```python
"""Filesystem layout for the JSON-backed stores."""
from __future__ import annotations

import os
from pathlib import Path

ENV_VAR = 'TETHER_DDNS_HOME_PATH'
CONFIG_FILENAME = 'tether-ddns.config.json'
STATE_FILENAME = 'tether-ddns.state.json'
INCIDENTS_FILENAME = 'tether-ddns.incidents.json'


def home() -> Path:
    """Resolve the data home from the env var, else the current directory."""
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

**Resolution is lazy.** `home()` reads the environment and the current directory
on every call, evaluated at store-construction time. Module-level path constants
would freeze `Path.cwd()` at import time and break the `monkeypatch.chdir`
fallback tests.

**The home directory is not created here.** Each store's `save` already does
`self._path.parent.mkdir(parents=True, exist_ok=True)`, which is sufficient and
keeps `paths` free of side effects.

### Store changes

Each store drops its own environment/filename constants and its `resolve_path`
static method, and defaults to the matching `paths` function:

| Store | Removed | `__init__` default becomes |
|---|---|---|
| `ConfigStore` | `ENV_VAR`, `DEFAULT_FILENAME`, `resolve_path` | `paths.config_path()` |
| `StateStore` | `ENV_VAR`, `DEFAULT_FILENAME`, `resolve_path` | `paths.state_path()` |
| `IncidentStore` | `DEFAULT_FILENAME`, `resolve_path`, `beside`, the `StateStore` import | `paths.incidents_path()` |

The `path: Path | None` constructor parameter and the `path` property stay
unchanged on all three, so every existing test that injects an explicit path is
unaffected.

### `create_app` gains a third store parameter

```python
def create_app(
    config_store: ConfigStore | None = None,
    state_store: StateStore | None = None,
    incident_store: IncidentStore | None = None,
) -> FastAPI:
```

with `IncidentStore.beside(resolved_state_store.path)` in the lifespan replaced
by the resolved injected store.

This is required, not cosmetic. Today `test_api.py` injects a `StateStore` at
`tmp_path` and gets its incident file inside `tmp_path` for free, because
incidents follow the state file. Once incidents resolve from the home directory
instead, a bare `IncidentStore()` would write `tether-ddns.incidents.json` into
the repository root on every API test. Making the third store injectable keeps
the tests hermetic and makes the home directory a *default* rather than a hidden
coupling between two stores.

### Configuration surfaces

| File | Change |
|---|---|
| `Dockerfile` | the two `ENV` path lines become `TETHER_DDNS_HOME_PATH=/data` |
| `frontend/playwright.config.ts` | the two `webServer` env assignments become `TETHER_DDNS_HOME_PATH=$(mktemp -d)`; the now-redundant `E2E_DIR` shell variable is dropped and the file docstring updated |
| `frontend/e2e/README.md` | the two references to `TETHER_DDNS_CONFIG_PATH` (prose and the quoted webServer command) become the single variable; while there, correct the stale port — the file says 8000 in two places but the config has bound 8123 since `d969b49` |
| `docker-compose.yml` | **no change** — the image sets the variable, and the volume is already `tether-data:/data` |
| `.gitignore` | **no change** — it already lists all three filenames |

## Testing

New `test/unit/test_paths.py`:

- `home()`, `config_path()`, `state_path()`, `incidents_path()` all resolve
  under a directory given by `TETHER_DDNS_HOME_PATH`.
- With the variable unset, all four fall back to a `monkeypatch.chdir`
  directory.

Deleted, because the code under test is gone:

- `test_config_store.py::test_resolve_path_uses_env`,
  `::test_resolve_path_falls_back_to_cwd`
- `test_state_store.py::test_resolve_path_uses_env`,
  `::test_resolve_path_falls_back_to_cwd`
- `test_incident_store.py::test_resolve_path_sits_beside_the_state_file`,
  `::test_beside_derives_from_a_given_state_path`

Added, one per store, in each store's existing test module: a default-constructed
store places its file under `TETHER_DDNS_HOME_PATH`. This is the behavioural
contract operators depend on, and it covers the `__init__` default branch.

Updated: both `create_app` call sites in `test_api.py` pass an
`IncidentStore(tmp_path / 'tether-ddns.incidents.json')`.

Gates, all of which must pass:

- `pytest` (backend coverage gate `>=90%`)
- `flake8 test/ tether_ddns/`, `ruff`, `mypy .`, `pyright` — the repo's
  meta-tests lint `test/` as well as `tether_ddns/`
- `npx playwright test` — required, not optional, because the e2e webServer
  command changes. Any locally running instance on port 8000 must be stopped
  first, since `reuseExistingServer` is enabled outside CI.

## Documentation

### `README.md`

1. **Intro paragraph.** It currently claims "Ephemeral telemetry (the
   reachability history and since-boot uptime%) is intentionally rebuilt on
   start." That is now half wrong: the 30-day incident window is persisted in
   `tether-ddns.incidents.json` and is the source of uptime%. Only the short
   per-check sparkline (`reachability_history`, ~30 minutes, capped deque) is
   rebuilt. Correct the claim.

2. **Features.** Add a bullet for the reachability incident history: 30-day
   persisted window, per-day history strip, per-day incident modal, window
   uptime%. Fix the stale tail of the existing "Runtime state persisted across
   restarts" bullet, which repeats the same wrong uptime% claim.

3. **Configuration.** Replace the `TETHER_DDNS_CONFIG_PATH` and
   `TETHER_DDNS_STATE_PATH` bullets with one `TETHER_DDNS_HOME_PATH` bullet
   describing a directory that defaults to the current working directory, plus
   a layout table:

   | File | Contents | If deleted |
   |---|---|---|
   | `tether-ddns.config.json` | settings, domains, hooks, secrets | durable — the only file worth backing up |
   | `tether-ddns.state.json` | last-known public IPs, per-domain status, IP-stable-since | cold-starts with rebuilt state (fail-soft) |
   | `tether-ddns.incidents.json` | 30-day incident window, source of uptime% | history and uptime% reset (fail-soft) |

   This also fixes the first outright error: the README says the config default
   is `./tether-ddns.json`, but `DEFAULT_FILENAME` is `tether-ddns.config.json`.

4. **Docker.** Describe the single variable, and fix the second outright error:
   the volume is named `tether-data`, not `tether-config` (renamed in `265cbd6`).

The `TETHER_DDNS_HOST` / `TETHER_DDNS_PORT` bullet is unchanged.

### `frontend/e2e/README.md`

Updated as listed in the configuration-surfaces table above. The quoted webServer
command there is reproduced by hand and has drifted from
`playwright.config.ts`: it names port 8000 and a `$(mktemp -d)/e2e-config.json`
config path, while the config has used port 8123 and a shared temp directory
since `d969b49`. Since this change rewrites that command anyway, bring the whole
snippet and the surrounding port references back in sync.

## Risks

- **Silent relocation on upgrade.** An existing bare-metal operator who set the
  old variables will, after upgrading, find the app reading and writing a
  different directory: their config appears empty and the app starts unconfigured
  with their real config still on disk elsewhere. This was accepted deliberately
  in favour of a single resolution path. It must be called out in the release
  notes / commit message so operators know to set one variable and move three
  files.
- **Docker users are unaffected**, because the image sets the variable itself and
  the on-volume filenames are unchanged: `/data` already contains exactly the
  three expected names.
