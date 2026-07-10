# Tether DDNS — Design Spec

**Date:** 2026-07-10
**Status:** Approved (architecture); pending final spec review

## 1. Overview

Tether DDNS is a self-hosted dynamic DNS updater. A FastAPI backend runs periodic
tasks (internet reachability check, public IP detection, DDNS record updates) using
APScheduler embedded in the uvicorn event loop. The backend also serves the static
files produced by a Vite build of a React + TypeScript single-page app.

The first version is **stateless**: only user configuration is persisted (as JSON on
disk). All runtime state (domain sync status, current public IP, reachability,
scheduled jobs) is rebuilt from configuration on application start.

### Key decisions (from brainstorming)

- **Frontend:** React + Vite + TypeScript.
- **Realtime transport:** a single WebSocket carries both log records and state/status
  events (push). REST is used for mutations and initial snapshots.
- **Secrets:** provider credentials are stored in plaintext in the config JSON but are
  **write-only over the API** — never returned to the frontend; read responses mask them.
- **V1 plugin scope:** one DDNS provider (DuckDNS) and one example hook, to establish
  the plugin framework end-to-end.
- **Logs:** captured by a custom `logging.Handler` into an in-memory ring buffer
  (last N records) and pushed over the WebSocket. Nothing persisted to disk.
- **Exception isolation:** exceptions raised inside a provider `update()` or a hook
  handler are caught, logged via uvicorn logging, and surfaced without crashing the
  app or the scheduler.

## 2. Architecture

```
Browser (React + Vite SPA)
  |  fetch (REST /api/*)        <-- mutations, snapshots
  |  websocket (/api/ws)        <-- logs + state events (push)
  v
FastAPI (uvicorn + APScheduler)
  - Static file serving (vite build output)
  - REST API (/api/*)
  - WebSocket (/api/ws)
  - APScheduler jobs (reachability / public-IP / DDNS sync)
  - Provider & Hook registries (auto-loaded plugins)
  - ConfigStore (pydantic models <-> JSON on disk)
  - Ring-buffer logging handler (fans out to WS)
```

On startup (FastAPI lifespan): load config -> build runtime state -> auto-load
plugins -> start scheduler. On shutdown: stop scheduler, close WS connections.

## 3. Backend components

Package: `tether_ddns/` (Python 3.12, strict typing — flake8, mypy, pyright strict, ruff).

### 3.1 Configuration — `config.py`
- Pydantic models:
  - `DomainConfig`: `id` (uuid4 string, synthetic key), `hostname`, `provider`
    (registry key), `record_type` (`A`/`AAAA`), `ttl`, `enabled`, `update_period`
    (seconds), and `provider_config` (dict validated against the chosen provider's
    `ConfigModel`).
  - `HookConfig`: `id`, `hook` (registry key), `enabled`, `events` (subset of
    supported events), and `config` (dict validated against the hook's config model).
  - `AppSettings`: `check_interval` (seconds), `ip_source`, `update_on_startup`,
    `retry_on_failure`, `notify`.
  - `AppConfig`: `settings`, `domains: list[DomainConfig]`, `hooks: list[HookConfig]`.
- `ConfigStore`: resolves path from `TETHER_DDNS_CONFIG_PATH` env var, else
  `./tether-ddns.json` in cwd. Handles load (missing file -> defaults), atomic save
  (temp file + rename), and validation. Thread/async-safe writes via a lock.
- Secret handling: secret fields declared via `pydantic.SecretStr`. Serialization for
  the API masks secrets (e.g. `"********"`); disk serialization writes the real value.
  On update, a masked/blank incoming secret means "keep existing".

### 3.2 Provider registry — `providers/base.py`
- `DDNSProvider` ABC:
  - class attribute `key: str`, `display_name: str`.
  - `ConfigModel: type[BaseModel]` — provider-specific config fields.
  - `config_schema() -> dict` — returns JSON schema for dynamic frontend form rendering.
  - `async def update(self, hostname, record_type, ip, config) -> UpdateResult`.
- `@register_provider` class decorator populates `PROVIDER_REGISTRY: dict[str, type[DDNSProvider]]`.
- `UpdateResult`: success flag, resulting IP, message.
- Auto-loading: iterate modules in `providers/ddns_providers/` on startup and import
  them so decorators run. A failing plugin import is logged and skipped.

### 3.3 Providers — `providers/ddns_providers/`
- `duckdns.py`: `DuckDNSProvider` with a `ConfigModel` (token `SecretStr`, domain
  token). Calls the DuckDNS HTTP API via aiohttp.

### 3.4 Hook registry — `hooks/base.py`
- `Hook` ABC:
  - `key`, `display_name`, `ConfigModel`, `config_schema()`.
  - supported events: `reachability_changed` (online<->offline), `ip_changed`.
  - `async def handle(self, event: HookEvent, config) -> None`.
- `@register_hook` decorator populates `HOOK_REGISTRY`.
- `HookEvent`: typed payloads (e.g. old/new IP, old/new reachability).
- Auto-loaded from `hooks/registered_hooks/` similarly to providers.
- Example hook: a "log hook" that logs event details.

### 3.5 Runtime state — `runtime.py`
- Holds: current public IP, reachability (online/offline), and per-domain runtime
  status (`synced` / `pending` / `error` / `paused` / `updating`) with last-updated
  timestamp and last message.
- Rebuilt from config on start. Provides snapshot for WS/REST and mutation helpers
  that emit state events.

### 3.6 Scheduler — `scheduler.py`
- APScheduler `AsyncIOScheduler` bound to the uvicorn loop.
- Jobs:
  - Reachability + public-IP check on `settings.check_interval`. On IP change: update
    runtime, fire `ip_changed` hooks, mark affected enabled domains `pending`, trigger
    their syncs. On reachability transition: fire `reachability_changed` hooks.
  - Per-domain DDNS sync respecting each domain's `update_period`.
- **Exception isolation:** every provider call and hook dispatch is wrapped so a raised
  exception is caught and logged; a provider failure sets the domain status to `error`
  with the message; a hook failure is logged and does not affect other hooks, domains,
  or jobs.

### 3.7 Logging bridge — `logging_bridge.py`
- Custom `logging.Handler` attached to uvicorn's loggers (`uvicorn`, `uvicorn.error`,
  plus the app's own logger). Keeps a bounded `collections.deque` (last N, e.g. 500)
  and fans out each formatted record to connected WS clients.

### 3.8 WebSocket — `ws.py`
- Connection manager. On connect: send buffered logs + current state snapshot, then
  stream deltas (log records and state events). Two message kinds: `log` and `state`.

### 3.9 API + app — `api.py`, `app.py`
- REST endpoints:
  - `GET /api/state` — snapshot (public IP, reachability, settings, domains+status).
  - `GET /api/providers` — list of providers with `display_name` and config JSON schema.
  - `GET /api/hooks` — list of hooks with `display_name`, supported events, config schema.
  - `GET/POST /api/domains`, `PUT/DELETE /api/domains/{id}`, `POST /api/domains/{id}/sync`.
  - `GET/POST /api/hooks-config`, `PUT/DELETE /api/hooks-config/{id}` — configured hook
    instances (the registry list vs configured instances are distinct).
  - `GET/PUT /api/settings`.
  - `POST /api/refresh` — force an immediate IP/reachability check.
  - `WS /api/ws`.
- `app.py`: FastAPI app with lifespan managing scheduler + logging bridge; mounts the
  built SPA (static files) as a catch-all after `/api`.

## 4. Data flow

- **IP-change flow:** IP job detects public IP -> if changed, update runtime, fire
  `ip_changed` hooks, mark affected enabled A/AAAA domains `pending`, schedule syncs ->
  provider `update()` -> status `synced`/`error` -> WS push.
- **Reachability flow:** transition online<->offline updates runtime, fires
  `reachability_changed` hooks, WS event.
- **Logs:** all records from these flows stream live to the frontend.

## 5. Frontend (`frontend/`)

React + TS app reproducing the mockup styling (reuse CSS tokens). Components:
- Header (public IP pill, refresh, settings, theme toggle), Stats grid.
- Domains section: `DomainCard`s (status badge, IP, actions: pause/resume, force sync,
  edit, delete), Add/Edit Domain modal. The provider dropdown drives a **dynamically
  rendered config form** built from the selected provider's JSON schema (fetched from
  `/api/providers`). Secret fields render as password inputs and are write-only.
- **Hooks section (extends the mockup):** a Hooks panel listing configured hooks with
  their events and enabled state, plus an Add/Edit Hook modal that dynamically renders
  the selected hook's config form from `/api/hooks` (same schema-driven approach as
  providers) and lets the user pick which events trigger it.
- Settings modal (interval chips, IP source, behavior toggles).
- **Log viewer:** a live panel showing streamed log records from the WebSocket, seeded
  by the buffered history on connect.
- Toasts, theme toggle (mockup behavior).
- A WebSocket hook keeps state + logs reactive; REST calls for mutations.

## 6. Error handling

- Provider/hook exceptions are isolated (see 3.6): caught, logged via uvicorn logging,
  surfaced as domain `error` status or a logged hook failure. Never crash the app.
- Plugin import failures are logged and skipped; the rest of the registry still loads.
- Config load errors fall back to defaults with a logged warning; save errors are
  logged and returned as API errors.
- API validation errors return standard FastAPI 422 responses.

## 7. Testing

Honor existing lint/type gates (flake8, mypy, pyright strict, ruff). Add pytest tests:
- `ConfigStore` load/save/round-trip, env-var path resolution, secret masking.
- Registry auto-loading (providers + hooks), decorator registration.
- DuckDNS provider `update()` with mocked HTTP (success + failure paths).
- Exception isolation: a provider/hook raising does not crash the scheduler and yields
  the expected `error`/logged outcome.
- API routes via FastAPI `TestClient` / httpx (domains, hooks, settings, providers).
Frontend kept thin; optional Vitest smoke test.

## 8. Out of scope (V1)

- Persistence of runtime state / history across restarts.
- Multiple concrete providers beyond DuckDNS (framework supports adding more).
- Authentication/authorization on the API.
- Encryption of secrets at rest.
