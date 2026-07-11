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

- Periodic reachability + **dual-stack** public-IP detection (IPv4 and IPv6)
  with exception-isolated jobs.
- Pluggable **DDNS providers** (DuckDNS and Cloudflare included), **hooks**
  (log and ZTE router-firewall hooks included), and **IP sources** (ipify /
  icanhazip included).
- Hooks declare the event types they support; the UI only offers those, and a
  per-hook **Run now** button triggers a hook on demand against current state.
- Config forms are generated from each plugin's JSON schema, with friendly
  field titles and enum labels declared via a small `labeled_field` helper.
- Secrets stored as `pydantic.SecretStr`: write-only over the API, masked
  (`********`) on read, real values only on disk.
- Live logs and state over a WebSocket to the SPA; application logs are also
  printed to stdout alongside uvicorn's own output.

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
- `TETHER_DDNS_HOST` / `TETHER_DDNS_PORT` — bind address for the server
  (defaults `0.0.0.0` / `8000`). CLI flags `--host` / `--port` override these:
  `python -m tether_ddns --port 9000`. Precedence is CLI flag > env var >
  default. Changing the port matters mainly under Docker host networking, where
  port remapping is unavailable.

## Docker

A multi-stage Alpine image (frontend build + Python venv → slim non-root
runtime) and a `docker-compose.yml` that auto-builds it are included:

```bash
docker compose up -d          # builds the image and serves on :8000
```

Config persists in the `tether-config` named volume (mounted at `/data`, via
`TETHER_DDNS_CONFIG_PATH=/data/tether-ddns.json`). For better router/LAN
reachability and public-IP detection you can switch the service to host
networking — see the commented `network_mode: host` note in
`docker-compose.yml`.

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
from tether_ddns.hooks.base import (
    Hook, IpChangedEvent, ReachabilityChangedEvent, register_hook)


@register_hook
class MyHook(Hook):
    key = 'myhook'
    display_name = 'My Hook'

    # Override only the event methods you care about. The events a hook
    # supports are inferred from which on_* methods it overrides; the UI only
    # offers those, and the scheduler never dispatches an unsupported event.
    async def on_ip_changed(
            self, event: IpChangedEvent, config: BaseModel) -> None:
        # react to a public IP change (event.new_ip, event.family)
        ...

    async def on_reachability_changed(
            self, event: ReachabilityChangedEvent, config: BaseModel) -> None:
        # react to an online/offline transition (event.online)
        ...
```

Hooks may also override `on_domain_update_pending`, `on_domain_update_success`,
and `on_domain_update_error` to react to a specific domain's update outcome.

To give a config model friendly field titles and enum labels in the UI, declare
fields with `Annotated[..., labeled_field(...)]`:

```python
from typing import Annotated, Literal
from pydantic import BaseModel
from tether_ddns.schema_fields import labeled_field


class MyConfig(BaseModel):
    protocol: Annotated[
        Literal['tcp', 'udp', 'tcp_udp'],
        labeled_field(
            title='Protocol',
            labels={'tcp': 'TCP', 'udp': 'UDP', 'tcp_udp': 'TCP + UDP'}),
    ] = 'udp'
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
