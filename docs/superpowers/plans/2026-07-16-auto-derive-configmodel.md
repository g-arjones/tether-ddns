# Auto-derive `ConfigModel` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make each plugin declare its config type once (the generic argument), auto-deriving `ConfigModel` at class-creation via a shared reflection mixin.

**Architecture:** New `tether_ddns/plugin_config.py` holds `EmptyConfig`, a `derive_config_model()` free function that reads `cls.__orig_bases__`, and a `ConfigModelMixin` whose `__init_subclass__` populates `ConfigModel`. `DDNSProvider` and `Hook` mix it in and drop their hand-written `ConfigModel` line; all concrete plugins drop their `ConfigModel = X` line.

**Tech Stack:** Python 3.12+ (PEP 695 generics), Pydantic v2, pytest, mypy, pyright (strict), ruff, flake8.

## Global Constraints

- Target Python `>=3.12`; every module keeps `from __future__ import annotations`.
- PEP 695 native generics (no `typing.Generic`/`TypeVar`).
- The type-parameter-defining base classes keep their short `# noqa: D101`; generic decorators keep `# noqa: D103`. Bare noqa form only (max-line-length = 99).
- No blanket `# type: ignore` (pyright strict `reportUnnecessaryTypeIgnoreComment = error`). Use specific codes only where genuinely needed.
- `EmptyConfig` must remain importable from BOTH `tether_ddns.providers.base` and `tether_ddns.hooks.base` (existing importers + tests). Re-export it with the redundant-alias form `from tether_ddns.plugin_config import EmptyConfig as EmptyConfig` so ruff (F401) and pyright (reportUnusedImport) accept the intentional re-export.
- The consolidated `EmptyConfig` is a SINGLE class; `X.ConfigModel is EmptyConfig` identity must hold for `test_provider_registry`.
- Do NOT change `IPSource`, registries, decorators, callers (`sync.py`/`dispatch.py`), or event routing.

---

### Task 1: Reflection module + tests

**Files:**
- Create: `tether_ddns/plugin_config.py`
- Test: `test/unit/test_plugin_config.py`

**Interfaces:**
- Consumes: `pydantic.BaseModel`, `typing.get_args`, `typing.get_origin`.
- Produces:
  - `class EmptyConfig(BaseModel)`
  - `def derive_config_model(cls: type, default: type[BaseModel]) -> type[BaseModel]`
  - `class ConfigModelMixin` with `ConfigModel: type[BaseModel] = EmptyConfig` and an `__init_subclass__` that sets `cls.ConfigModel = derive_config_model(cls, cls.ConfigModel)`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/test_plugin_config.py`:

```python
"""Tests for the shared plugin-config reflection helpers."""
from pydantic import BaseModel

from tether_ddns.plugin_config import (
    ConfigModelMixin,
    EmptyConfig,
    derive_config_model,
)


class _CfgA(BaseModel):
    """A config."""

    x: int = 1


class _Base[C: BaseModel](ConfigModelMixin):  # noqa: D101
    """A generic base using the mixin."""


class _PlainBase(ConfigModelMixin):
    """A non-generic base using the mixin."""


def test_specialized_subclass_derives_config_model() -> None:
    """A subclass specializing the generic gets that model as ConfigModel."""
    class _Impl(_Base[_CfgA]):
        """Impl."""

    assert _Impl.ConfigModel is _CfgA


def test_empty_specialization_resolves_empty_config() -> None:
    """Specializing with EmptyConfig resolves to EmptyConfig."""
    class _Impl(_Base[EmptyConfig]):
        """Impl."""

    assert _Impl.ConfigModel is EmptyConfig


def test_non_generic_subclass_falls_back_to_default() -> None:
    """A subclass that does not specialize keeps the inherited default."""
    class _Impl(_PlainBase):
        """Impl."""

    assert _Impl.ConfigModel is EmptyConfig


def test_inheritance_chain_preserves_derived_model() -> None:
    """A subclass of a concrete class inherits its derived ConfigModel."""
    class _Impl(_Base[_CfgA]):
        """Impl."""

    class _Sub(_Impl):
        """Sub."""

    assert _Sub.ConfigModel is _CfgA


def test_derive_config_model_returns_default_without_orig_bases() -> None:
    """derive_config_model returns the default for a plain class."""
    class _Plain:
        """Plain."""

    assert derive_config_model(_Plain, EmptyConfig) is EmptyConfig
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `source .venv/bin/activate && pytest test/unit/test_plugin_config.py -q`
Expected: FAIL / collection error — `tether_ddns.plugin_config` does not exist yet.

- [ ] **Step 3: Create the module**

Create `tether_ddns/plugin_config.py`:

```python
"""Shared config-model reflection for plugin base classes."""
from __future__ import annotations

from typing import get_args, get_origin

from pydantic import BaseModel


class EmptyConfig(BaseModel):
    """Default config model for plugins without configuration."""


def derive_config_model(
        cls: type, default: type[BaseModel]) -> type[BaseModel]:
    """Return the model named as `Base[Model]` in cls.__orig_bases__.

    Falls back to `default` when the subclass does not specialize the base.
    """
    for base in getattr(cls, '__orig_bases__', ()):
        origin = get_origin(base)
        if (origin is not None and isinstance(origin, type)
                and issubclass(origin, ConfigModelMixin)):
            args = get_args(base)
            if (args and isinstance(args[0], type)
                    and issubclass(args[0], BaseModel)):
                return args[0]
    return default


class ConfigModelMixin:
    """Auto-populate `ConfigModel` from the generic argument on subclassing."""

    ConfigModel: type[BaseModel] = EmptyConfig

    def __init_subclass__(cls, **kwargs: object) -> None:
        """Derive ConfigModel from the specialized generic base, if any."""
        super().__init_subclass__(**kwargs)
        cls.ConfigModel = derive_config_model(cls, cls.ConfigModel)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pytest test/unit/test_plugin_config.py -q`
Expected: 5 passed (ignore any global coverage-% line on a single-file run).

- [ ] **Step 5: Run the four gates on the new module**

Run: `flake8 tether_ddns/plugin_config.py test/unit/test_plugin_config.py && ruff check tether_ddns/plugin_config.py test/unit/test_plugin_config.py && pyright tether_ddns/plugin_config.py 2>&1 | tail -1 && mypy tether_ddns/plugin_config.py 2>&1 | tail -1`
Expected: all clean / 0 errors.

- [ ] **Step 6: Commit**

```bash
git add tether_ddns/plugin_config.py test/unit/test_plugin_config.py
git commit -m "feat: shared ConfigModelMixin that derives ConfigModel from generic arg"
```

---

### Task 2: DDNSProvider adopts the mixin; provider subclasses drop ConfigModel

**Files:**
- Modify: `tether_ddns/providers/base.py`
- Modify: `tether_ddns/providers/ddns_providers/cloudflare.py`
- Modify: `tether_ddns/providers/ddns_providers/duckdns.py`
- Test: `test_provider_registry`, `test_cloudflare`, `test_duckdns`, four gates.

**Interfaces:**
- Consumes: `ConfigModelMixin`, `EmptyConfig` from `tether_ddns.plugin_config` (Task 1).
- Produces: `DDNSProvider` with `ConfigModel` inherited/auto-derived; `EmptyConfig` re-exported from `tether_ddns.providers.base`.

- [ ] **Step 1: Rewire `providers/base.py`**

Remove the local `class EmptyConfig(BaseModel): ...` definition. Add the import
(redundant-alias re-export) near the other imports:

```python
from tether_ddns.plugin_config import ConfigModelMixin, EmptyConfig as EmptyConfig
```

Change the class declaration to mix in `ConfigModelMixin` and delete the
`ConfigModel: type[BaseModel] = EmptyConfig` line:

```python
class DDNSProvider[ConfigT: BaseModel](ConfigModelMixin, ABC):  # noqa: D101
    """Base class for DDNS provider plugins."""

    key: str = ''
    display_name: str = ''

    @classmethod
    def config_schema(cls) -> dict[str, object]:
        """Return the JSON schema for this provider's configuration."""
        return cls.ConfigModel.model_json_schema()
    ...
```

Keep `from pydantic import BaseModel` (still used by `[ConfigT: BaseModel]` and
`config: ConfigT`). Keep `from typing import Any` and the registry/decorator.

- [ ] **Step 2: Drop `ConfigModel` from provider subclasses**

In `cloudflare.py`, delete the line `ConfigModel = CloudflareConfig` from
`CloudflareProvider`. In `duckdns.py`, delete `ConfigModel = DuckDNSConfig` from
`DuckDNSProvider`. Leave the `DDNSProvider[XConfig]` base and the `update()`
signatures untouched.

- [ ] **Step 3: Run provider tests + gates**

Run: `pytest test/unit/test_provider_registry.py test/unit/test_cloudflare.py test/unit/test_duckdns.py test/test_mypy.py test/test_pyright.py test/test_ruff.py test/test_flake8.py -q`
Expected: all pass. In particular `test_default_config_model_is_empty_config`
still asserts `_NoConfig.ConfigModel is base.EmptyConfig` (now the consolidated
class, re-exported — identity holds).

- [ ] **Step 4: Commit**

```bash
git add tether_ddns/providers/base.py tether_ddns/providers/ddns_providers/cloudflare.py tether_ddns/providers/ddns_providers/duckdns.py
git commit -m "refactor: derive provider ConfigModel from generic arg"
```

---

### Task 3: Hook adopts the mixin; hook subclasses drop ConfigModel

**Files:**
- Modify: `tether_ddns/hooks/base.py`
- Modify: `tether_ddns/hooks/registered_hooks/pushover.py`
- Modify: `tether_ddns/hooks/registered_hooks/router_firewall.py`
- Modify: `tether_ddns/hooks/registered_hooks/log_hook.py`
- Test: `test_hook_registry`, `test_pushover`, `test_router_firewall_hook`, `test_dispatch_service`, `test_scheduler`, four gates.

**Interfaces:**
- Consumes: `ConfigModelMixin`, `EmptyConfig` from `tether_ddns.plugin_config`.
- Produces: `Hook` with `ConfigModel` inherited/auto-derived; `EmptyConfig` re-exported from `tether_ddns.hooks.base`.

- [ ] **Step 1: Rewire `hooks/base.py`**

Remove the local `class EmptyConfig(BaseModel): ...`. Add near the imports:

```python
from tether_ddns.plugin_config import ConfigModelMixin, EmptyConfig as EmptyConfig
```

Change the class declaration and delete the `ConfigModel: type[BaseModel] = EmptyConfig` line:

```python
class Hook[ConfigT: BaseModel](ConfigModelMixin, ABC):  # noqa: D101
    """Base class for hook plugins."""

    key: str = ''
    display_name: str = ''
    ...
```

Keep `from pydantic import BaseModel` (still used) and `from typing import Any`.
`EmptyConfig` must stay importable as `tether_ddns.hooks.base.EmptyConfig`
(log_hook and tests import it here) — the re-export covers that.

- [ ] **Step 2: Drop `ConfigModel` from hook subclasses**

- `pushover.py`: delete `ConfigModel = PushoverConfig` from `PushoverHook`.
- `router_firewall.py`: delete `ConfigModel = RouterFirewallConfig` from `RouterFirewallHook`.
- `log_hook.py`: no `ConfigModel` line exists; leave as-is (it already relies on `Hook[EmptyConfig]`). Confirm its `EmptyConfig` import still resolves.

Leave all `Hook[XConfig]` bases and `on_*` signatures untouched.

- [ ] **Step 3: Run hook tests + gates**

Run: `pytest test/unit/test_hook_registry.py test/unit/test_pushover.py test/unit/test_router_firewall_hook.py test/unit/test_dispatch_service.py test/unit/test_scheduler.py test/test_mypy.py test/test_pyright.py test/test_ruff.py test/test_flake8.py -q`
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add tether_ddns/hooks/base.py tether_ddns/hooks/registered_hooks/pushover.py tether_ddns/hooks/registered_hooks/router_firewall.py tether_ddns/hooks/registered_hooks/log_hook.py
git commit -m "refactor: derive hook ConfigModel from generic arg"
```

---

### Task 4: README + full verification

**Files:**
- Modify: `README.md` (provider example, hook example)

**Interfaces:**
- Consumes: nothing.
- Produces: authoring docs consistent with the auto-derived `ConfigModel`.

- [ ] **Step 1: Update README examples**

In the "Add a DDNS provider" example, delete the `ConfigModel = MyConfig` line so
the class reads:

```python
@register_provider
class MyProvider(DDNSProvider[MyConfig]):
    key = 'myprovider'
    display_name = 'My Provider'

    async def update(
        self, hostname: str, record_type: str, ip: str, config: MyConfig,
    ) -> str:
        ...
```

In the "Add a hook" example, delete the `ConfigModel = MyHookConfig` line:

```python
@register_hook
class MyHook(Hook[MyHookConfig]):
    key = 'myhook'
    display_name = 'My Hook'

    async def on_ip_changed(
            self, event: IpChangedEvent, config: MyHookConfig) -> None:
        ...
```

Add one sentence after each example noting the config type is taken from the
`Base[...]` generic argument (no separate `ConfigModel` needed).

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: config type is derived from the generic argument"
```

- [ ] **Step 3: Full backend verification**

Run: `pytest -q`
Expected: full suite passes, coverage >= 90%.

- [ ] **Step 4: Confirm no stray `ConfigModel =` remain in plugins**

Run: `grep -rn "ConfigModel = " tether_ddns`
Expected: no matches (the mixin default is `ConfigModel: type[BaseModel] = EmptyConfig`, an annotated assignment, not a bare `ConfigModel = ` in a plugin).

- [ ] **Step 5: Frontend + e2e (unchanged code, sanity only)**

Run: `cd frontend && npm test && npm run test:e2e`
Expected: vitest and Playwright green (this change is backend-only; run confirms nothing regressed in the served app).

- [ ] **Step 6: Confirm clean tree**

Run: `cd .. && git status --short`
Expected: clean (built static assets are gitignored).
