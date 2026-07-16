# Generic `Hook` & `DDNSProvider` Config — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `DDNSProvider` and `Hook` generic over their config model type so handlers receive a typed `config`, removing every `assert isinstance(config, X)`.

**Architecture:** PEP 695 native generics (`class Hook[ConfigT: BaseModel]`). The type parameter carries the concrete config type into `update()` / `on_*()` / `handle()` signatures. `ConfigModel` (schema + `model_validate`) is unchanged. Registries and callers are unparameterized (implicit `Any` arg) and need no edits.

**Tech Stack:** Python 3.12+, Pydantic v2, pytest, mypy, pyright, ruff, flake8.

## Global Constraints

- Target Python `>=3.12`; every module keeps `from __future__ import annotations`.
- Use PEP 695 native generics (`class Foo[ConfigT: BaseModel]`), not `typing.Generic`/`TypeVar`.
- The two type-parameter-defining base classes (`DDNSProvider`, `Hook`) MUST carry a short `# noqa: D101` on the `class ...[ConfigT: BaseModel](...)` line: pinned flake8-docstrings (pydocstyle 6.3.0) false-positives D101 on PEP 695 generic classes despite their docstrings. Specialized subclasses do NOT need it.
- The same pydocstyle quirk hits PEP 695 generic **functions** with D103. Because the class-registry entries now reference a generic type, the registry decorators are made generic (`def register_provider[C: DDNSProvider[Any]](cls: type[C]) -> type[C]:  # noqa: D103`) and need a short `# noqa: D103`.
- Keep noqa comments short (bare `# noqa: D101` / `# noqa: D103`, no long trailing prose) so lines stay within `max-line-length = 99`.
- Because the base classes become generic and pyright runs `reportMissingTypeArgument` in strict mode, every bare use of the base in a type expression needs an explicit argument. The registries become `dict[str, type[DDNSProvider[Any]]]` / `dict[str, type[Hook[Any]]]` (add `from typing import Any`), and the `register_*` decorators are generic over `[C: <Base>[Any]]` to preserve the decorated class's concrete type. Do NOT use blanket `# type: ignore` (pyright's `reportUnnecessaryTypeIgnoreComment` is an error).
- Remove all `assert isinstance(config, X)` guards from provider/hook handlers.
- Do NOT change `ConfigModel` class attributes, registries, callers, or event-routing logic.
- Handlers that ignore config are typed to their concrete config type (`EmptyConfig`), not `BaseModel`.
- Lint/type conventions: single quotes, pep257 docstrings, existing import order.

---

### Task 1: Verify PEP 695 tooling support

**Files:**
- Create (temporary): `/tmp/pep695_probe.py`

**Interfaces:**
- Consumes: nothing.
- Produces: confidence that native generics pass all four checkers before broad edits.

- [ ] **Step 1: Write a probe module**

```python
# /tmp/pep695_probe.py
"""PEP 695 syntax probe."""
from __future__ import annotations

from pydantic import BaseModel


class Cfg(BaseModel):
    """Probe config."""


class Base[ConfigT: BaseModel]:
    """Probe base."""

    async def run(self, config: ConfigT) -> None:
        """Probe method."""


class Impl(Base[Cfg]):
    """Probe impl."""

    async def run(self, config: Cfg) -> None:
        """Probe method."""
```

- [ ] **Step 2: Run all four checkers against the probe**

Run:
```bash
mypy /tmp/pep695_probe.py && \
pyright /tmp/pep695_probe.py && \
ruff check /tmp/pep695_probe.py && \
flake8 --select= --extend-ignore=D /tmp/pep695_probe.py
```
Expected: no syntax errors from any tool (type/lint warnings unrelated to `[ConfigT: BaseModel]` are fine). If any tool rejects the generic *syntax*, STOP and switch the whole plan to classic `Generic[ConfigT]` + module-level `TypeVar`.

- [ ] **Step 3: Clean up**

```bash
rm /tmp/pep695_probe.py
```

No commit (temporary probe).

---

### Task 2: Make `DDNSProvider` generic

**Files:**
- Modify: `tether_ddns/providers/base.py`
- Test: existing `test/unit/test_provider_registry.py`, `test/test_mypy.py`, `test/test_pyright.py`

**Interfaces:**
- Consumes: `BaseModel`, `EmptyConfig`.
- Produces: `class DDNSProvider[ConfigT: BaseModel]` with `async def update(self, hostname: str, record_type: str, ip: str, config: ConfigT) -> str`.

- [ ] **Step 1: Edit the class declaration and `update` signature**

In `tether_ddns/providers/base.py`, change:

```python
class DDNSProvider(ABC):
    """Base class for DDNS provider plugins."""

    key: str = ''
    display_name: str = ''
    ConfigModel: type[BaseModel] = EmptyConfig

    @classmethod
    def config_schema(cls) -> dict[str, object]:
        """Return the JSON schema for this provider's configuration."""
        return cls.ConfigModel.model_json_schema()

    @abstractmethod
    async def update(
        self, hostname: str, record_type: str, ip: str, config: BaseModel,
    ) -> str:
        """Update the DNS record and return the assigned IP; raise on failure."""
        raise NotImplementedError
```

to:

```python
class DDNSProvider[ConfigT: BaseModel](ABC):  # noqa: D101 - pydocstyle misses PEP 695 class docstrings
    """Base class for DDNS provider plugins."""

    key: str = ''
    display_name: str = ''
    ConfigModel: type[BaseModel] = EmptyConfig

    @classmethod
    def config_schema(cls) -> dict[str, object]:
        """Return the JSON schema for this provider's configuration."""
        return cls.ConfigModel.model_json_schema()

    @abstractmethod
    async def update(
        self, hostname: str, record_type: str, ip: str, config: ConfigT,
    ) -> str:
        """Update the DNS record and return the assigned IP; raise on failure."""
        raise NotImplementedError
```

Leave `PROVIDER_REGISTRY: dict[str, type['DDNSProvider']]` and `register_provider` unchanged (unparameterized `type['DDNSProvider']` resolves the arg to `Any`).

- [ ] **Step 2: Run type checkers and registry tests**

Run: `pytest test/test_mypy.py test/test_pyright.py test/unit/test_provider_registry.py -q`
Expected: PASS (providers subclasses still typed `config: BaseModel` remain compatible with the specialized base until Task 4; if a checker flags the not-yet-updated subclasses, that is expected and fixed in Task 4 — but confirm base.py itself has no error).

- [ ] **Step 3: Commit**

```bash
git add tether_ddns/providers/base.py
git commit -m "refactor: make DDNSProvider generic over ConfigT"
```

---

### Task 3: Make `Hook` generic

**Files:**
- Modify: `tether_ddns/hooks/base.py`
- Test: `test/test_mypy.py`, `test/test_pyright.py`, `test/unit/test_hook_registry.py`

**Interfaces:**
- Consumes: `BaseModel`, `HookEventBase`, event models, `EVENT_SPECS`.
- Produces: `class Hook[ConfigT: BaseModel]` whose `on_ip_changed`, `on_reachability_changed`, `on_domain_update_pending`, `on_domain_update_success`, `on_domain_update_error`, and `handle` all take `config: ConfigT`.

- [ ] **Step 1: Edit the class declaration**

In `tether_ddns/hooks/base.py`, change `class Hook(ABC):` to:

```python
class Hook[ConfigT: BaseModel](ABC):  # noqa: D101
```

Also add `from typing import Any`, change the registry to
`HOOK_REGISTRY: dict[str, type['Hook[Any]']] = {}`, and make the decorator
generic to preserve the concrete class type (mirroring `register_provider` from
Task 2):

```python
def register_hook[C: Hook[Any]](cls: type[C]) -> type[C]:  # noqa: D103
    """Register a hook class in the global registry."""
    HOOK_REGISTRY[cls.key] = cls
    return cls
```

- [ ] **Step 2: Retype every handler's `config` param**

Replace `config: BaseModel` with `config: ConfigT` in all five `on_*` handlers and in `handle`:

```python
    async def on_ip_changed(
            self, event: IpChangedEvent, config: ConfigT) -> None:
        """Handle an IP change. Override to react; default is a no-op."""

    async def on_reachability_changed(
            self, event: ReachabilityChangedEvent, config: ConfigT) -> None:
        """Handle a reachability change. Override to react; default no-op."""

    async def on_domain_update_pending(
            self, event: DomainUpdatePendingEvent,
            config: ConfigT) -> None:
        """Handle a domain becoming stale. Override to react; default no-op."""

    async def on_domain_update_success(
            self, event: DomainUpdateSuccessEvent,
            config: ConfigT) -> None:
        """Handle a successful domain update. Default no-op."""

    async def on_domain_update_error(
            self, event: DomainUpdateErrorEvent,
            config: ConfigT) -> None:
        """Handle a failed domain update. Default no-op."""
```

And in `handle`:

```python
    async def handle(
            self, event_key: str, event: HookEventBase,
            config: ConfigT) -> None:
        """Route an event to the matching on_* handler."""
        await getattr(self, EVENT_SPECS[event_key].method)(event, config)
```

Leave `supported_events` and `EVENT_SPECS` unchanged.

- [ ] **Step 3: Run type checkers and registry tests**

Run: `pytest test/test_mypy.py test/test_pyright.py test/unit/test_hook_registry.py -q`
Expected: base.py itself clean; not-yet-updated hook subclasses may report signature mismatches — fixed in Task 5.

- [ ] **Step 4: Commit**

```bash
git add tether_ddns/hooks/base.py
git commit -m "refactor: make Hook generic over ConfigT"
```

---

### Task 4: Specialize provider subclasses

**Files:**
- Modify: `tether_ddns/providers/ddns_providers/cloudflare.py`
- Modify: `tether_ddns/providers/ddns_providers/duckdns.py`
- Test: `test/unit/test_cloudflare.py`, `test/unit/test_duckdns.py`, type checkers.

**Interfaces:**
- Consumes: `DDNSProvider[ConfigT]` from Task 2.
- Produces: `CloudflareProvider(DDNSProvider[CloudflareConfig])`, `DuckDNSProvider(DDNSProvider[DuckDNSConfig])` with `update(..., config: <Concrete>)` and no isinstance assert.

- [ ] **Step 1: Update Cloudflare**

In `tether_ddns/providers/ddns_providers/cloudflare.py`, change:

```python
@register_provider
class CloudflareProvider(DDNSProvider):
```
to:
```python
@register_provider
class CloudflareProvider(DDNSProvider[CloudflareConfig]):
```

And change the `update` signature + remove the assert:

```python
    async def update(
        self, hostname: str, record_type: str, ip: str, config: CloudflareConfig,
    ) -> str:
        """Resolve the zone and record for hostname and update it to ip."""
        headers = {
            'Authorization': f'Bearer {config.api_token.get_secret_value()}',
```
(the line `assert isinstance(config, CloudflareConfig)` is deleted).

If `BaseModel` is now unused in the file, remove it from `from pydantic import BaseModel, SecretStr` (keep `SecretStr`). Verify with grep before removing.

- [ ] **Step 2: Update DuckDNS**

In `tether_ddns/providers/ddns_providers/duckdns.py`, change:

```python
@register_provider
class DuckDNSProvider(DDNSProvider[DuckDNSConfig]):
    """Updates DuckDNS records via its HTTP API."""

    key = 'duckdns'
    display_name = 'DuckDNS'
    ConfigModel = DuckDNSConfig

    async def update(
        self, hostname: str, record_type: str, ip: str, config: DuckDNSConfig,
    ) -> str:
        """Update the DuckDNS record for the given hostname."""
        url = 'https://www.duckdns.org/update'
```
(delete `assert isinstance(config, DuckDNSConfig)`). Remove now-unused `BaseModel` from the pydantic import (keep `SecretStr`) — `from pydantic import SecretStr`.

- [ ] **Step 3: Run provider tests + checkers**

Run: `pytest test/unit/test_cloudflare.py test/unit/test_duckdns.py test/test_mypy.py test/test_pyright.py test/test_ruff.py test/test_flake8.py -q`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add tether_ddns/providers/ddns_providers/cloudflare.py tether_ddns/providers/ddns_providers/duckdns.py
git commit -m "refactor: specialize provider subclasses on config type"
```

---

### Task 5: Specialize hook subclasses

**Files:**
- Modify: `tether_ddns/hooks/registered_hooks/pushover.py`
- Modify: `tether_ddns/hooks/registered_hooks/router_firewall.py`
- Modify: `tether_ddns/hooks/registered_hooks/log_hook.py`
- Test: `test/unit/test_pushover.py`, `test/unit/test_router_firewall_hook.py`, type checkers.

**Interfaces:**
- Consumes: `Hook[ConfigT]` from Task 3.
- Produces: `PushoverHook(Hook[PushoverConfig])`, `RouterFirewallHook(Hook[RouterFirewallConfig])`, `LogHook(Hook[EmptyConfig])` with concrete-typed handlers and no isinstance asserts.

- [ ] **Step 1: Update Pushover**

In `tether_ddns/hooks/registered_hooks/pushover.py`, change `class PushoverHook(Hook):` to `class PushoverHook(Hook[PushoverConfig]):`. In each of the four handlers (`on_domain_update_success`, `on_domain_update_pending`, `on_domain_update_error`, `on_reachability_changed`), change the param to `config: PushoverConfig` and delete the `assert isinstance(config, PushoverConfig)` line. Example:

```python
    async def on_domain_update_success(
            self, event: DomainUpdateSuccessEvent,
            config: PushoverConfig) -> None:
        """Send a success notification."""
        await self._send(
            config, event.hostname,
            f'Updated {event.hostname} {event.record_type} -> {event.ip}', 0)
```

`_send` already takes `config: PushoverConfig` — unchanged. Remove now-unused `BaseModel` from `from pydantic import BaseModel, SecretStr` → `from pydantic import SecretStr`.

- [ ] **Step 2: Update RouterFirewall**

In `tether_ddns/hooks/registered_hooks/router_firewall.py`, change `class RouterFirewallHook(Hook):` to `class RouterFirewallHook(Hook[RouterFirewallConfig]):`. Change `on_ip_changed` param to `config: RouterFirewallConfig` and delete `assert isinstance(config, RouterFirewallConfig)`:

```python
    async def on_ip_changed(
            self, event: IpChangedEvent,
            config: RouterFirewallConfig) -> None:
        """Update the configured firewall rule to the new public IP."""
        ip = event.new_ip
        if event.family != config.ip_version:
            return
```

Check whether `BaseModel` is still referenced elsewhere in the file (the `RouterFirewallConfig` model definition uses it). Keep the import if still used; only remove if grep shows no remaining use.

- [ ] **Step 3: Update LogHook**

In `tether_ddns/hooks/registered_hooks/log_hook.py`, change `class LogHook(Hook):` to `class LogHook(Hook[EmptyConfig]):`. Change every handler's `config: BaseModel` to `config: EmptyConfig`. Update imports: add `EmptyConfig` to the `tether_ddns.hooks.base` import block and remove the now-unused `from pydantic import BaseModel`:

```python
from tether_ddns.hooks.base import (
    DomainUpdateErrorEvent,
    DomainUpdatePendingEvent,
    DomainUpdateSuccessEvent,
    EmptyConfig,
    Hook,
    IpChangedEvent,
    ReachabilityChangedEvent,
    register_hook,
)
```

- [ ] **Step 4: Run hook tests + checkers**

Run: `pytest test/unit/test_pushover.py test/unit/test_router_firewall_hook.py test/unit/test_dispatch_service.py test/test_mypy.py test/test_pyright.py test/test_ruff.py test/test_flake8.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tether_ddns/hooks/registered_hooks/pushover.py tether_ddns/hooks/registered_hooks/router_firewall.py tether_ddns/hooks/registered_hooks/log_hook.py
git commit -m "refactor: specialize hook subclasses on config type"
```

---

### Task 6: Update test spy hooks & direct base-class usages in tests

**Files:**
- Modify: `test/unit/test_scheduler.py`
- Modify: `test/unit/test_hook_registry.py` (5 inline `base.Hook` subclasses)
- Modify: `test/unit/test_provider_registry.py` (2 inline `base.DDNSProvider` subclasses)
- Modify: `test/unit/test_router_firewall_hook.py` (`_cfg()` return type)
- Test: those files, type checkers.

**Interfaces:**
- Consumes: `Hook[ConfigT]`, `EmptyConfig` from `tether_ddns.hooks.base`.
- Produces: 8 spy subclasses declared `Hook[EmptyConfig]` with handler params typed `config: EmptyConfig`.

- [ ] **Step 1: Retype the spy hooks**

In `test/unit/test_scheduler.py`, for each spy class (`_SpyHook`, `_SpyRun`, `_SpyNoIp`, `_SpyUnsup`, `_SpyErr`, `_SpyOk`, `_SpyPend`, `_SpyNoIp` at L740), change `class _Spy…(Hook):` to `class _Spy…(Hook[EmptyConfig]):` and change each overridden handler's `config: BaseModel` param to `config: EmptyConfig`. Ensure `EmptyConfig` is imported from `tether_ddns.hooks.base` in each test that references it (add to the local import line alongside `Hook`, `register_hook`). Leave `# pyright: ignore[reportUnusedClass]` comments intact.

- [ ] **Step 2: Run scheduler tests + checkers**

Run: `pytest test/unit/test_scheduler.py test/test_mypy.py test/test_pyright.py test/test_ruff.py test/test_flake8.py -q`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add test/unit/test_scheduler.py
git commit -m "test: specialize spy hooks on EmptyConfig"
```

---

### Task 7: Update README plugin examples

**Files:**
- Modify: `README.md` (provider example ~L145-167, hook example ~L172-197)

**Interfaces:**
- Consumes: nothing.
- Produces: authoring docs that match the new generic API.

- [ ] **Step 1: Update the provider example**

Replace the provider snippet so it uses the generic base and drops the assert:

```python
from pydantic import BaseModel, SecretStr
from tether_ddns.errors import TetherError
from tether_ddns.providers.base import DDNSProvider, register_provider


class MyConfig(BaseModel):
    token: SecretStr


@register_provider
class MyProvider(DDNSProvider[MyConfig]):
    key = 'myprovider'
    display_name = 'My Provider'
    ConfigModel = MyConfig

    async def update(
        self, hostname: str, record_type: str, ip: str, config: MyConfig,
    ) -> str:
        # ...perform the update...
        if not success:
            raise TetherError('Update failed: provider returned error')
        return ip
```

- [ ] **Step 2: Update the hook example**

Replace the hook snippet so it specializes the base and types handlers to the concrete config:

```python
from tether_ddns.hooks.base import (
    Hook, IpChangedEvent, ReachabilityChangedEvent, register_hook)
from pydantic import BaseModel


class MyHookConfig(BaseModel):
    ...


@register_hook
class MyHook(Hook[MyHookConfig]):
    key = 'myhook'
    display_name = 'My Hook'
    ConfigModel = MyHookConfig

    # Override only the event methods you care about. The events a hook
    # supports are inferred from which on_* methods it overrides; the UI only
    # offers those, and the scheduler never dispatches an unsupported event.
    async def on_ip_changed(
            self, event: IpChangedEvent, config: MyHookConfig) -> None:
        # react to a public IP change (event.new_ip, event.family)
        ...

    async def on_reachability_changed(
            self, event: ReachabilityChangedEvent,
            config: MyHookConfig) -> None:
        # react to an online/offline transition (event.online)
        ...
```

(If the surrounding prose mentions `isinstance`, remove that guidance.)

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: update plugin examples for generic config"
```

---

### Task 8: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Run the complete test suite**

Run: `pytest -q`
Expected: all pass, including `test/test_mypy.py`, `test/test_pyright.py`, `test/test_ruff.py`, `test/test_flake8.py`.

- [ ] **Step 2: Confirm no stray isinstance asserts remain**

Run: `grep -rn "isinstance(config" tether_ddns test`
Expected: no matches.

- [ ] **Step 3: Final commit if anything outstanding**

```bash
git status
```
Expected: clean tree (all changes already committed).
