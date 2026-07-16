# Generic `Hook` & `DDNSProvider` over config type — design

Date: 2026-07-16
Status: approved (brainstorm complete)
Branch: `refactor/generic-plugin-config`

## Summary

Make the `DDNSProvider` and `Hook` base classes **generic over their config
model type** using PEP 695 native syntax (`class Hook[ConfigT: BaseModel]`). The
concrete config type flows into method signatures, so subclass handlers receive
an already-typed `config` and the `assert isinstance(config, X)` guards are
deleted. `ConfigModel` (used for schema generation and `model_validate`) is
unchanged — the type parameter is a purely static-typing device.

## Motivation

Every provider/hook handler currently takes `config: BaseModel` and opens with
`assert isinstance(config, SomeConfig)` to recover the concrete type before
accessing fields. That runtime assertion exists only to satisfy the type
checker; callers always pass the matching `ConfigModel`. Parameterizing the base
classes lets the type system carry the concrete config type, removing the
boilerplate and catching wrong-config mistakes statically instead of at runtime.

## Design

### Base classes

`DDNSProvider` becomes generic:

```python
class DDNSProvider[ConfigT: BaseModel](ABC):
    key: str = ''
    display_name: str = ''
    ConfigModel: type[BaseModel] = EmptyConfig
    ...
    @abstractmethod
    async def update(
        self, hostname: str, record_type: str, ip: str, config: ConfigT,
    ) -> str: ...
```

`Hook` becomes generic; every `on_*` handler and `handle()` take `config: ConfigT`:

```python
class Hook[ConfigT: BaseModel](ABC):
    ...
    async def on_ip_changed(
            self, event: IpChangedEvent, config: ConfigT) -> None: ...
    # on_reachability_changed, on_domain_update_pending/success/error, handle()
```

### Subclasses

- `CloudflareProvider(DDNSProvider[CloudflareConfig])` — `config: CloudflareConfig`, drop assert.
- `DuckDNSProvider(DDNSProvider[DuckDNSConfig])` — `config: DuckDNSConfig`, drop assert.
- `PushoverHook(Hook[PushoverConfig])` — 4 handlers typed `config: PushoverConfig`, drop 4 asserts.
- `RouterFirewallHook(Hook[RouterFirewallConfig])` — `on_ip_changed` typed, drop assert.
- `LogHook(Hook[EmptyConfig])` — handlers typed `config: EmptyConfig` (config ignored).

### Tests

The 8 spy `Hook` subclasses in `test/unit/test_scheduler.py` become
`Hook[EmptyConfig]` with handler params typed `config: EmptyConfig`.

### Docs

README plugin-author examples (~L155, ~L181) show the generic base and omit the
`isinstance` assertion.

## Unchanged by design

- **Registries** stay `dict[str, type[DDNSProvider]]` / `type[Hook]`
  (unparameterized → implicit `Any` type argument). No edits.
- **Callers** (`services/sync.py`, `services/dispatch.py`) hold a `type[...]`,
  build `config` via `ConfigModel.model_validate(...)`, and call
  `.update()`/`.handle()`. The validated instance satisfies the `Any`-arg
  signature — no edits.
- `config_schema()`, `supported_events()`, and `handle()` routing logic keep
  their current semantics.

## Type-safety notes

- Overrides use the *specialized* base (`Hook[PushoverConfig]`), so narrowing
  `config` to the concrete type is an exact match, not an LSP violation.
- `handle()` receives `config: ConfigT` and forwards to the matching `on_*`
  handler — internally consistent per specialization.

## Error handling

No behavioral change. Removing the asserts removes an `AssertionError` path that
was unreachable in practice; wrong-config bugs are now caught statically.

## Testing / verification

1. **Tooling probe first:** confirm PEP 695 syntax is accepted by the pinned
   mypy, pyright, ruff, and flake8 before broad edits. (User chose native; if any
   tool rejects it we revisit, otherwise proceed.)
2. `pytest test/test_mypy.py test/test_pyright.py test/test_ruff.py test/test_flake8.py`
3. Full `pytest` suite (existing provider/hook/dispatch/scheduler tests).

## Out of scope

- Parameterizing the registries or callers.
- Any change to `IPSource` (it has no `ConfigModel`).
- Behavioral changes to schema generation or event routing.
