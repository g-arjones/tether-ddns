# Per-Event Hook Methods — Design

**Date:** 2026-07-11
**Status:** Approved

## Problem

The `Hook` base class exposes a single `handle(event: HookEvent, config)` method
for all event types. Every concrete hook must branch internally on `event.type`
and re-derive typed meaning from generic `old`/`new` strings (e.g. the router
firewall hook recomputes `family_of(event.new)`). Adding a new event type or a
new hook is awkward: there is no typed payload, the dispatch contract is
stringly-typed, and hook authors get no compile-time guidance about which events
they handle.

## Goal

Make the hook interface more flexible and easier to extend by providing one
method per event type with a typed payload (e.g.
`on_reachability_changed(event: ReachabilityChangedEvent, config)`), while
keeping the external contract (event key strings, stored config, `/api/hooks`
JSON response) byte-identical.

## Decisions

- **supported_events** is *inferred* from which `on_*` methods a subclass
  overrides. No explicit tuple. The base class provides no-op default
  implementations for every event method.
- **Payloads** are rich, event-specific models with meaningfully named fields.
- **External contract unchanged**: event key strings, stored config, and the
  `/api/hooks` response stay identical. No migration, no frontend change.
- **Central `EVENT_SPECS` registry** in `base.py` maps each event key to its
  label, handler method name, and payload model. `supported_events` inference,
  API labels, and event validation all read from it.

## Design

### 1. Event payload models (`base.py`)

Replace the single `HookEvent` with typed payloads:

```python
class HookEventBase(BaseModel):
    """Base for all hook event payloads."""

class IpChangedEvent(HookEventBase):
    old_ip: str | None = None
    new_ip: str
    family: Literal['ipv4', 'ipv6']

class ReachabilityChangedEvent(HookEventBase):
    online: bool
    was_online: bool | None = None
```

Reachability moves from `'online'`/`'offline'` strings to booleans.

### 2. `Hook` base class

```python
class Hook(ABC):
    key: str = ''
    display_name: str = ''
    ConfigModel: type[BaseModel] = EmptyConfig

    @classmethod
    def config_schema(cls) -> dict[str, object]:
        return cls.ConfigModel.model_json_schema()

    async def on_ip_changed(
            self, event: IpChangedEvent, config: BaseModel) -> None:
        """Default no-op; override to handle IP changes."""

    async def on_reachability_changed(
            self, event: ReachabilityChangedEvent, config: BaseModel) -> None:
        """Default no-op; override to handle reachability changes."""

    @classmethod
    def supported_events(cls) -> tuple[str, ...]:
        return tuple(
            key for key, spec in EVENT_SPECS.items()
            if getattr(cls, spec.method) is not getattr(Hook, spec.method)
        )

    async def _dispatch(
            self, event_key: str, event: HookEventBase,
            config: BaseModel) -> None:
        await getattr(self, EVENT_SPECS[event_key].method)(event, config)
```

- No `@abstractmethod`; a hook is valid if it overrides at least one `on_*`.
- `supported_events` becomes a **classmethod** computed from overrides. Its call
  sites in `api.py` and `scheduler.py` change from `cls.supported_events` to
  `cls.supported_events()`.

### 3. Central `EVENT_SPECS` registry (`base.py`)

```python
@dataclass(frozen=True)
class EventSpec:
    label: str
    method: str
    model: type[HookEventBase]

EVENT_SPECS: dict[str, EventSpec] = {
    'ip_changed': EventSpec(
        'IP Changed', 'on_ip_changed', IpChangedEvent),
    'reachability_changed': EventSpec(
        'Reachability Changed', 'on_reachability_changed',
        ReachabilityChangedEvent),
}
```

Replaces `SUPPORTED_EVENTS` and `EVENT_LABELS`. Adding a new event type = add a
payload class + a base `on_*` no-op + one table entry.

### 4. Scheduler & API call-site updates

- `scheduler.dispatch_hooks` / `run_hook_now`: build the concrete payload
  (`IpChangedEvent(...)` / `ReachabilityChangedEvent(...)`) paired with its event
  key, filter by `supported_events()` ∩ configured events, and invoke
  `hook_cls()._dispatch(event_key, payload, config)`. Reachability logic uses
  booleans instead of `'online'`/`'offline'` strings.
- `api.py`: `EVENT_LABELS.get(e, e)` → `EVENT_SPECS[e].label`;
  `cls.supported_events` → `cls.supported_events()`; `_validate_hook_events`
  reads `supported_events()`.

### 5. Concrete hooks

- `LogHook`: implement both `on_ip_changed` and `on_reachability_changed`
  (or a shared helper) logging the transition.
- `RouterFirewallHook`: implement only `on_ip_changed`; drop the
  `event.type != 'ip_changed'` guard and the `family_of` recomputation, reading
  `event.family` and `event.new_ip` directly.

## Testing

Update `test_hook_registry.py`, `test_router_firewall_hook.py`,
`test_scheduler.py`, and the run-now tests to construct typed payloads and call
the new methods. Add a test asserting `supported_events()` inference for a hook
that overrides only one method.

## Non-goals

- No change to the persisted config format or the frontend.
- No renaming of event key strings.
