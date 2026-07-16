# Auto-derive `ConfigModel` from the generic parameter — design

Date: 2026-07-16
Status: approved (brainstorm complete)
Branch: `refactor/generic-plugin-config`

## Summary

Remove the DRY violation introduced by making `DDNSProvider` and `Hook` generic:
each plugin currently names its config type twice — once as the generic argument
(`DDNSProvider[CloudflareConfig]`) and again as a class attribute
(`ConfigModel = CloudflareConfig`). Introduce a small shared reflection module
that reads the generic argument at class-creation time via `__orig_bases__` and
populates `ConfigModel` automatically, so subclasses declare the config type
**once** (as the generic argument only).

## Motivation

`ConfigModel` and the generic argument can silently drift (write
`DDNSProvider[ConfigA]` but `ConfigModel = ConfigB` and nothing catches it). The
duplication is also just noise. PEP 695 records the specialized base in
`cls.__orig_bases__`, so the concrete config type is available at runtime and can
be the single source of truth.

## Design

### New module: `tether_ddns/plugin_config.py`

Houses three things shared by both plugin families:

```python
from typing import get_args, get_origin
from pydantic import BaseModel


class EmptyConfig(BaseModel):
    """Default config model for plugins without configuration."""


def derive_config_model(
        cls: type, default: type[BaseModel]) -> type[BaseModel]:
    """Return the BaseModel named as `Base[Config]` in cls.__orig_bases__.

    Falls back to `default` when the subclass does not specialize the base
    (e.g. a bare `class Foo(Hook)`), preserving inherited/default behavior.
    """
    for base in getattr(cls, '__orig_bases__', ()):
        origin = get_origin(base)
        if (origin is not None and isinstance(origin, type)
                and issubclass(origin, ConfigModelMixin)):
            args = get_args(base)
            if args and isinstance(args[0], type) \
                    and issubclass(args[0], BaseModel):
                return args[0]
    return default


class ConfigModelMixin:
    """Auto-populate `ConfigModel` from the generic argument on subclassing."""

    ConfigModel: type[BaseModel] = EmptyConfig

    def __init_subclass__(cls, **kwargs: object) -> None:
        super().__init_subclass__(**kwargs)
        cls.ConfigModel = derive_config_model(cls, cls.ConfigModel)
```

`derive_config_model` references `ConfigModelMixin` by name; because the name is
resolved at call time (only ever during subclass creation), definition order
within the module is not a concern.

### Base classes

Both bases mix in `ConfigModelMixin` and drop their hand-written
`ConfigModel: type[BaseModel] = EmptyConfig` line (now inherited) and their local
`EmptyConfig` class (now imported):

```python
# tether_ddns/providers/base.py
from tether_ddns.plugin_config import ConfigModelMixin, EmptyConfig as EmptyConfig

class DDNSProvider[ConfigT: BaseModel](ConfigModelMixin, ABC):  # noqa: D101
    key: str = ''
    display_name: str = ''
    # ConfigModel inherited from ConfigModelMixin, auto-derived per subclass
```

`Hook` changes identically (`class Hook[ConfigT: BaseModel](ConfigModelMixin, ABC)`).

`EmptyConfig` is **re-exported** from both base modules using the redundant-alias
form (`import EmptyConfig as EmptyConfig`) so existing imports
(`from tether_ddns.hooks.base import EmptyConfig`, `base.EmptyConfig` in tests)
keep working, and both ruff (F401) and pyright (reportUnusedImport) treat it as an
intentional re-export.

### Subclasses

Every concrete plugin drops its `ConfigModel = X` line; the `Base[X]` generic
argument already carries the type. The `update()` / `on_*()` signatures that use
the concrete config type are unchanged.

- `CloudflareProvider(DDNSProvider[CloudflareConfig])` — drop `ConfigModel = CloudflareConfig`.
- `DuckDNSProvider(DDNSProvider[DuckDNSConfig])` — drop `ConfigModel = DuckDNSConfig`.
- `PushoverHook(Hook[PushoverConfig])` — drop `ConfigModel = PushoverConfig`.
- `RouterFirewallHook(Hook[RouterFirewallConfig])` — drop `ConfigModel = RouterFirewallConfig`.
- `LogHook(Hook[EmptyConfig])` — already has no `ConfigModel` line; resolves to `EmptyConfig`.

### Docs

README provider and hook authoring examples drop the `ConfigModel = MyConfig`
line and note that the config type is taken from the generic argument.

## Behavior across cases (verified by runtime probe)

| Subclass | Resolved `ConfigModel` |
|---|---|
| `Provider[CfgA]` | `CfgA` |
| `Hook[CfgB]` | `CfgB` |
| `Hook[EmptyConfig]` | `EmptyConfig` |
| bare `class Foo(Hook)` | `EmptyConfig` (default) |
| base `DDNSProvider` / `Hook` themselves | `EmptyConfig` (default) |
| `class Sub(ConcreteProvider)` (no re-specialization) | inherits parent's derived model |

## Unchanged by design

- Generic typing of the bases, registries (`type[...[Any]]`), and the generic
  `register_*` decorators — all from the prior refactor.
- Callers: `sync.py` / `dispatch.py` still read `cls.ConfigModel` and call
  `model_validate(...)` — `ConfigModel` is still a real class attribute, just
  populated reflectively.
- `config_schema()` semantics.
- The two previously-consolidated `EmptyConfig` classes become one; no code
  relied on them being distinct.

## Testing / verification

1. New `test/unit/test_plugin_config.py`: `derive_config_model` returns the
   specialized model, falls back to the default for a bare subclass, and the
   mixin populates `ConfigModel` on subclassing (specialized, empty, bare,
   inheritance-chain cases).
2. Existing suites unchanged and green:
   `test_provider_registry` (incl. `_NoConfig.ConfigModel is EmptyConfig`),
   `test_hook_registry`, `test_cloudflare`, `test_duckdns`, `test_pushover`,
   `test_router_firewall_hook`, `test_scheduler`, `test_dispatch_service`,
   `test_sync_service`.
3. Four gates green (`test_mypy`, `test_pyright`, `test_ruff`, `test_flake8`),
   full backend suite (coverage >=90%), frontend vitest, and Playwright e2e.

## Out of scope

- Any change to `IPSource` (no `ConfigModel` / config-generic).
- Validating that a bare (unspecialized) plugin is intentional — silently
  defaulting to `EmptyConfig` matches today's behavior.
