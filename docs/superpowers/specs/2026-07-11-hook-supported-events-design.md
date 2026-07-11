# Hooks Declare Supported Events — Design Spec

**Date:** 2026-07-11
**Status:** Approved

## Overview

The set of event types a hook can handle is a property of the hook's implementation, but today
it is a single global tuple `SUPPORTED_EVENTS = ('reachability_changed', 'ip_changed')`. The
`/hooks` API returns that full list for every hook, so the UI lets a user enable, say,
`reachability_changed` on the Router Firewall hook — which silently no-ops. And
`dispatch_hooks` only checks the user-enabled `hook_cfg.events`, never what the hook actually
supports.

This makes each `Hook` subclass declare its supported events, surfaces only those in the UI
(with friendly labels), validates hook configs against them, and adds a scheduler guard so a
hook is never invoked for an event it doesn't support.

## Backend

### `tether_ddns/hooks/base.py`

- Add a class attribute to `Hook`:
  ```python
  supported_events: tuple[str, ...] = SUPPORTED_EVENTS
  ```
- Add a central label map:
  ```python
  EVENT_LABELS: dict[str, str] = {
      'ip_changed': 'IP Changed',
      'reachability_changed': 'Reachability Changed',
  }
  ```

### Hook implementations

- `LogHook.supported_events = SUPPORTED_EVENTS` (explicit; it logs any event).
- `RouterFirewallHook.supported_events = ('ip_changed',)`.

### `tether_ddns/api.py` — `/hooks`

Return each hook's own supported events as `{key, label}` objects:

```python
{
    'key': k,
    'display_name': c.display_name,
    'events': [
        {'key': e, 'label': EVENT_LABELS.get(e, e)}
        for e in c.supported_events
    ],
    'schema': c.config_schema(),
}
```

### `tether_ddns/api.py` — hook config validation

In both `create_hook` and `update_hook`, before persisting:

- If `payload.hook` is not in `HOOK_REGISTRY`, raise `HTTPException(400, 'unknown hook <hook>')`.
- If any event in `payload.events` is not in that hook's `supported_events`, raise
  `HTTPException(400, 'unsupported event <event> for hook <hook>')`.

A shared helper validates and is called by both handlers.

### `tether_ddns/scheduler.py` — `dispatch_hooks` guard

Resolve the hook class first, then skip unless the event is both user-enabled and supported:

```python
for hook_cfg in cfg.hooks:
    hook_cls = HOOK_REGISTRY.get(hook_cfg.hook)
    if hook_cls is None:
        _log.warning('Unknown hook %s', hook_cfg.hook)
        continue
    if (not hook_cfg.enabled
            or event.type not in hook_cfg.events
            or event.type not in hook_cls.supported_events):
        continue
    try:
        config = hook_cls.ConfigModel.model_validate(hook_cfg.config)
        await hook_cls().handle(event, config)
    except Exception:  # noqa: BLE001 - hook errors must be contained
        _log.exception('Hook %s failed on %s', hook_cfg.hook, event.type)
```

This is defense-in-depth: even a stale stored config listing an unsupported event will not
invoke the hook for that event.

## Frontend

### `frontend/src/types.ts`

```ts
export interface HookEventDef { key: string; label: string; }
export interface HookDef {
  key: string;
  display_name: string;
  events: HookEventDef[];
  schema: Record<string, unknown>;
}
```

### `frontend/src/components/HookModal.tsx`

- `availableEvents` is now `HookEventDef[]`.
- Render each event's `label` (instead of the raw key) in the events switch-row; toggle and
  store by `key`. `form.events` remains `string[]` of event keys.
- Because the backend only returns supported events, the modal inherently cannot offer an
  unsupported one.

## Testing

**Python (`test/unit/`):**
- `RouterFirewallHook.supported_events == ('ip_changed',)` and `LogHook.supported_events`
  contains both event types.
- `GET /hooks` returns the router firewall hook with exactly one event object
  `{'key': 'ip_changed', 'label': 'IP Changed'}`.
- `POST /hooks-config` with an unsupported event (e.g. `reachability_changed` on
  `router_firewall`) returns 400; `PUT` likewise.
- `POST /hooks-config` with a valid event succeeds.
- `dispatch_hooks`: given a stored config that (staleley) enables an unsupported event for a
  spy hook, the hook's `handle` is not awaited for that event; it IS awaited for a supported,
  enabled event. (Use a temporary registered spy hook with a recording `handle`.)

**Frontend (Vitest, `frontend/src/components/HookModal.test.tsx`):**
- Given a `HookDef` whose `events` are `{key,label}` objects, the modal renders the labels and,
  on toggling, includes the event keys in the saved value.
- Selecting a hook with fewer supported events shows only those events.

## Out of Scope

- Adding new event types or changing when/how events fire.
- Pruning unsupported events from existing stored hook configs (the scheduler guard makes this
  unnecessary; stored data is left untouched).
- Any change to provider configs.
