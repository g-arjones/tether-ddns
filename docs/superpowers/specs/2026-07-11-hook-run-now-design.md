# "Run Now" Button on Hook Rows — Design Spec

**Date:** 2026-07-11
**Status:** Approved

## Overview

There is no way to manually trigger a configured hook; a hook only runs when the scheduler
detects a real transition (IP change or reachability change). This makes hooks hard to test and
prevents an on-demand "re-apply" (e.g. re-push the current IP to the router firewall). This
adds a "Run now" button on each hook row that fires the hook against the current runtime state.

**Depends on:** the hook-supported-events feature (`Hook.supported_events`) — the run endpoint
filters events by it.

## Backend

### New endpoint — `POST /api/hooks-config/{hook_id}/run`

In `tether_ddns/api.py`:

- Find the stored hook config by `hook_id`; if none, `HTTPException(404, 'hook not found')`.
- Resolve the hook class from `HOOK_REGISTRY`; if unknown, `HTTPException(400, 'unknown hook <hook>')`.
- Delegate to a shared helper (see below) that fires the hook for each enabled + supported
  event, using current runtime values, and returns a result.
- Response shape: `{'ran': int, 'skipped': list[str]}` where `ran` is the number of `handle`
  invocations and `skipped` lists event keys that could not fire because a required runtime
  value was unknown. Always HTTP 200 on a valid hook (even when `ran == 0`).

### Shared helper — `tether_ddns/scheduler.py`

Add a function that both the endpoint uses and that mirrors `dispatch_hooks`' isolation:

```python
async def run_hook_now(
    hook_cfg: HookConfig, cfg: AppConfig, state: RuntimeState,
) -> dict[str, object]:
    """Fire a single hook for its enabled+supported events using current state.

    Returns {'ran': <invocations>, 'skipped': [<event keys skipped>]}.
    """
```

Behavior:

- Resolve `hook_cls = HOOK_REGISTRY.get(hook_cfg.hook)`. (The API layer already 400s on unknown
  hooks; if `None` here, return `{'ran': 0, 'skipped': list(hook_cfg.events)}`.)
- Build the model config once via `hook_cls.ConfigModel.model_validate(hook_cfg.config)`.
- For each `event_type` in `hook_cfg.events` that is also in `hook_cls.supported_events`:
  - `reachability_changed`: `value = 'online' if state.online else 'offline'`; fire
    `HookEvent(type='reachability_changed', old=value, new=value)`.
  - `ip_changed`: for each known family value in `(state.public_ipv4, state.public_ipv6)` that
    is not `None`, fire `HookEvent(type='ip_changed', old=ip, new=ip)`. If both are `None`,
    add `'ip_changed'` to `skipped` and fire nothing for it.
  - Each `await hook_cls().handle(event, config)` is wrapped so exceptions are logged and
    contained (same `except Exception` pattern as `dispatch_hooks`); a contained failure still
    counts as an invocation attempt in `ran`.
- Events in `hook_cfg.events` that are NOT in `supported_events` are ignored (not counted, not
  in `skipped`) — the config UI shouldn't allow them, and the guard is defense-in-depth.

Rationale for firing `ip_changed` once per known family: hooks self-filter by address family
(the router firewall applies the IPv6 event and skips IPv4; the log hook logs both), so
re-applying every known family reflects reality without the endpoint needing family logic.

## Frontend

### `frontend/src/api.ts`

```ts
runHook(id: string): Promise<{ ran: number; skipped: string[] }>
// POST /api/hooks-config/{id}/run
```

### `frontend/src/App.tsx` — hook row

- Add a **"Run now"** button before "Edit" in each `.hook-row`.
- On click: `const res = await api.runHook(h.id);` then show a toast:
  - `res.ran > 0`: success toast, e.g. `Ran ${res.ran} action(s)`.
  - `res.ran === 0`: info toast explaining nothing ran, e.g.
    `Nothing to run (no enabled events or IP unknown)`.
- Disable the button while the request is in flight (local per-row pending state) to prevent
  double-fires.
- The button is always shown; no per-row enable/disable based on the hook's event config —
  the `ran: 0` toast covers the empty case.

## Testing

**Python (`test/unit/`):**
- `run_hook_now` (or the endpoint) invokes a spy hook's `handle` once per enabled + supported
  event using current runtime IP/online values; `ran` equals the invocation count.
- With `ip_changed` enabled and both `public_ipv4` and `public_ipv6` set, the spy is invoked
  twice for `ip_changed` (once per family).
- With `ip_changed` enabled but no known IP, `handle` is not invoked for it and `'ip_changed'`
  is in `skipped`.
- An enabled-but-unsupported event does not invoke `handle` and is not counted.
- `POST /api/hooks-config/{id}/run` returns 404 for an unknown id and the result dict for a
  valid one. (Use a temporary registered spy hook with a recording `handle`.)

**Frontend (Vitest):**
- Clicking "Run now" calls `api.runHook` with the row's id and shows a success toast when
  `ran > 0`.
- When `ran === 0`, the info toast is shown.

## Out of Scope

- Scheduling or repeating manual runs.
- A UI to choose custom `old`/`new` values or a specific event to fire.
- Running hooks that are not saved in the configuration.
- Changing how the scheduler fires events on real transitions.
