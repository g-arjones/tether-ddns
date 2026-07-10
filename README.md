# tether-ddns

A stateless, self-hosted **dynamic DNS updater**. A FastAPI + APScheduler
backend periodically checks internet reachability (via a DNS-resolver quorum),
detects the current public IP, and updates one or more DDNS records through an
auto-loaded **provider** plugin system. A React + Vite single-page app (served
by FastAPI in production) shows live status, streaming logs, and configuration —
pushed over a single WebSocket.

All configuration is pydantic-modelled and persisted as JSON; **all runtime
state is rebuilt on start**, so the process holds no durable state of its own.

## Features

- Periodic reachability + public-IP detection with exception-isolated jobs.
- Pluggable **DDNS providers** (DuckDNS included), **hooks** (log hook
  included), and **IP sources** (ipify / icanhazip included).
- Secrets stored as `pydantic.SecretStr`: write-only over the API, masked
  (`********`) on read, real values only on disk.
- Live logs and state over a WebSocket to the SPA.

## Requirements

- Python `>=3.12`
- Node.js 22 / npm 10 (for the frontend)

## Install

Backend (using [`uv`](https://docs.astral.sh/uv/)):

```bash
uv pip install -e .
# or, to sync from the lockfile:
uv sync
```

Frontend:

```bash
cd frontend
npm install
```

## Development

Run the backend and the Vite dev server side by side. Vite proxies `/api`
(REST + WebSocket) to the backend on port `8000`.

```bash
# terminal 1 — backend
python -m tether_ddns            # serves on http://localhost:8000

# terminal 2 — frontend dev server
cd frontend
npm run dev                      # serves on http://localhost:5173, proxy -> :8000
```

## Production build

The frontend builds into `tether_ddns/static`, which FastAPI serves as the SPA:

```bash
cd frontend
npm run build                    # output -> ../tether_ddns/static
python -m tether_ddns            # serves the built SPA + API on :8000
```

## Configuration

- `TETHER_DDNS_CONFIG_PATH` — path to the JSON config file. If unset, the app
  uses `./tether-ddns.json` in the current working directory. The file is
  created/updated automatically as you change settings through the UI/API.

## Tests

Backend (pytest + coverage gate, `>=90%`):

```bash
pytest
```

Frontend unit/component (Vitest + coverage thresholds):

```bash
cd frontend
npx vitest run --coverage
```

Frontend end-to-end (Playwright — builds the SPA and launches the backend):

```bash
cd frontend
npx playwright install chromium   # first time only
npx playwright test
```

## Extending: providers, hooks, and IP sources

Each plugin type is a subclass registered with a decorator and auto-loaded from
its `registered_*` package. Drop a new module into the matching directory and it
self-registers on startup.

### Add a DDNS provider

Create a module under `tether_ddns/providers/ddns_providers/`:

```python
from pydantic import BaseModel, SecretStr
from tether_ddns.providers.base import DDNSProvider, UpdateResult, register_provider


class MyConfig(BaseModel):
    token: SecretStr


@register_provider
class MyProvider(DDNSProvider):
    key = 'myprovider'
    display_name = 'My Provider'
    ConfigModel = MyConfig

    async def update(
        self, hostname: str, record_type: str, ip: str, config: BaseModel,
    ) -> UpdateResult:
        assert isinstance(config, MyConfig)
        # ...perform the update...
        return UpdateResult(success=True, ip=ip)
```

### Add a hook

Create a module under `tether_ddns/hooks/registered_hooks/`:

```python
from pydantic import BaseModel
from tether_ddns.hooks.base import Hook, HookEvent, register_hook


@register_hook
class MyHook(Hook):
    key = 'myhook'
    display_name = 'My Hook'

    async def handle(self, event: HookEvent, config: BaseModel) -> None:
        # react to 'ip_changed' / 'reachability_changed' events
        ...
```

### Add an IP source

Create a module under `tether_ddns/ip_sources/registered_sources/`:

```python
from tether_ddns.ip_sources.base import IPSource, register_ip_source


@register_ip_source
class MySource(IPSource):
    key = 'mysource'
    display_name = 'My Source'

    async def detect(self) -> str | None:
        # return the detected public IP, or None on failure
        ...
```

Fields whose JSON schema has `"format": "password"` (e.g. `SecretStr`) are
automatically masked on read and preserved on update when the client sends the
mask back.
