# Services + AppContext refactor — design

Date: 2026-07-14
Status: approved (brainstorm complete)
Branch: `refactor/services-appcontext`

## Summary

Restructure `api.py` and `scheduler.py` around a small, framework-free
application context and class-based services, and move hook-event payload
construction onto the event types themselves. The work ships as **two tiers**,
each a separate commit landing on green gates. A third, purely organizational
tier (splitting `api.py` into an `api/` package) is explicitly **deferred**.

This is a behavior-preserving refactor: provider/hook error isolation, dispatch
semantics, freshness/retry rules, and all HTTP responses stay identical. Only the
internal structure changes.

## Motivation

Two modules concentrate most of the complexity:

- `scheduler.py` — `run_hook_now` contains a ~70-line `if/elif` per event key that
  reconstructs each event payload from current state. Adding a hook event type
  forces edits here, in the live dispatch path, and in `EVENT_SPECS`. Five
  near-identical `dispatch_*` one-line wrappers add further duplication.
- `api.py` — four copy-pasted "find item by id or 404" loops across domains and
  hooks; route bodies mix HTTP concerns with domain logic; shared state is reached
  via `app.state` in a FastAPI-specific way that the scheduler cannot reuse.

The highest-value fix (distributing event synthesis) is small and contained. The
service/context reorganization is a moderate, mostly-ergonomic improvement that
also unlocks cleaner constructor-injected testing.

## Layers

- **Model** — `AppConfig`/`DomainConfig`/`HookConfig` (config.py), `RuntimeState`
  (runtime.py), `ConfigStore`. Unchanged.
- **Context** — `AppContext`: a framework-free dataclass bundling the shared
  mutable state, importable by both `api.py` and `scheduler.py`.
- **Service** — `DispatchService`, `SyncService`, plus the existing
  `ReachabilityService`. Class-based; each owns the context.
- **View / Controller** — remain in `api.py` for this design (route handlers +
  masking/catalog helpers). No package split.
- **Scheduler** — a thin peer caller of `SyncService`; owns only APScheduler
  bookkeeping (`_publish_next_check`, job registration).

## Key decisions

1. **`AppContext` is the foundation, introduced in Tier 1.** A `@dataclass`
   holding `config`, `runtime`, `store`, `manager`, with `persist()` and
   `rebuild()`. Built once in `app.py`'s lifespan (the sole composition root),
   stored on `app.state.ctx`, and passed to the `Scheduler` and services. This
   replaces the earlier idea of a FastAPI-bound context, because the scheduler has
   no `app.state`.

2. **Events synthesize their own payloads.** Each event type in `hooks/base.py`
   gains `from_context(cls, ctx) -> list[HookEventBase]`. An empty list means
   "nothing to fire" (skipped). `run_hook_now` becomes a generic loop over
   `EVENT_SPECS[event_key].model.from_context(ctx)` with **no** event-specific
   branches. Adding an event type = new class + one `EVENT_SPECS` entry.

   **Boundary:** `from_context` serves only the manual "fire as if now" path
   (`run_hook_now`). The live path (`sync_ips`) still builds events at the
   transition moment because it has the real `old_ip → new_ip` transition, which
   cannot be reconstructed after the fact. These are genuinely different events
   (real transition vs. synthetic snapshot) and stay separate.

3. **Class-based services own the context; no free functions.** `DispatchService`
   and `SyncService` take the context (and collaborators) in `__init__` and read
   `self._ctx.config`/`self._ctx.runtime`, mirroring `ReachabilityService`.

4. **Service-to-service DI with the concrete type.** `SyncService` receives a
   concrete `DispatchService` (no Protocol/interface — avoids over-abstraction for
   a single implementation). All wiring happens in the `app.py` composition root;
   services never construct their own collaborators. The dependency graph stays a
   DAG: `Scheduler → SyncService → DispatchService → AppContext → Model`.

5. **`sync_domain` lives in `SyncService`, not a controller.** It has two callers —
   the `/domains/{id}/sync` endpoint and `Scheduler.sync_ips`. Controllers depend
   on services, never the reverse. The manual endpoint's "ensure an IP (from
   runtime or `detect_public_ip` fallback, then mutate runtime) and sync one
   domain" logic becomes `SyncService.sync_one_now(domain)`, keeping the route thin.

6. **Clean break — no compatibility shims.** Because tests are migrated as part of
   this work, `scheduler.py` will not keep re-export aliases for `sync_domain`,
   `dispatch_*`, or `run_hook_now`. Symbols move to their new homes and all imports
   and `patch()` targets are updated.

## Tiers

### Tier 1 — foundation + event synthesis (commit 1)

- `context.py`: `AppContext`.
- `hooks/base.py`: `from_context` classmethods on `IpChangedEvent`,
  `ReachabilityChangedEvent`, `DomainUpdatePendingEvent`,
  `DomainUpdateSuccessEvent`, `DomainUpdateErrorEvent`.
- `services/dispatch.py`: `DispatchService(ctx)` — `dispatch(event_key, event)`
  plus the generic branch-free `run_hook_now(hook_cfg)`.
- `services/collection.py`: `find_or_404(items, id, detail) -> (index, item)`.
- `api.py`: use `find_or_404` in the four domain/hook update+delete sites.
- `app.py`: build `AppContext` + `DispatchService` in the composition root.

`DispatchService` is in Tier 1 (not Tier 2) because `run_hook_now` depends on
`from_context(ctx)`, and both depend on `AppContext`. They are inseparable.

### Tier 2 — sync extraction + thin scheduler (commit 2)

- `services/sync.py`: `SyncService(ctx, dispatch)` — `sync_domain`,
  `refresh_public_ips`, `sync_ips`, `_sync_one`, `sync_one_now`.
- `scheduler.py`: thin `Scheduler(ctx, sync, reachability)` delegating job bodies;
  retains `start`/`reschedule_sync`/`run_startup_check`/`shutdown`/
  `_publish_next_check`.
- `api.py`: `/domains/{id}/sync` route delegates to `SyncService.sync_one_now`.
- `app.py`: extend composition root with `SyncService` and the reshaped
  `Scheduler`.

## Data flow

```
app.py (composition root)
  builds AppContext(config, runtime, store, manager)
  builds DispatchService(ctx)
  builds SyncService(ctx, dispatch)              [Tier 2]
  builds Scheduler(ctx, sync, ReachabilityService())  [Tier 2]

Scheduler.sync_ips ──▶ SyncService.sync_ips ──▶ SyncService.sync_domain
                                           └──▶ DispatchService.dispatch
api route /domains/{id}/sync ──▶ SyncService.sync_one_now ──▶ sync_domain
api route /hooks-config/{id}/run ──▶ DispatchService.run_hook_now
                                        └──▶ Event.from_context(ctx)
```

## Error handling

Unchanged and preserved verbatim:

- `sync_domain` wraps provider calls in `except Exception` and records an `error`
  status; provider failures must not escape.
- `dispatch` / `run_hook_now` isolate each hook invocation in `except Exception`;
  one failing hook must not stop others.
- HTTP error mapping (`404` for missing domain/hook, `503` when a public IP is
  unknown, `400` for unknown hook/unsupported event) stays in the route/controller
  layer.

## Testing

Test-driven (RED-GREEN) for each new unit:

- `AppContext`: `persist()` writes via the store; `rebuild()` persists then
  rebuilds runtime.
- Each `from_context`: correct payloads built from state; empty-list ⇒ skipped
  semantics (no IP known, no matching domain status).
- `find_or_404`: returns `(index, item)` on hit; raises `HTTPException(404)` on miss.
- `DispatchService`: only enabled + subscribed + supported hooks fire; exceptions
  isolated; `run_hook_now` returns `{'ran', 'skipped'}` correctly.
- `SyncService`: `sync_domain` status transitions; `sync_ips` freshness/retry/
  enabled rules and dispatch-on-transition (with an `AsyncMock` dispatch spy);
  `sync_one_now` IP-ensure fallback.

Existing `test_scheduler.py` / `test_api.py` scenarios are **migrated** (not
deleted) to the new shapes to guarantee behavior parity. Because of the clean
break, module-level `patch()` targets move to the new service modules and call
sites construct services with an `AppContext` fixture.

Gates run and must pass at the end of **each** tier commit:

1. `pytest test/ --cov=tether_ddns --cov-fail-under=90`
2. `flake8 test/ tether_ddns/` and `ruff check .`
3. `mypy .` and `pyright` (strict)
4. Manual smoke: uvicorn boot; `/api/state`, `/api/domains` CRUD,
   `/api/hooks-config/{id}/run`, WebSocket `/api/ws` frames.

## Scope

- **In:** `context.py` (new), `services/` package (new: `collection.py`,
  `dispatch.py`, `sync.py`), `hooks/base.py` event builders, `scheduler.py`
  reshape, `api.py` delegation, `app.py` composition root, test migration.
- **Deferred (Tier 3):** split `api.py` into an `api/` package with
  `controllers/`, `schemas.py`, `serializers.py`, and a `CatalogService`.
- **Out entirely:** `ws.py` internals, the provider/hook/ip-source plugin system,
  the frontend.

## Delivery

- Work on branch `refactor/services-appcontext`.
- Tier 1 and Tier 2 land as separate commits, each on fully green gates.
- Each tier gets its own implementation plan under `docs/superpowers/plans/`.
