# Domain & Hook Form Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Validate domain/hook plugin config at save time with pydantic and show each 422 error on the form field it concerns.

**Architecture:** Route handlers call `cls.ConfigModel.model_validate()` on the merged config and re-raise failures as FastAPI 422s with `loc: ['body', 'provider_config' | 'config', <field>]`. One exception handler rewrites "missing"/"min length 1" messages to `Required`. The frontend keys errors by dotted path, splits them per form section, and decorates inputs the same way `ProjectModal` already does.

**Tech Stack:** Python 3.12, FastAPI 0.139, pydantic 2.13; React 19 + Vite, Vitest 4, Playwright 1.61.

**Spec:** `docs/superpowers/specs/2026-09-26-form-validation-design.md`

## Global Constraints

- Python gates (all must pass over BOTH `tether_ddns/` and `test/`): `pytest test/test_flake8.py test/test_ruff.py test/test_mypy.py test/test_pyright.py`, then `pytest test/ --cov=tether_ddns --cov-fail-under=90`.
- flake8: single quotes, max line 99, pep257 docstrings on EVERY function including test functions (one line, ends with a period), import-order groups — each third-party package is its own group separated by a blank line (`pydantic` and `pydantic_core` need a blank line between them; verified I201).
- pyright strict. Never add a blanket `# type: ignore`. Pass `str` values into `HttpUrl`/`IPvAnyAddress` fields via `Model.model_validate({...})` or a `**dict[str, Any]`, not as typed keyword args.
- Activate the venv first: `source .venv/bin/activate`.
- Frontend gates: `cd frontend && npm test` (oxlint + vitest + coverage) AND `npx tsc --noEmit -p tsconfig.app.json` (vitest does NOT type-check).
- Error message for missing/empty required values is exactly `Required`.
- Invalid-control CSS class is exactly `field-invalid`; error help text uses `field-help hb-error`.
- Required marker: `<span className="req" aria-hidden="true">*</span>`, colour `var(--text-3)` (not the blue accent, not red).
- Persist the merged raw config dict — never `ConfigModel.model_dump()` (it writes `'**********'` for secrets).
- Toggle toast copy: `{hostname}: fix its provider config first`.
- Never render an empty `.field-help` div: `.field` is a flex column with `gap: 7px`, so an empty child adds 7px.
- Global CSS utility classes can collide with component class names (`.empty` has 120px padding). Use only the class names given here.

## File Structure

| File | Responsibility |
|---|---|
| `tether_ddns/schema_fields.py` | + `RequiredStr`, `RequiredSecret` shared annotated types |
| `tether_ddns/providers/ddns_providers/duckdns.py`, `cloudflare.py` | tightened provider config models |
| `tether_ddns/hooks/registered_hooks/pushover.py`, `router_firewall.py` | tightened hook config models; router hook adapts to `HttpUrl`/`IPvAnyAddress` |
| `tether_ddns/api.py` | request-model validators, `_validate_plugin_config`, loc prefixing, `Required` exception handler |
| `test/unit/test_config_constraints.py` (new) | DuckDNS / Cloudflare / Pushover model constraints |
| `test/unit/test_router_firewall_hook.py` | router model constraints + typed-field hook behaviour |
| `test/unit/test_api_validation.py` (new) | end-to-end 422 shapes from the API |
| `frontend/src/api.ts` | dotted-path `fieldErrors` |
| `frontend/src/formErrors.ts` (new) | `useFormErrors()` hook + `invalidProps()` helper + `subErrors()` shared by both modals |
| `frontend/src/components/FieldHelp.tsx` (new) | help/error line that renders nothing when empty |
| `frontend/src/components/Select.tsx` | `invalid` / `describedBy` props |
| `frontend/src/components/SchemaForm.tsx` | `errors` prop, required markers |
| `frontend/src/components/DomainModal.tsx`, `HookModal.tsx` | inline errors, saving state, reconnect-reset fix |
| `frontend/src/App.tsx` | save handlers rethrow; toggle toast |
| `frontend/src/styles.css` | `.field-invalid`, `.req` |
| `frontend/e2e/validation.spec.ts` (new) | real-browser proof of the invalid styling |

---

### Task 1: Shared required types and tightened DuckDNS / Cloudflare / Pushover models

**Files:**
- Modify: `tether_ddns/schema_fields.py`
- Modify: `tether_ddns/providers/ddns_providers/duckdns.py:6,15-18`
- Modify: `tether_ddns/providers/ddns_providers/cloudflare.py:4-25`
- Modify: `tether_ddns/hooks/registered_hooks/pushover.py:8,23-27`
- Create: `test/unit/test_config_constraints.py`

**Interfaces:**
- Produces: `tether_ddns.schema_fields.RequiredStr` = `Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]`; `tether_ddns.schema_fields.RequiredSecret` = `Annotated[SecretStr, Field(min_length=1)]`. Error types they raise: `string_too_short` / `too_short` with `ctx['min_length'] == 1`; `missing` when absent.
- Produces: Cloudflare TTL error type `ttl_range`, message `Must be 1 (auto) or between 60 and 86400`.

- [ ] **Step 1: Write the failing tests**

Create `test/unit/test_config_constraints.py`:

```python
"""Save-time constraints on provider and hook config models."""
from typing import Any

from pydantic import BaseModel, ValidationError

import pytest

from tether_ddns.hooks.registered_hooks.pushover import PushoverConfig
from tether_ddns.providers.ddns_providers.cloudflare import CloudflareConfig
from tether_ddns.providers.ddns_providers.duckdns import DuckDNSConfig


def _error_types(model: type[BaseModel], data: dict[str, Any]) -> dict[str, str]:
    """Validate data and return {first loc part: error type} for every failure."""
    with pytest.raises(ValidationError) as info:
        model.model_validate(data)
    return {str(e['loc'][0]): e['type'] for e in info.value.errors()}


SECRETS: list[tuple[type[BaseModel], str, dict[str, str]]] = [
    (DuckDNSConfig, 'token', {}),
    (CloudflareConfig, 'api_token', {}),
    (PushoverConfig, 'token', {'user': 'u'}),
    (PushoverConfig, 'user', {'token': 't'}),
]


@pytest.mark.parametrize(('model', 'field', 'others'), SECRETS)
def test_empty_secret_is_rejected(
    model: type[BaseModel], field: str, others: dict[str, str],
) -> None:
    """An empty secret fails with a min-length error on that field only."""
    assert _error_types(model, {**others, field: ''}) == {field: 'too_short'}


@pytest.mark.parametrize(('model', 'field', 'others'), SECRETS)
def test_missing_secret_is_rejected(
    model: type[BaseModel], field: str, others: dict[str, str],
) -> None:
    """A missing secret fails as 'missing' on that field only."""
    assert _error_types(model, others) == {field: 'missing'}


def test_required_secret_keeps_password_format_and_title() -> None:
    """The schema still marks the secret as a titled, required password field."""
    schema = CloudflareConfig.model_json_schema()
    token = schema['properties']['api_token']
    assert token['format'] == 'password'
    assert token['minLength'] == 1
    assert token['title'] == 'API Token'
    assert schema['required'] == ['api_token']


@pytest.mark.parametrize('ttl', [1, 60, 300, 86400])
def test_cloudflare_accepts_auto_and_explicit_ttl(ttl: int) -> None:
    """TTL 1 (automatic) and 60..86400 seconds are accepted."""
    assert CloudflareConfig.model_validate({'api_token': 't', 'ttl': ttl}).ttl == ttl


@pytest.mark.parametrize('ttl', [0, 2, 59, 86401])
def test_cloudflare_rejects_out_of_range_ttl(ttl: int) -> None:
    """Any other TTL fails with the ttl_range error."""
    assert _error_types(CloudflareConfig, {'api_token': 't', 'ttl': ttl}) == {
        'ttl': 'ttl_range'}


def test_cloudflare_ttl_message_names_the_valid_range() -> None:
    """The TTL error reads as a sentence an operator can act on."""
    with pytest.raises(ValidationError) as info:
        CloudflareConfig.model_validate({'api_token': 't', 'ttl': 30})
    assert info.value.errors()[0]['msg'] == 'Must be 1 (auto) or between 60 and 86400'
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pytest test/unit/test_config_constraints.py -v`
Expected: `test_empty_secret_is_rejected[*]` and all `ttl` rejection tests FAIL (no error raised); `test_missing_secret_is_rejected` PASSES already.

- [ ] **Step 3: Add the shared types**

In `tether_ddns/schema_fields.py` change the imports and add the aliases below them:

```python
from typing import Annotated, Any, cast

from pydantic import Field, SecretStr, StringConstraints

RequiredStr = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]
RequiredSecret = Annotated[SecretStr, Field(min_length=1)]
```

- [ ] **Step 4: Tighten the three models**

`tether_ddns/providers/ddns_providers/duckdns.py` — import and model:

```python
from pydantic import BaseModel

from tether_ddns.errors import TetherError
from tether_ddns.providers.base import (
    DDNSProvider,
    register_provider,
)
from tether_ddns.schema_fields import RequiredSecret


class DuckDNSConfig(BaseModel):
    """Configuration for the DuckDNS provider."""

    token: RequiredSecret
```

(Keep `SecretStr` in the import only if flake8 reports it is still used.)

`tether_ddns/providers/ddns_providers/cloudflare.py` — imports and model:

```python
from typing import Annotated, Any, cast

import aiohttp

from pydantic import AfterValidator, BaseModel

from pydantic_core import PydanticCustomError

from tether_ddns.errors import TetherError
from tether_ddns.providers.base import (
    DDNSProvider,
    register_provider,
)
from tether_ddns.schema_fields import RequiredSecret, labeled_field

_API = 'https://api.cloudflare.com/client/v4'


def _check_ttl(ttl: int) -> int:
    """Accept Cloudflare's automatic TTL (1) or an explicit 60..86400 seconds."""
    if ttl != 1 and not 60 <= ttl <= 86400:
        raise PydanticCustomError('ttl_range', 'Must be 1 (auto) or between 60 and 86400')
    return ttl


class CloudflareConfig(BaseModel):
    """Configuration for the Cloudflare provider."""

    api_token: Annotated[RequiredSecret, labeled_field(title='API Token')]
    proxied: bool = False
    ttl: Annotated[int, AfterValidator(_check_ttl), labeled_field(title='TTL')] = 1
```

`tether_ddns/hooks/registered_hooks/pushover.py` — import `RequiredSecret` alongside `labeled_field`, drop `SecretStr` from the pydantic import if unused, and:

```python
class PushoverConfig(BaseModel):
    """Configuration for the Pushover hook."""

    token: Annotated[RequiredSecret, labeled_field(title='API Token')]
    user: Annotated[RequiredSecret, labeled_field(title='User Key')]
```

- [ ] **Step 5: Run the new and existing plugin tests**

Run: `pytest test/unit/test_config_constraints.py test/unit/test_duckdns.py test/unit/test_cloudflare.py test/unit/test_pushover.py test/unit/test_schema_fields.py -v`
Expected: all PASS.

- [ ] **Step 6: Run the lint/type gates**

Run: `pytest test/test_flake8.py test/test_ruff.py test/test_mypy.py test/test_pyright.py`
Expected: PASS. Fix any import-group or unused-import findings.

- [ ] **Step 7: Commit**

```bash
git add tether_ddns/schema_fields.py tether_ddns/providers/ddns_providers/duckdns.py tether_ddns/providers/ddns_providers/cloudflare.py tether_ddns/hooks/registered_hooks/pushover.py test/unit/test_config_constraints.py
git commit -m "feat(plugins): require non-empty secrets and a valid Cloudflare TTL"
```

---

### Task 2: Router firewall config uses `HttpUrl` / `IPvAnyAddress`, hook adapts

**Files:**
- Modify: `tether_ddns/hooks/registered_hooks/router_firewall.py:9-26,57-71,213-215,263`
- Test: `test/unit/test_router_firewall_hook.py`

**Interfaces:**
- Consumes: `RequiredStr`, `RequiredSecret` from Task 1.
- Produces: `RouterFirewallConfig.router_url: HttpUrl`, `.source_ip: IPv4Address | IPv6Address`, `.username`/`.rule_name: RequiredStr`, `.password: RequiredSecret`. `build_apply_payload` still returns `dict[str, str]`.

- [ ] **Step 1: Write the failing tests**

Update the imports at the top of `test/unit/test_router_firewall_hook.py`. This repo's import-order style puts plain `import x` lines before `from x import` lines within a group, so it becomes:

```python
import hashlib
import urllib.parse
from base64 import b64decode
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

from pydantic import SecretStr, ValidationError
```

Then append:

```python
def test_config_rejects_bad_router_url_and_source_ip() -> None:
    """router_url must be an http(s) URL and source_ip a real address."""
    with pytest.raises(ValidationError) as info:
        RouterFirewallConfig.model_validate({
            'username': 'u', 'password': 'p',
            'router_url': 'ftp://router', 'source_ip': '999.1.1.1'})
    assert {e['loc'][0] for e in info.value.errors()} == {'router_url', 'source_ip'}


def test_config_requires_username_password_and_rule_name() -> None:
    """Blank credentials and rule name are rejected."""
    with pytest.raises(ValidationError) as info:
        RouterFirewallConfig.model_validate(
            {'username': '  ', 'password': '', 'rule_name': ''})
    assert {e['loc'][0] for e in info.value.errors()} == {
        'username', 'password', 'rule_name'}


def test_build_apply_payload_stringifies_source_ip() -> None:
    """The typed source address reaches the payload as a plain string."""
    payload = build_apply_payload(_cfg(), '1', '2001:db8::9')
    assert payload['SourceIP'] == '::'
    assert payload['SourceIPMask'] == '::/0'
    assert all(isinstance(v, str) for v in payload.values())


@pytest.mark.parametrize('source_ip', ['192.0.2.7', '2001:db8::7'])
def test_encode_apply_body_encodes_either_family(source_ip: str) -> None:
    """An IPv4 or IPv6 source address survives URL encoding."""
    cfg = RouterFirewallConfig.model_validate(
        {'username': 'u', 'password': 'p', 'source_ip': source_ip})
    body = encode_apply_body(build_apply_payload(cfg, '1', '2001:db8::9'), 'T')
    assert f'SourceIP={urllib.parse.quote(source_ip, safe="")}&' in body


@pytest.mark.asyncio
@pytest.mark.parametrize('url', ['https://192.168.0.1', 'https://192.168.0.1/'])
async def test_on_ip_changed_base_url_has_no_double_slash(url: str) -> None:
    """The typed router URL yields one trailing slash with or without input slash."""
    session = _flow_session()
    cs = _patch_session(session)
    try:
        await RouterFirewallHook().on_ip_changed(
            IpChangedEvent(old_ip='2001:db8::1', new_ip='2001:db8::9', family='ipv6'),
            _cfg(router_url=url))
    finally:
        cs.stop()
    assert session.get.call_args_list[0].args[0] == 'https://192.168.0.1/'
```

- [ ] **Step 2: Run the tests to verify the model tests fail**

Run: `pytest test/unit/test_router_firewall_hook.py -v`
Expected: `test_config_rejects_bad_router_url_and_source_ip` and `test_config_requires_username_password_and_rule_name` FAIL (no error raised). The payload/URL tests PASS for now (fields are still `str`).

- [ ] **Step 3: Switch the model to real types**

In `router_firewall.py` add `from ipaddress import IPv6Address` to the stdlib `from` imports (between `from base64 ...` and `from typing ...`), change the pydantic import to `from pydantic import BaseModel, HttpUrl, IPvAnyAddress` (drop `SecretStr` if flake8 reports it unused), import `RequiredSecret, RequiredStr, labeled_field` from `tether_ddns.schema_fields`, and change these fields (leave every other field untouched):

```python
    router_url: Annotated[HttpUrl, labeled_field(title='Router URL')] = HttpUrl(
        'https://192.168.0.1')
    username: RequiredStr
    password: RequiredSecret
    rule_name: Annotated[RequiredStr, labeled_field(title='Rule Name')] = 'Wireguard'
```

```python
    source_ip: Annotated[IPvAnyAddress, labeled_field(title='Source IP')] = IPv6Address('::')
```

- [ ] **Step 4: Run the tests to see the hook break**

Run: `pytest test/unit/test_router_firewall_hook.py -v`
Expected: the model tests now PASS; `test_on_ip_changed_*` FAIL with `AttributeError: 'HttpUrl' object has no attribute 'rstrip'` and `test_build_apply_payload_stringifies_source_ip` / `test_encode_apply_body_encodes_either_family` FAIL (`IPv6Address` in payload / `TypeError` from `quote`).

- [ ] **Step 5: Adapt the hook**

In `build_apply_payload`:

```python
        'SourceIP': str(config.source_ip),
```

In `on_ip_changed`:

```python
        base = str(config.router_url).rstrip('/')
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pytest test/unit/test_router_firewall_hook.py test/unit/test_dispatch_service.py -v`
Expected: all PASS.

- [ ] **Step 7: Run the lint/type gates**

Run: `pytest test/test_flake8.py test/test_ruff.py test/test_mypy.py test/test_pyright.py`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add tether_ddns/hooks/registered_hooks/router_firewall.py test/unit/test_router_firewall_hook.py
git commit -m "feat(router-firewall): validate router URL and source IP with pydantic types"
```

---

### Task 3: API validates plugin config at save time and reports `Required`

**Files:**
- Modify: `tether_ddns/api.py` (imports; `DomainInput`, `HookInput`; remove `_validate_hook_events`; `_body_validation_error`; new `_friendly`, `_validate_plugin_config`; four handlers; exception handler in `register_routes`)
- Create: `test/unit/test_api_validation.py`
- Modify: `test/unit/test_api.py:133-141` (400 → 422)

**Interfaces:**
- Consumes: Task 1/2 models via `PROVIDER_REGISTRY` / `HOOK_REGISTRY`.
- Produces (HTTP contract the frontend relies on): 422 `{"detail": [{"loc": ["body", ...path], "msg": str, "type": str}, ...]}`. Paths used: `hostname`, `provider`, `record_type`, `hook`, `events`, `provider_config.<field>`, `config.<field>`. Messages: `Required`, `Unknown provider`, `Unknown hook`, `Unsupported event <key>`, others verbatim from pydantic.

- [ ] **Step 1: Write the failing API tests**

Create `test/unit/test_api_validation.py`:

```python
"""Save-time validation of domain and hook payloads."""
from collections.abc import Iterator
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient

import pytest

from tether_ddns.app import create_app
from tether_ddns.config_store import AppConfig, ConfigStore
from tether_ddns.incident_store import IncidentStore
from tether_ddns.state_store import StateStore

DUCK: dict[str, Any] = {
    'hostname': 'home.example.com', 'provider': 'duckdns',
    'provider_config': {'token': 'realsecret'},
}


@pytest.fixture
def client(tmp_path: Path) -> Iterator[Any]:
    """Yield a started app with hermetic stores and no startup check."""
    store = ConfigStore(tmp_path / 'cfg.json')
    config = AppConfig()
    config.settings.update_on_startup = False
    store.save(config)
    app = create_app(
        store, StateStore(tmp_path / 'state.json'), IncidentStore(tmp_path / 'inc.json'))
    with TestClient(app) as c:
        yield c


def _errors(resp: Any) -> dict[str, str]:
    """Map a 422 body to {dotted loc without 'body': msg}."""
    assert resp.status_code == 422, resp.text
    return {
        '.'.join(str(p) for p in e['loc'][1:]): e['msg'] for e in resp.json()['detail']}


@pytest.mark.parametrize('config', [{}, {'token': ''}])
def test_create_domain_requires_the_provider_token(
    client: Any, config: dict[str, str],
) -> None:
    """A missing or empty DuckDNS token is a Required error on that field."""
    resp = client.post('/api/domains', json={**DUCK, 'provider_config': config})
    assert _errors(resp) == {'provider_config.token': 'Required'}
    assert client.get('/api/domains').json() == []


@pytest.mark.parametrize('body', [
    {k: v for k, v in DUCK.items() if k != 'hostname'},
    {**DUCK, 'hostname': '   '},
])
def test_create_domain_requires_a_hostname(client: Any, body: dict[str, Any]) -> None:
    """A missing or blank hostname is rejected as Required before the handler runs."""
    assert _errors(client.post('/api/domains', json=body)) == {'hostname': 'Required'}


def test_create_domain_rejects_an_unknown_provider(client: Any) -> None:
    """An unregistered provider is reported on the provider field."""
    resp = client.post('/api/domains', json={**DUCK, 'provider': 'nope'})
    assert _errors(resp) == {'provider': 'Unknown provider'}


def test_create_domain_rejects_other_record_types(client: Any) -> None:
    """Only A and AAAA are accepted; pydantic's message passes through."""
    resp = client.post('/api/domains', json={**DUCK, 'record_type': 'MX'})
    assert _errors(resp) == {'record_type': "Input should be 'A' or 'AAAA'"}


def test_create_domain_reports_a_bad_cloudflare_ttl(client: Any) -> None:
    """A plugin-specific constraint lands on its provider_config field."""
    resp = client.post('/api/domains', json={
        **DUCK, 'provider': 'cloudflare',
        'provider_config': {'api_token': 't', 'ttl': 30}})
    assert _errors(resp) == {
        'provider_config.ttl': 'Must be 1 (auto) or between 60 and 86400'}


def test_created_domain_persists_the_raw_secret(client: Any) -> None:
    """The stored config keeps the real token, not a dumped SecretStr mask."""
    assert client.post('/api/domains', json=DUCK).status_code == 200
    stored = client.app.state.store.load()
    assert stored.domains[0].provider_config['token'] == 'realsecret'


@pytest.mark.parametrize('token', ['********', ''])
def test_update_domain_keeps_the_stored_secret(client: Any, token: str) -> None:
    """A masked or blank secret on edit means 'keep', so validation passes."""
    domain_id = client.post('/api/domains', json=DUCK).json()['id']
    resp = client.put(f'/api/domains/{domain_id}', json={
        **DUCK, 'hostname': 'new.example.com', 'provider_config': {'token': token}})
    assert resp.status_code == 200, resp.text
    stored = client.app.state.store.load()
    assert stored.domains[0].provider_config['token'] == 'realsecret'


def test_rejected_update_leaves_the_domain_untouched(client: Any) -> None:
    """Switching to a provider without its secret fails and changes nothing."""
    domain_id = client.post('/api/domains', json=DUCK).json()['id']
    resp = client.put(f'/api/domains/{domain_id}', json={
        **DUCK, 'hostname': 'new.example.com', 'provider': 'cloudflare',
        'provider_config': {}})
    assert _errors(resp) == {'provider_config.api_token': 'Required'}
    assert client.get('/api/domains').json()[0]['hostname'] == 'home.example.com'


def test_update_unknown_domain_is_still_404(client: Any) -> None:
    """Lookup happens before plugin validation."""
    assert client.put('/api/domains/nope', json=DUCK).status_code == 404


def test_create_hook_requires_its_config(client: Any) -> None:
    """A Pushover hook without a user key is rejected on config.user."""
    resp = client.post('/api/hooks-config', json={
        'hook': 'pushover', 'events': [], 'config': {'token': 't'}})
    assert _errors(resp) == {'config.user': 'Required'}


def test_create_hook_rejects_an_unknown_hook(client: Any) -> None:
    """An unregistered hook fails on hook only; events are not checked."""
    resp = client.post('/api/hooks-config', json={
        'hook': 'nope', 'events': ['ip_changed']})
    assert _errors(resp) == {'hook': 'Unknown hook'}


def test_create_hook_rejects_an_unsupported_event(client: Any) -> None:
    """Events the hook does not support are reported on events."""
    resp = client.post('/api/hooks-config', json={
        'hook': 'router_firewall', 'events': ['reachability_changed'],
        'config': {'username': 'u', 'password': 'p'}})
    assert _errors(resp) == {'events': 'Unsupported event reachability_changed'}


def test_create_hook_reports_typed_router_fields(client: Any) -> None:
    """Bad URL and IP values land on their config fields."""
    resp = client.post('/api/hooks-config', json={
        'hook': 'router_firewall', 'events': ['ip_changed'],
        'config': {'username': 'u', 'password': 'p',
                   'router_url': 'not a url', 'source_ip': '999.1.1.1'}})
    assert set(_errors(resp)) == {'config.router_url', 'config.source_ip'}


def test_update_hook_validates_the_merged_config(client: Any) -> None:
    """A masked password on edit is restored before validation."""
    created = client.post('/api/hooks-config', json={
        'hook': 'router_firewall', 'events': ['ip_changed'],
        'config': {'username': 'u', 'password': 'p'}}).json()
    ok = client.put(f"/api/hooks-config/{created['id']}", json={
        'hook': 'router_firewall', 'events': ['ip_changed'],
        'config': {'username': 'u', 'password': '********'}})
    assert ok.status_code == 200, ok.text
    bad = client.put(f"/api/hooks-config/{created['id']}", json={
        'hook': 'router_firewall', 'events': ['ip_changed'],
        'config': {'username': ' ', 'password': '********'}})
    assert _errors(bad) == {'config.username': 'Required'}


def test_other_endpoints_share_the_required_message(client: Any) -> None:
    """Healthchecks min-length fields also read Required."""
    resp = client.post('/api/healthchecks', json={'name': '', 'api_key': ''})
    assert _errors(resp) == {'name': 'Required', 'api_key': 'Required'}
```

The fixture and tests type the client as `Any`, matching `_client()` in `test_api.py`: a typed `TestClient` exposes `.app` as a bare `ASGIApp`, so `client.app.state` would fail pyright strict.

- [ ] **Step 2: Update the existing 400 test**

In `test/unit/test_api.py` replace `test_create_hook_rejects_unsupported_event` with:

```python
def test_create_hook_rejects_unsupported_event(tmp_path: Path) -> None:
    """Saving a hook with an unsupported event returns a 422 on events."""
    payload: dict[str, Any] = {
        'hook': 'router_firewall', 'enabled': True,
        'events': ['reachability_changed'],
        'config': {'username': 'u', 'password': 'p'},
    }
    with _client(tmp_path) as client:
        resp: Any = client.post('/api/hooks-config', json=payload)
    assert resp.status_code == 422
    assert resp.json()['detail'][0]['loc'] == ['body', 'events']
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pytest test/unit/test_api_validation.py test/unit/test_api.py -v`
Expected: most new tests FAIL (200 instead of 422, or `String should have at least 1 character` instead of `Required`).

- [ ] **Step 4: Implement the request-model validators**

In `tether_ddns/api.py` replace the stdlib, fastapi and pydantic imports with (plain `import` lines before `from` lines; each third-party package its own group):

```python
import platform
import time
from collections.abc import Mapping
from importlib import metadata
from typing import Any, Literal

from fastapi import APIRouter, FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.exception_handlers import request_validation_exception_handler
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    HttpUrl,
    ValidationError,
    ValidationInfo,
    field_validator,
)

from pydantic_core import PydanticCustomError
```

and add `from tether_ddns.plugin_config import ConfigModelMixin` and `from tether_ddns.schema_fields import RequiredStr` in the application group (alphabetical by module). Replace `DomainInput` and `HookInput`:

```python
class DomainInput(BaseModel):
    """Incoming domain payload (id assigned server-side)."""

    hostname: RequiredStr
    provider: str
    record_type: Literal['A', 'AAAA'] = 'A'
    enabled: bool = True
    update_period: int = 300
    provider_config: dict[str, object] = {}

    @field_validator('provider')
    @classmethod
    def _known_provider(cls, provider: str) -> str:
        """Reject providers that are not registered."""
        if provider not in PROVIDER_REGISTRY:
            raise PydanticCustomError('unknown_provider', 'Unknown provider')
        return provider


class HookInput(BaseModel):
    """Incoming hook payload."""

    hook: str
    enabled: bool = True
    events: list[str] = []
    config: dict[str, object] = {}

    @field_validator('hook')
    @classmethod
    def _known_hook(cls, hook: str) -> str:
        """Reject hooks that are not registered."""
        if hook not in HOOK_REGISTRY:
            raise PydanticCustomError('unknown_hook', 'Unknown hook')
        return hook

    @field_validator('events')
    @classmethod
    def _supported_events(cls, events: list[str], info: ValidationInfo) -> list[str]:
        """Reject events the (already validated) hook does not support."""
        hook = info.data.get('hook')
        if hook is None:
            return events
        supported = HOOK_REGISTRY[hook].supported_events()
        for event in events:
            if event not in supported:
                raise PydanticCustomError(
                    'unsupported_event', 'Unsupported event {event}', {'event': event})
        return events
```

Delete `_validate_hook_events` entirely.

- [ ] **Step 5: Implement loc prefixing, `_friendly` and `_validate_plugin_config`**

Replace `_body_validation_error` and add the two helpers next to it:

```python
_MIN_LENGTH_TYPES = frozenset({'too_short', 'string_too_short'})


def _friendly(error: Mapping[str, Any]) -> dict[str, Any]:
    """Collapse pydantic's 'missing' and 'at least 1' messages into 'Required'."""
    item = dict(error)
    ctx = item.get('ctx') or {}
    if item.get('type') == 'missing' or (
            item.get('type') in _MIN_LENGTH_TYPES and ctx.get('min_length') == 1):
        item['msg'] = 'Required'
    return item


def _body_validation_error(
    exc: ValidationError, prefix: tuple[str, ...] = (),
) -> RequestValidationError:
    """Re-shape a model ValidationError as FastAPI's 422 with body-prefixed locs."""
    errors: list[dict[str, object]] = []
    for error in exc.errors():
        item = dict(error)
        item['loc'] = ('body', *prefix, *error['loc'])
        errors.append(item)
    return RequestValidationError(errors)


def _validate_plugin_config(
    cls: type[ConfigModelMixin], config: dict[str, object], field: str,
) -> None:
    """Validate a plugin config against its model, as a 422 under ``field``."""
    try:
        cls.ConfigModel.model_validate(config)
    except ValidationError as exc:
        raise _body_validation_error(exc, (field,)) from exc
```

- [ ] **Step 6: Call it from the four handlers and register the exception handler**

In `register_routes`, first statement (before `router = APIRouter(...)`):

```python
    @app.exception_handler(RequestValidationError)
    async def friendly_validation_errors(
        request: Request, exc: RequestValidationError,
    ) -> JSONResponse:
        friendly = RequestValidationError(
            [_friendly(e) for e in exc.errors()], body=exc.body)
        return await request_validation_exception_handler(request, friendly)
```

Replace the domain/hook create and update handlers:

```python
    @router.post('/domains')
    def create_domain(payload: DomainInput) -> dict[str, object]:
        _validate_plugin_config(
            PROVIDER_REGISTRY[payload.provider], payload.provider_config, 'provider_config')
        domain = DomainConfig(**payload.model_dump())
        app.state.config.domains.append(domain)
        _persist(app)
        app.state.runtime.rebuild(app.state.config)
        return _masked_domain(domain)

    @router.put('/domains/{domain_id}')
    def update_domain(domain_id: str, payload: DomainInput) -> dict[str, object]:
        i, d = find_or_404(app.state.config.domains, domain_id, 'domain not found')
        cls = PROVIDER_REGISTRY[payload.provider]
        config = merge_secrets(cls.config_schema(), payload.provider_config, d.provider_config)
        _validate_plugin_config(cls, config, 'provider_config')
        updated = DomainConfig(
            id=domain_id, **{**payload.model_dump(), 'provider_config': config})
        app.state.config.domains[i] = updated
        _persist(app)
        app.state.runtime.rebuild(app.state.config)
        return _masked_domain(updated)
```

```python
    @router.post('/hooks-config')
    def create_hook(payload: HookInput) -> dict[str, object]:
        _validate_plugin_config(HOOK_REGISTRY[payload.hook], payload.config, 'config')
        hook = HookConfig(**payload.model_dump())
        app.state.config.hooks.append(hook)
        _persist(app)
        return _masked_hook(hook)

    @router.put('/hooks-config/{hook_id}')
    def update_hook(hook_id: str, payload: HookInput) -> dict[str, object]:
        i, h = find_or_404(app.state.config.hooks, hook_id, 'hook not found')
        cls = HOOK_REGISTRY[payload.hook]
        config = merge_secrets(cls.config_schema(), payload.config, h.config)
        _validate_plugin_config(cls, config, 'config')
        updated = HookConfig(id=hook_id, **{**payload.model_dump(), 'config': config})
        app.state.config.hooks[i] = updated
        _persist(app)
        return _masked_hook(updated)
```

- [ ] **Step 7: Run the API tests**

Run: `pytest test/unit/test_api_validation.py test/unit/test_api.py test/unit/test_api_healthchecks.py -v`
Expected: all PASS. If an existing test in `test_api.py` now gets a 422, give it a valid config (do not loosen validation).

- [ ] **Step 8: Run the full backend gates**

Run: `pytest test/test_flake8.py test/test_ruff.py test/test_mypy.py test/test_pyright.py && pytest test/ --cov=tether_ddns --cov-fail-under=90`
Expected: PASS. The one `StarletteDeprecationWarning` from fastapi's testclient is pre-existing and out of scope.

- [ ] **Step 9: Commit**

```bash
git add tether_ddns/api.py test/unit/test_api_validation.py test/unit/test_api.py
git commit -m "feat(api): validate provider and hook config on save with field-level 422s"
```

---

### Task 4: Frontend error plumbing — dotted keys, `subErrors`, `useFormErrors`, `FieldHelp`

**Files:**
- Modify: `frontend/src/api.ts:18-31`
- Modify: `frontend/src/api.test.ts:15-22`
- Create: `frontend/src/formErrors.ts`, `frontend/src/formErrors.test.tsx`
- Create: `frontend/src/components/FieldHelp.tsx`, `frontend/src/components/FieldHelp.test.tsx`

**Interfaces:**
- Produces:
  - `ApiError.fieldErrors` keys = loc path without leading `'body'`, joined with `.` (e.g. `provider_config.token`).
  - `export function subErrors(errors: Record<string, string>, prefix: string): Record<string, string>` in `formErrors.ts` — keys are the first segment after `prefix.`; an error keyed exactly `prefix` is returned under `''`.
  - `export function useFormErrors(fallback: string): FormErrors` in `formErrors.ts`, where `FormErrors = { errors: Record<string, string>; formError: string | null; saving: boolean; reset(): void; clear(match: (key: string) => boolean): void; submit(save: () => Promise<void>): Promise<void> }`.
  - `export function invalidProps(error: string | undefined, helpId: string, hasHelp?: boolean)` → `{ className: 'field-invalid' | undefined; 'aria-invalid': true | undefined; 'aria-describedby': string | undefined }` (`hasHelp` defaults to `Boolean(error)`).
  - `export function FieldHelp(props: { id: string; error?: string; children?: ReactNode })` — renders `<div id className="field-help[ hb-error]">` or `null` when there is no text.

- [ ] **Step 1: Write the failing tests**

In `frontend/src/api.test.ts`, add `subErrors` and `createDomain` to the import from `./api`, rename the existing 422 test and add new ones:

```ts
  it('maps a 422 detail list to fieldErrors keyed by the dotted path after body', async () => {
    const detail = [{ loc: ['body', 'heartbeat_url'], msg: 'Input should be a valid URL', type: 'url_parsing' }];
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 422, json: async () => ({ detail }) })));
    const err = await putSettings({ heartbeat_url: 'x' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(422);
    expect((err as ApiError).fieldErrors).toEqual({ heartbeat_url: 'Input should be a valid URL' });
    expect((err as ApiError).message).toBe('/api/settings -> 422');
  });

  it('keeps nested locs apart so plugin fields cannot collide with top-level ones', async () => {
    const detail = [
      { loc: ['body', 'provider_config', 'enabled'], msg: 'Required', type: 'missing' },
      { loc: ['body', 'enabled'], msg: 'Input should be a valid boolean', type: 'bool_type' },
      { loc: ['body'], msg: 'Field required', type: 'missing' },
    ];
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 422, json: async () => ({ detail }) })));
    const err = await createDomain({}).catch((e: unknown) => e);
    expect((err as ApiError).fieldErrors).toEqual({
      'provider_config.enabled': 'Required',
      enabled: 'Input should be a valid boolean',
    });
  });

  it('subErrors narrows to one section keyed by its first segment', () => {
    const errors = {
      hostname: 'Required',
      'provider_config.api_token': 'Required',
      'provider_config.ports.0': 'Input should be a valid integer',
      'provider_config.ports.1': 'second',
      provider_config: 'Invalid config',
      provider_configs: 'not mine',
    };
    expect(subErrors(errors, 'provider_config')).toEqual({
      api_token: 'Required',
      ports: 'Input should be a valid integer',
      '': 'Invalid config',
    });
  });
```

Create `frontend/src/components/FieldHelp.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FieldHelp } from './FieldHelp';

describe('FieldHelp', () => {
  it('renders nothing without an error or help text', () => {
    const { container } = render(<FieldHelp id="h" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the help text when there is no error', () => {
    render(<FieldHelp id="h">Your API token</FieldHelp>);
    const help = screen.getByText('Your API token');
    expect(help).toHaveAttribute('id', 'h');
    expect(help).toHaveClass('field-help');
    expect(help).not.toHaveClass('hb-error');
  });

  it('replaces the help text with the error', () => {
    render(<FieldHelp id="h" error="Required">Your API token</FieldHelp>);
    expect(screen.queryByText('Your API token')).toBeNull();
    expect(screen.getByText('Required')).toHaveClass('field-help', 'hb-error');
  });
});
```

Create `frontend/src/formErrors.test.tsx`:

```tsx
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from './api';
import { invalidProps, useFormErrors } from './formErrors';

describe('useFormErrors', () => {
  it('keeps 422 field errors from a rejected save', async () => {
    const { result } = renderHook(() => useFormErrors('Failed to save domain'));
    await act(() => result.current.submit(async () => {
      throw new ApiError('x', 422, { hostname: 'Required' });
    }));
    expect(result.current.errors).toEqual({ hostname: 'Required' });
    expect(result.current.formError).toBeNull();
    expect(result.current.saving).toBe(false);
  });

  it('falls back to the form-level message when no field is named', async () => {
    const { result } = renderHook(() => useFormErrors('Failed to save domain'));
    await act(() => result.current.submit(async () => { throw new Error('boom'); }));
    expect(result.current.errors).toEqual({});
    expect(result.current.formError).toBe('Failed to save domain');
  });

  it('ignores a second submit while one is in flight', async () => {
    const { result } = renderHook(() => useFormErrors('x'));
    let resolve: () => void = () => undefined;
    const save = vi.fn(() => new Promise<void>((r) => { resolve = r; }));
    let first: Promise<void> = Promise.resolve();
    act(() => { first = result.current.submit(save); });
    expect(result.current.saving).toBe(true);
    await act(() => result.current.submit(save));
    expect(save).toHaveBeenCalledTimes(1);
    await act(async () => { resolve(); await first; });
    expect(result.current.saving).toBe(false);
  });

  it('clears only matching keys and the form-level message', async () => {
    const { result } = renderHook(() => useFormErrors('x'));
    await act(() => result.current.submit(async () => {
      throw new ApiError('x', 422, { hostname: 'Required', 'provider_config.token': 'Required' });
    }));
    act(() => result.current.clear((k) => k === 'hostname'));
    expect(result.current.errors).toEqual({ 'provider_config.token': 'Required' });
    act(() => result.current.reset());
    expect(result.current.errors).toEqual({});
  });
});

describe('invalidProps', () => {
  it('decorates an invalid control and points at its help line', () => {
    expect(invalidProps('Required', 'h')).toEqual({
      className: 'field-invalid', 'aria-invalid': true, 'aria-describedby': 'h',
    });
  });

  it('leaves a valid control undecorated but still describes it when help exists', () => {
    expect(invalidProps(undefined, 'h')).toEqual({
      className: undefined, 'aria-invalid': undefined, 'aria-describedby': undefined,
    });
    expect(invalidProps(undefined, 'h', true)['aria-describedby']).toBe('h');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run src/api.test.ts src/formErrors.test.tsx src/components/FieldHelp.test.tsx`
Expected: FAIL — `subErrors`, `formErrors`, `FieldHelp` do not exist; nested-loc test gets `{ enabled: ..., body: ... }`.

- [ ] **Step 3: Implement `api.ts` changes**

Replace the `fieldErrorsOf` loop and its comment:

```ts
// FastAPI 422 bodies are {detail: [{loc: ['body', ...path], msg}]}; key each message by its dotted path.
async function fieldErrorsOf(res: Response): Promise<Record<string, string>> {
  try {
    const body = (await res.json()) as { detail?: unknown };
    if (!Array.isArray(body.detail)) return {};
    const out: Record<string, string> = {};
    for (const entry of body.detail as { loc?: unknown[]; msg?: unknown }[]) {
      const loc = entry.loc ?? [];
      const path = loc[0] === 'body' ? loc.slice(1) : loc;
      if (path.length > 0 && typeof entry.msg === 'string') out[path.join('.')] = entry.msg;
    }
    return out;
  } catch {
    return {};
  }
}

// Errors under `prefix.`, keyed by the next path segment; '' holds an error on `prefix` itself.
export function subErrors(errors: Record<string, string>, prefix: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, msg] of Object.entries(errors)) {
    if (key === prefix) out[''] = msg;
    else if (key.startsWith(`${prefix}.`)) {
      const field = key.slice(prefix.length + 1).split('.')[0];
      if (!(field in out)) out[field] = msg;
    }
  }
  return out;
}
```

- [ ] **Step 4: Implement `FieldHelp.tsx`**

```tsx
import type { ReactNode } from 'react';

export interface FieldHelpProps {
  id: string;
  error?: string;
  children?: ReactNode;
}

// Renders nothing when empty: an empty child would still add the .field flex gap.
export function FieldHelp({ id, error, children }: FieldHelpProps) {
  const text = error ?? children;
  if (text == null || text === '') return null;
  return <div id={id} className={`field-help${error ? ' hb-error' : ''}`}>{text}</div>;
}
```

- [ ] **Step 5: Implement `formErrors.ts`**

```ts
import { useCallback, useRef, useState } from 'react';
import { ApiError } from './api';

export interface FormErrors {
  errors: Record<string, string>;
  formError: string | null;
  saving: boolean;
  reset: () => void;
  clear: (match: (key: string) => boolean) => void;
  submit: (save: () => Promise<void>) => Promise<void>;
}

// Server-validated form state: a rejected save keeps its 422 field errors, else shows `fallback`.
export function useFormErrors(fallback: string): FormErrors {
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const busy = useRef(false);

  const reset = useCallback(() => {
    setErrors({});
    setFormError(null);
  }, []);

  const clear = useCallback((match: (key: string) => boolean) => {
    setErrors((prev) => Object.fromEntries(Object.entries(prev).filter(([key]) => !match(key))));
    setFormError(null);
  }, []);

  const submit = useCallback(async (save: () => Promise<void>) => {
    if (busy.current) return;
    busy.current = true;
    setSaving(true);
    try {
      await save();
    } catch (err) {
      const fields = err instanceof ApiError ? err.fieldErrors : {};
      setErrors(fields);
      setFormError(Object.keys(fields).length === 0 ? fallback : null);
    } finally {
      busy.current = false;
      setSaving(false);
    }
  }, [fallback]);

  return { errors, formError, saving, reset, clear, submit };
}

export function invalidProps(error: string | undefined, helpId: string, hasHelp = Boolean(error)) {
  return {
    className: error ? 'field-invalid' : undefined,
    'aria-invalid': error ? (true as const) : undefined,
    'aria-describedby': hasHelp ? helpId : undefined,
  };
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/api.test.ts src/formErrors.test.tsx src/components/FieldHelp.test.tsx src/components/ProjectModal.test.tsx src/views`
Expected: PASS (ProjectModal/SettingsView keys are unchanged).

- [ ] **Step 7: Lint and type-check**

Run: `cd frontend && npm run lint && npx tsc --noEmit -p tsconfig.app.json`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/api.ts frontend/src/api.test.ts frontend/src/formErrors.ts frontend/src/formErrors.test.tsx frontend/src/components/FieldHelp.tsx frontend/src/components/FieldHelp.test.tsx
git commit -m "feat(ui): key 422 field errors by dotted path and add shared form-error helpers"
```

---

### Task 5: Invalid styling, `Select` invalid props, `SchemaForm` errors and required markers

**Files:**
- Modify: `frontend/src/styles.css:516`
- Modify: `frontend/src/components/Select.tsx`, `frontend/src/components/Select.test.tsx`
- Modify: `frontend/src/components/SchemaForm.tsx`, `frontend/src/components/SchemaForm.test.tsx`
- Modify: `frontend/src/components/ProjectModal.tsx:74` (`hc-invalid` → `field-invalid`)

**Interfaces:**
- Consumes: `invalidProps`, `FieldHelp` (Task 4).
- Produces: `SelectProps.invalid?: boolean`, `SelectProps.describedBy?: string`; `SchemaFormProps.errors?: Record<string, string>` keyed by schema property name. Help ids: `sf-<key>-help`.

- [ ] **Step 1: Write the failing tests**

Append to `Select.test.tsx` (inside the `describe`):

```tsx
  it('marks the native select and trigger invalid when asked', () => {
    const { container } = render(
      <Select id="s3" ariaLabel="Choice" value="a" options={options} onChange={vi.fn()} invalid describedBy="s3-help" />,
    );
    const native = screen.getByLabelText('Choice');
    expect(native).toHaveAttribute('aria-invalid', 'true');
    expect(native).toHaveAttribute('aria-describedby', 's3-help');
    expect(container.querySelector('.cs-trigger')).toHaveClass('field-invalid');
  });

  it('is undecorated by default', () => {
    const { container } = render(<Select id="s4" ariaLabel="Choice" value="a" options={options} onChange={vi.fn()} />);
    expect(screen.getByLabelText('Choice')).not.toHaveAttribute('aria-invalid');
    expect(screen.getByLabelText('Choice')).not.toHaveAttribute('aria-describedby');
    expect(container.querySelector('.cs-trigger')).not.toHaveClass('field-invalid');
  });
```

Append to `SchemaForm.test.tsx` (inside the `describe`):

```tsx
  it('shows a field error in place of its description', () => {
    const schema = { properties: { token: { title: 'Token', type: 'string', description: 'Your API token' } } };
    render(<SchemaForm schema={schema} value={{}} onChange={vi.fn()} errors={{ token: 'Required' }} />);
    const input = screen.getByLabelText('Token');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveClass('field-invalid');
    expect(input).toHaveAttribute('aria-describedby', 'sf-token-help');
    expect(document.getElementById('sf-token-help')).toHaveTextContent('Required');
    expect(screen.queryByText('Your API token')).toBeNull();
  });

  it('decorates an enum select with its error', () => {
    const schema = { properties: { ip_version: { type: 'string', title: 'IP Version', enum: ['ipv4', 'ipv6'] } } };
    render(<SchemaForm schema={schema} value={{ ip_version: 'ipv4' }} onChange={vi.fn()} errors={{ ip_version: "Input should be 'ipv4' or 'ipv6'" }} />);
    const select = screen.getByLabelText('IP Version');
    expect(select).toHaveAttribute('aria-invalid', 'true');
    expect(select).toHaveClass('field-invalid');
    expect(screen.getByText("Input should be 'ipv4' or 'ipv6'")).toHaveClass('hb-error');
  });

  it('describes a valid field by its description and renders no empty help line', () => {
    const schema = { properties: { a: { title: 'A', description: 'about a' }, b: { title: 'B' } } };
    const { container } = render(<SchemaForm schema={schema} value={{}} onChange={vi.fn()} />);
    expect(screen.getByLabelText('A')).toHaveAttribute('aria-describedby', 'sf-a-help');
    expect(screen.getByLabelText('A')).not.toHaveAttribute('aria-invalid');
    expect(screen.getByLabelText('B')).not.toHaveAttribute('aria-describedby');
    expect(container.querySelectorAll('.field-help')).toHaveLength(1);
  });

  it('marks only schema-required fields as required', () => {
    const schema = {
      required: ['api_token'],
      properties: { api_token: { title: 'API Token', format: 'password' }, ttl: { title: 'TTL', type: 'integer' } },
    };
    const { container } = render(<SchemaForm schema={schema} value={{}} onChange={vi.fn()} />);
    expect(screen.getByLabelText('API Token')).toHaveAttribute('aria-required', 'true');
    expect(screen.getByLabelText('TTL')).not.toHaveAttribute('aria-required');
    const markers = container.querySelectorAll('label .req');
    expect(markers).toHaveLength(1);
    expect(markers[0]).toHaveAttribute('aria-hidden', 'true');
    expect(markers[0].closest('label')).toHaveAttribute('for', 'sf-api_token');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run src/components/Select.test.tsx src/components/SchemaForm.test.tsx`
Expected: the new tests FAIL.

- [ ] **Step 3: Implement `Select` props**

```tsx
export interface SelectProps {
  id?: string;
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  ariaLabel?: string;
  invalid?: boolean;
  describedBy?: string;
}
```

Destructure `invalid` and `describedBy`; on the native `<select className="cs-native" ...>` add `aria-invalid={invalid ? true : undefined}` and `aria-describedby={describedBy}`; on the trigger change `className="cs-trigger"` to `className={`cs-trigger${invalid ? ' field-invalid' : ''}`}`.

- [ ] **Step 4: Implement `SchemaForm` errors and markers**

Replace the component with (unchanged helpers `inputType` / `humanizeOption` stay above it):

```tsx
import { invalidProps } from '../formErrors';
import { FieldHelp } from './FieldHelp';

export interface SchemaFormProps {
  schema: JsonSchema;
  value: Record<string, unknown>;
  onChange: (value: Record<string, unknown>) => void;
  errors?: Record<string, string>;
}

export function SchemaForm({ schema, value, onChange, errors = {} }: SchemaFormProps) {
  const properties = schema.properties ?? {};
  const entries = Object.entries(properties);
  const required = new Set(schema.required ?? []);

  const update = (key: string, next: unknown) => {
    onChange({ ...value, [key]: next });
  };

  return (
    <>
      {entries.map(([key, prop]) => {
        const label = prop.title ?? key;
        const current = value[key];
        if (prop.type === 'boolean') {
          return (
            <div className="switch-row" key={key}>
              <div className="sr-text">
                <div className="t">{label}</div>
                {prop.description ? <div className="d">{prop.description}</div> : null}
              </div>
              <label className="switch">
                <input
                  type="checkbox"
                  aria-label={label}
                  checked={Boolean(current)}
                  onChange={(e) => update(key, e.target.checked)}
                />
                <span className="slider" />
              </label>
            </div>
          );
        }
        const error = errors[key];
        const helpId = `sf-${key}-help`;
        const decorate = {
          ...invalidProps(error, helpId, Boolean(error ?? prop.description)),
          'aria-required': required.has(key) ? (true as const) : undefined,
        };
        const labelEl = (
          <label htmlFor={`sf-${key}`}>
            {label}
            {required.has(key) ? <span className="req" aria-hidden="true">*</span> : null}
          </label>
        );
        const help = <FieldHelp id={helpId} error={error}>{prop.description}</FieldHelp>;
        if (prop.enum && prop.enum.length > 0) {
          const numeric = prop.enum.every((o) => typeof o === 'number');
          return (
            <div className="field" key={key}>
              {labelEl}
              <select
                id={`sf-${key}`}
                aria-label={label}
                {...decorate}
                value={current == null ? '' : String(current)}
                onChange={(e) => update(key, numeric ? Number(e.target.value) : e.target.value)}
              >
                {prop.enum.map((opt) => {
                  const labels = prop['x-enum-labels'];
                  const text = labels?.[String(opt)] ?? humanizeOption(opt);
                  return (
                    <option key={String(opt)} value={String(opt)}>{text}</option>
                  );
                })}
              </select>
              {help}
            </div>
          );
        }
        const type = inputType(prop);
        return (
          <div className="field" key={key}>
            {labelEl}
            <input
              id={`sf-${key}`}
              type={type}
              aria-label={label}
              {...decorate}
              value={current == null ? '' : String(current)}
              onChange={(e) => {
                const raw = e.target.value;
                update(key, type === 'number' ? (raw === '' ? '' : Number(raw)) : raw);
              }}
            />
            {help}
          </div>
        );
      })}
    </>
  );
}
```

- [ ] **Step 5: CSS and ProjectModal class**

In `styles.css` replace the line `.field input.hc-invalid { border-color: var(--err); box-shadow: 0 0 0 3px var(--err-soft); }` with:

```css
.field :is(input, select, .cs-trigger).field-invalid { border-color: var(--err); box-shadow: 0 0 0 3px var(--err-soft); }
.field label .req { color: var(--text-3); font-weight: 400; margin-left: 2px; }
```

In `ProjectModal.tsx` change `className: errors[key] ? 'hc-invalid' : undefined,` to `className: errors[key] ? 'field-invalid' : undefined,`. Then confirm nothing else references the old class: `grep -rn "hc-invalid" frontend/src frontend/e2e` → no results.

- [ ] **Step 6: Run the tests**

Run: `cd frontend && npx vitest run src/components`
Expected: PASS.

- [ ] **Step 7: Lint and type-check**

Run: `cd frontend && npm run lint && npx tsc --noEmit -p tsconfig.app.json`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/styles.css frontend/src/components/Select.tsx frontend/src/components/Select.test.tsx frontend/src/components/SchemaForm.tsx frontend/src/components/SchemaForm.test.tsx frontend/src/components/ProjectModal.tsx
git commit -m "feat(ui): decorate invalid schema fields and selects, mark required fields"
```

---

### Task 6: DomainModal shows server errors inline and survives a providers refetch

**Files:**
- Modify: `frontend/src/components/DomainModal.tsx`
- Modify: `frontend/src/components/DomainModal.test.tsx`

**Interfaces:**
- Consumes: `subErrors` (api.ts), `useFormErrors`, `invalidProps` (formErrors.ts), `FieldHelp`, `Select.invalid/describedBy`, `SchemaForm.errors`.
- Produces: `DomainModalProps.onSave: (input: DomainFormValue) => Promise<void>` — must reject on failure (Task 8 relies on this). Help ids: `fHostname-help`, `fProvider-help`, `fType-help`. Fallback alert text: `Failed to save domain`.

- [ ] **Step 1: Write the failing tests**

In `DomainModal.test.tsx` add imports `waitFor` (from `@testing-library/react`) and `import { ApiError } from '../api';`, then add inside the `describe`:

```tsx
  const twoProviders: Provider[] = [
    { key: 'duckdns', display_name: 'DuckDNS', schema: { required: ['token'], properties: { token: { title: 'Token', format: 'password' } } } },
    { key: 'cloudflare', display_name: 'Cloudflare', schema: { required: ['api_token'], properties: { api_token: { title: 'API Token', format: 'password' } } } },
  ];
  const rejectWith = (fieldErrors: Record<string, string>) =>
    vi.fn(async () => { throw new ApiError('/api/domains -> 422', 422, fieldErrors); });
  const openAdd = (onSave: DomainModalProps['onSave'], list = twoProviders) =>
    render(<DomainModal open providers={list} editing={null} onClose={vi.fn()} onSave={onSave} />);

  it('shows server field errors on hostname, record type and provider config', async () => {
    openAdd(rejectWith({
      hostname: 'Required', 'provider_config.token': 'Required', record_type: "Input should be 'A' or 'AAAA'",
    }));
    fireEvent.click(screen.getByRole('button', { name: 'Add Domain' }));
    expect(await screen.findAllByText('Required')).toHaveLength(2);
    expect(screen.getByLabelText('Hostname / FQDN')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Hostname / FQDN')).toHaveAttribute('aria-describedby', 'fHostname-help');
    expect(screen.getByLabelText('Token')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Record Type')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('clears only the edited field error', async () => {
    openAdd(rejectWith({ hostname: 'Required', 'provider_config.token': 'Required' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add Domain' }));
    await screen.findAllByText('Required');
    fireEvent.change(screen.getByLabelText('Hostname / FQDN'), { target: { value: 'h.example.com' } });
    expect(screen.getByLabelText('Hostname / FQDN')).not.toHaveAttribute('aria-invalid');
    expect(screen.getByLabelText('Token')).toHaveAttribute('aria-invalid', 'true');
    fireEvent.change(screen.getByLabelText('Token'), { target: { value: 't' } });
    expect(screen.getByLabelText('Token')).not.toHaveAttribute('aria-invalid');
  });

  it('drops provider config errors when the provider changes', async () => {
    openAdd(rejectWith({ hostname: 'Required', 'provider_config.token': 'Required' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add Domain' }));
    await screen.findAllByText('Required');
    fireEvent.change(screen.getByLabelText('DNS Provider'), { target: { value: 'cloudflare' } });
    expect(screen.getByLabelText('API Token')).not.toHaveAttribute('aria-invalid');
    expect(screen.getAllByText('Required')).toHaveLength(1);
    expect(screen.getByLabelText('Hostname / FQDN')).toHaveAttribute('aria-invalid', 'true');
  });

  it('shows a form-level alert when no field is named', async () => {
    openAdd(vi.fn(async () => { throw new Error('boom'); }));
    fireEvent.click(screen.getByRole('button', { name: 'Add Domain' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to save domain');
  });

  it('shows an error on the whole provider config as a form-level alert', async () => {
    openAdd(rejectWith({ provider_config: 'Invalid config' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add Domain' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid config');
  });

  it('disables submit while saving', async () => {
    const onSave = vi.fn(() => new Promise<void>(() => undefined));
    openAdd(onSave);
    const button = screen.getByRole('button', { name: 'Add Domain' });
    fireEvent.click(button);
    await waitFor(() => expect(button).toBeDisabled());
    fireEvent.click(button);
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('keeps typed values and errors when providers are refetched', async () => {
    const onSave = rejectWith({ 'provider_config.token': 'Required' });
    const { rerender } = openAdd(onSave);
    fireEvent.change(screen.getByLabelText('Hostname / FQDN'), { target: { value: 'kept.example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add Domain' }));
    await screen.findByText('Required');
    rerender(<DomainModal open providers={[...twoProviders]} editing={null} onClose={vi.fn()} onSave={onSave} />);
    expect(screen.getByLabelText('Hostname / FQDN')).toHaveValue('kept.example.com');
    expect(screen.getByLabelText('Token')).toHaveAttribute('aria-invalid', 'true');
  });

  it('fills the default provider when providers arrive after opening', () => {
    const { rerender } = openAdd(vi.fn(), []);
    rerender(<DomainModal open providers={twoProviders} editing={null} onClose={vi.fn()} onSave={vi.fn()} />);
    expect(screen.getByLabelText('DNS Provider')).toHaveValue('duckdns');
  });
```

Also change the import to `import { DomainModal, type DomainModalProps } from './DomainModal';`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run src/components/DomainModal.test.tsx`
Expected: the new tests FAIL (no errors rendered; refetch test loses the hostname).

- [ ] **Step 3: Implement DomainModal**

Replace `DomainModal.tsx` with:

```tsx
import { useEffect, useRef, useState } from 'react';
import { invalidProps, subErrors, useFormErrors } from '../formErrors';
import type { DomainConfig, Provider } from '../types';
import { FieldHelp } from './FieldHelp';
import { SchemaForm, type JsonSchema } from './SchemaForm';
import { Select } from './Select';
import { Modal } from './Modal';

export interface DomainModalProps {
  open: boolean;
  providers: Provider[];
  editing: DomainConfig | null;
  onClose: () => void;
  onSave: (input: DomainFormValue) => Promise<void>;
}

export interface DomainFormValue {
  hostname: string;
  provider: string;
  record_type: string;
  enabled: boolean;
  provider_config: Record<string, unknown>;
}

const EMPTY: DomainFormValue = {
  hostname: '',
  provider: '',
  record_type: 'A',
  enabled: true,
  provider_config: {},
};

const CONFIG = 'provider_config';
const inConfig = (key: string) => key === CONFIG || key.startsWith(`${CONFIG}.`);

export function DomainModal({ open, providers, editing, onClose, onSave }: DomainModalProps) {
  const [form, setForm] = useState<DomainFormValue>(EMPTY);
  const { errors, formError, saving, reset, clear, submit } = useFormErrors('Failed to save domain');
  // Read, not depended on: a ws reconnect refetches providers and must not wipe the form.
  const providersRef = useRef(providers);
  useEffect(() => { providersRef.current = providers; }, [providers]);

  useEffect(() => {
    if (editing) {
      setForm({
        hostname: editing.hostname,
        provider: editing.provider,
        record_type: editing.record_type,
        enabled: editing.enabled,
        provider_config: editing.provider_config ?? {},
      });
    } else {
      setForm({ ...EMPTY, provider: providersRef.current[0]?.key ?? '' });
    }
    reset();
  }, [editing, open, reset]);

  useEffect(() => {
    if (!editing && form.provider === '' && providers.length > 0) {
      setForm((f) => ({ ...f, provider: providers[0].key }));
    }
  }, [editing, form.provider, providers]);

  const update = (patch: Partial<DomainFormValue>) => {
    setForm((f) => ({ ...f, ...patch }));
    const keys = Object.keys(patch);
    clear((k) => keys.includes(k));
  };
  const changeProvider = (provider: string) => {
    setForm((f) => ({ ...f, provider, provider_config: {} }));
    clear((k) => k === 'provider' || inConfig(k));
  };
  const changeConfig = (provider_config: Record<string, unknown>) => {
    const changed = Object.keys(provider_config).filter((k) => provider_config[k] !== form.provider_config[k]);
    setForm((f) => ({ ...f, provider_config }));
    clear((k) => k === CONFIG || changed.some((c) => k === `${CONFIG}.${c}` || k.startsWith(`${CONFIG}.${c}.`)));
  };

  const selected = providers.find((p) => p.key === form.provider);
  const schema = (selected?.schema ?? {}) as JsonSchema;
  const configErrors = subErrors(errors, CONFIG);
  const alert = formError ?? configErrors[''] ?? null;

  return (
    <Modal
      open={open}
      title={editing ? 'Edit Domain' : 'Add Domain'}
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={saving} onClick={() => { void submit(() => onSave(form)); }}>
            {editing ? 'Save Changes' : 'Add Domain'}
          </button>
        </>
      )}
    >
      <div className="field">
        <label htmlFor="fHostname">Hostname / FQDN</label>
        <input
          id="fHostname"
          type="text"
          placeholder="home.example.com"
          autoComplete="off"
          value={form.hostname}
          {...invalidProps(errors.hostname, 'fHostname-help')}
          onChange={(e) => update({ hostname: e.target.value })}
        />
        <FieldHelp id="fHostname-help" error={errors.hostname} />
      </div>
      <div className="field-row">
        <div className="field">
          <label htmlFor="fProvider">DNS Provider</label>
          <Select
            id="fProvider"
            ariaLabel="DNS Provider"
            value={form.provider}
            options={providers.map((p) => ({ value: p.key, label: p.display_name }))}
            invalid={Boolean(errors.provider)}
            describedBy={errors.provider ? 'fProvider-help' : undefined}
            onChange={changeProvider}
          />
          <FieldHelp id="fProvider-help" error={errors.provider} />
        </div>
        <div className="field">
          <label htmlFor="fType">Record Type</label>
          <Select
            id="fType"
            ariaLabel="Record Type"
            value={form.record_type}
            options={[
              { value: 'A', label: 'A (IPv4)' },
              { value: 'AAAA', label: 'AAAA (IPv6)' },
            ]}
            invalid={Boolean(errors.record_type)}
            describedBy={errors.record_type ? 'fType-help' : undefined}
            onChange={(record_type) => update({ record_type })}
          />
          <FieldHelp id="fType-help" error={errors.record_type} />
        </div>
      </div>
      {schema.description ? <p className="modal-blurb">{schema.description}</p> : null}
      <SchemaForm schema={schema} value={form.provider_config} errors={configErrors} onChange={changeConfig} />
      <div className="switch-row">
        <div className="sr-text">
          <div className="t">Enable auto-update</div>
          <div className="d">Automatically sync this record on IP change</div>
        </div>
        <label className="switch">
          <input type="checkbox" checked={form.enabled} onChange={(e) => update({ enabled: e.target.checked })} />
          <span className="slider" />
        </label>
      </div>
      {alert ? <div className="field-help hb-error" role="alert">{alert}</div> : null}
    </Modal>
  );
}
```

- [ ] **Step 4: Run the tests**

Run: `cd frontend && npx vitest run src/components/DomainModal.test.tsx`
Expected: all PASS, including the pre-existing tests.

- [ ] **Step 5: Lint and type-check**

Run: `cd frontend && npm run lint && npx tsc --noEmit -p tsconfig.app.json`
Expected: clean. (`App.tsx`'s `handleSaveDomain` is already `async`, so it satisfies the new `Promise<void>` prop type.)

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/DomainModal.tsx frontend/src/components/DomainModal.test.tsx
git commit -m "feat(ui): show domain save errors inline and keep the form across provider refetches"
```

---

### Task 7: HookModal shows server errors inline and survives a hooks refetch

**Files:**
- Modify: `frontend/src/components/HookModal.tsx`
- Modify: `frontend/src/components/HookModal.test.tsx`

**Interfaces:**
- Consumes: same as Task 6.
- Produces: `HookModalProps.onSave: (input: HookFormValue) => Promise<void>` — rejects on failure. Help ids: `fHook-help`, `fEvents-help`. Events chips become `role="group" aria-label="Events"`. Fallback alert text: `Failed to save hook`.

- [ ] **Step 1: Write the failing tests**

In `HookModal.test.tsx` add `waitFor` to the testing-library import, `import { ApiError } from '../api';`, change the component import to `import { HookModal, type HookModalProps } from './HookModal';`, and add inside the `describe`:

```tsx
  const twoHooks: HookDef[] = [
    {
      key: 'pushover', display_name: 'Pushover',
      events: [{ key: 'ip_changed', label: 'IP Changed' }],
      schema: { required: ['user'], properties: { user: { title: 'User Key', format: 'password' } } },
    },
    { key: 'log', display_name: 'Log Hook', events: [{ key: 'ip_changed', label: 'IP Changed' }], schema: {} },
  ];
  const rejectWith = (fieldErrors: Record<string, string>) =>
    vi.fn(async () => { throw new ApiError('/api/hooks-config -> 422', 422, fieldErrors); });
  const openAdd = (onSave: HookModalProps['onSave'], list = twoHooks) =>
    render(<HookModal open hooks={list} editing={null} onClose={vi.fn()} onSave={onSave} />);

  it('shows server errors on the hook, its events and its config', async () => {
    openAdd(rejectWith({ hook: 'Unknown hook', events: 'Unsupported event x', 'config.user': 'Required' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add Hook' }));
    expect(await screen.findByText('Required')).toBeInTheDocument();
    expect(screen.getByLabelText('Hook')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('User Key')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('group', { name: 'Events' })).toHaveAttribute('aria-describedby', 'fEvents-help');
    expect(document.getElementById('fEvents-help')).toHaveTextContent('Unsupported event x');
  });

  it('clears the events error when an event is toggled', async () => {
    openAdd(rejectWith({ events: 'Unsupported event x' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add Hook' }));
    await screen.findByText('Unsupported event x');
    fireEvent.click(screen.getByRole('button', { name: 'IP Changed' }));
    expect(screen.queryByText('Unsupported event x')).toBeNull();
  });

  it('drops hook and config errors when the hook type changes', async () => {
    openAdd(rejectWith({ hook: 'Unknown hook', 'config.user': 'Required' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add Hook' }));
    await screen.findByText('Required');
    fireEvent.change(screen.getByLabelText('Hook'), { target: { value: 'log' } });
    expect(screen.queryByText('Required')).toBeNull();
    expect(screen.queryByText('Unknown hook')).toBeNull();
    expect(screen.getByLabelText('Hook')).not.toHaveAttribute('aria-invalid');
  });

  it('shows a form-level alert when no field is named', async () => {
    openAdd(vi.fn(async () => { throw new Error('boom'); }));
    fireEvent.click(screen.getByRole('button', { name: 'Add Hook' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to save hook');
  });

  it('disables submit while saving', async () => {
    const onSave = vi.fn(() => new Promise<void>(() => undefined));
    openAdd(onSave);
    const button = screen.getByRole('button', { name: 'Add Hook' });
    fireEvent.click(button);
    await waitFor(() => expect(button).toBeDisabled());
  });

  it('keeps the selection and errors when hooks are refetched', async () => {
    const onSave = rejectWith({ 'config.user': 'Required' });
    const { rerender } = openAdd(onSave);
    fireEvent.click(screen.getByRole('button', { name: 'IP Changed' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add Hook' }));
    await screen.findByText('Required');
    rerender(<HookModal open hooks={[...twoHooks]} editing={null} onClose={vi.fn()} onSave={onSave} />);
    expect(screen.getByRole('button', { name: 'IP Changed' })).toHaveClass('active');
    expect(screen.getByLabelText('User Key')).toHaveAttribute('aria-invalid', 'true');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run src/components/HookModal.test.tsx`
Expected: the new tests FAIL.

- [ ] **Step 3: Implement HookModal**

Replace `HookModal.tsx` with:

```tsx
import { useEffect, useRef, useState } from 'react';
import { subErrors, useFormErrors } from '../formErrors';
import type { HookConfig, HookDef } from '../types';
import { FieldHelp } from './FieldHelp';
import { SchemaForm, type JsonSchema } from './SchemaForm';
import { Select } from './Select';
import { Modal } from './Modal';

export interface HookModalProps {
  open: boolean;
  hooks: HookDef[];
  editing: HookConfig | null;
  onClose: () => void;
  onSave: (input: HookFormValue) => Promise<void>;
}

export interface HookFormValue {
  hook: string;
  events: string[];
  config: Record<string, unknown>;
}

const EMPTY: HookFormValue = { hook: '', events: [], config: {} };

const CONFIG = 'config';
const inConfig = (key: string) => key === CONFIG || key.startsWith(`${CONFIG}.`);

export function HookModal({ open, hooks, editing, onClose, onSave }: HookModalProps) {
  const [form, setForm] = useState<HookFormValue>(EMPTY);
  const { errors, formError, saving, reset, clear, submit } = useFormErrors('Failed to save hook');
  // Read, not depended on: a ws reconnect refetches hooks and must not wipe the form.
  const hooksRef = useRef(hooks);
  useEffect(() => { hooksRef.current = hooks; }, [hooks]);

  useEffect(() => {
    if (editing) {
      setForm({ hook: editing.hook, events: editing.events, config: editing.config ?? {} });
    } else {
      setForm({ ...EMPTY, hook: hooksRef.current[0]?.key ?? '' });
    }
    reset();
  }, [editing, open, reset]);

  useEffect(() => {
    if (!editing && form.hook === '' && hooks.length > 0) {
      setForm((f) => ({ ...f, hook: hooks[0].key }));
    }
  }, [editing, form.hook, hooks]);

  const selected = hooks.find((h) => h.key === form.hook);
  const schema = (selected?.schema ?? {}) as JsonSchema;
  const availableEvents = selected?.events ?? [];
  const configErrors = subErrors(errors, CONFIG);
  const alert = formError ?? configErrors[''] ?? null;

  const changeHook = (hook: string) => {
    setForm((f) => ({ ...f, hook, config: {}, events: [] }));
    clear((k) => k === 'hook' || k === 'events' || inConfig(k));
  };
  const toggleEvent = (event: string) => {
    setForm((prev) => ({
      ...prev,
      events: prev.events.includes(event)
        ? prev.events.filter((e) => e !== event)
        : [...prev.events, event],
    }));
    clear((k) => k === 'events');
  };
  const changeConfig = (config: Record<string, unknown>) => {
    const changed = Object.keys(config).filter((k) => config[k] !== form.config[k]);
    setForm((f) => ({ ...f, config }));
    clear((k) => k === CONFIG || changed.some((c) => k === `${CONFIG}.${c}` || k.startsWith(`${CONFIG}.${c}.`)));
  };

  return (
    <Modal
      open={open}
      title={editing ? 'Edit Hook' : 'Add Hook'}
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={saving} onClick={() => { void submit(() => onSave(form)); }}>
            {editing ? 'Save Changes' : 'Add Hook'}
          </button>
        </>
      )}
    >
      <div className="field">
        <label htmlFor="fHook">Hook</label>
        <Select
          id="fHook"
          ariaLabel="Hook"
          value={form.hook}
          options={hooks.map((h) => ({ value: h.key, label: h.display_name }))}
          invalid={Boolean(errors.hook)}
          describedBy={errors.hook ? 'fHook-help' : undefined}
          onChange={changeHook}
        />
        <FieldHelp id="fHook-help" error={errors.hook} />
      </div>
      {schema.description ? <p className="modal-blurb">{schema.description}</p> : null}
      <div className="field">
        <label>Events</label>
        <div
          className="chips"
          role="group"
          aria-label="Events"
          aria-describedby={errors.events ? 'fEvents-help' : undefined}
        >
          {availableEvents.map((event) => (
            <button
              type="button"
              key={event.key}
              className={`chip${form.events.includes(event.key) ? ' active' : ''}`}
              aria-pressed={form.events.includes(event.key)}
              onClick={() => toggleEvent(event.key)}
            >
              {event.label}
            </button>
          ))}
        </div>
        <FieldHelp id="fEvents-help" error={errors.events} />
      </div>
      <SchemaForm schema={schema} value={form.config} errors={configErrors} onChange={changeConfig} />
      {alert ? <div className="field-help hb-error" role="alert">{alert}</div> : null}
    </Modal>
  );
}
```

- [ ] **Step 4: Run the tests**

Run: `cd frontend && npx vitest run src/components/HookModal.test.tsx`
Expected: all PASS, including the pre-existing tests.

- [ ] **Step 5: Lint**

Run: `cd frontend && npm run lint`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/HookModal.tsx frontend/src/components/HookModal.test.tsx
git commit -m "feat(ui): show hook save errors inline and keep the form across hook refetches"
```

---

### Task 8: App save handlers rethrow; toggle toast names the domain

**Files:**
- Modify: `frontend/src/App.tsx:209-226,286-298,300-314`
- Create: `frontend/src/App.validation.test.tsx`

**Interfaces:**
- Consumes: `DomainModalProps.onSave` / `HookModalProps.onSave` rejecting contract (Tasks 6, 7); `api.ApiError`.

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/App.validation.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import App from './App';
import * as api from './api';

// Mock every request but keep the real ApiError class and pure helpers.
vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>();
  const keep = new Set(['ApiError']);
  return Object.fromEntries(
    Object.entries(actual).map(([name, value]) => [name, keep.has(name) ? value : vi.fn()]),
  );
});
vi.mock('./useLiveState', () => ({
  useLiveState: () => ({
    snapshot: { public_ipv4: '1.2.3.4', public_ipv6: null, online: true, domains: [] },
    logs: [],
    status: 'open',
    generation: 0,
  }),
}));

const DOMAIN = { id: 'd1', hostname: 'home.example.com', provider: 'duckdns', record_type: 'A', enabled: true, provider_config: {} };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getDomains).mockResolvedValue([DOMAIN] as never);
  vi.mocked(api.getHooksConfig).mockResolvedValue([] as never);
  vi.mocked(api.getHealthchecks).mockResolvedValue([] as never);
  vi.mocked(api.getSettings).mockResolvedValue({
    check_interval: 300, ip_source: 'ipify', update_on_startup: true,
    retry_on_failure: true, notify: true, heartbeat_url: null, heartbeat_interval: 300,
  } as never);
  vi.mocked(api.getProviders).mockResolvedValue([
    { key: 'duckdns', display_name: 'DuckDNS', schema: { required: ['token'], properties: { token: { title: 'Token', format: 'password' } } } },
  ] as never);
  vi.mocked(api.getHooks).mockResolvedValue([] as never);
  vi.mocked(api.getIpSources).mockResolvedValue([] as never);
  vi.mocked(api.getIncidents).mockResolvedValue({ monitoring_since: 0, rev: 0, incidents: [], ongoing: null } as never);
});

async function openDomains() {
  render(<App />);
  fireEvent.click(within(screen.getByRole('navigation')).getByRole('button', { name: /Domains/ }));
  await within(screen.getByRole('main')).findByRole('checkbox');
}

describe('App form validation', () => {
  it('shows domain save errors inline, keeps the modal open and skips the error toast', async () => {
    vi.mocked(api.createDomain).mockRejectedValue(
      new api.ApiError('/api/domains -> 422', 422, { 'provider_config.token': 'Required' }));
    await openDomains();
    fireEvent.click(within(screen.getByRole('main')).getByRole('button', { name: 'Add Domain' }));
    const dialog = screen.getByRole('dialog', { name: 'Add Domain' });
    fireEvent.change(within(dialog).getByLabelText('Hostname / FQDN'), { target: { value: 'new.example.com' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add Domain' }));
    expect(await within(dialog).findByText('Required')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Add Domain' })).toBeInTheDocument();
    expect(screen.queryByText('Failed to save domain')).toBeNull();
  });

  it('lets the server judge an empty hostname', async () => {
    vi.mocked(api.createDomain).mockRejectedValue(
      new api.ApiError('/api/domains -> 422', 422, { hostname: 'Required' }));
    await openDomains();
    fireEvent.click(within(screen.getByRole('main')).getByRole('button', { name: 'Add Domain' }));
    const dialog = screen.getByRole('dialog', { name: 'Add Domain' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add Domain' }));
    await waitFor(() => expect(api.createDomain).toHaveBeenCalledWith(expect.objectContaining({ hostname: '' })));
    expect(await within(dialog).findByText('Required')).toBeInTheDocument();
    expect(screen.queryByText('Please enter a hostname')).toBeNull();
  });

  it('names the domain when a toggle is rejected as invalid', async () => {
    vi.mocked(api.updateDomain).mockRejectedValue(
      new api.ApiError('/api/domains/d1 -> 422', 422, { 'provider_config.token': 'Required' }));
    await openDomains();
    fireEvent.click(within(screen.getByRole('main')).getByRole('checkbox'));
    expect(await screen.findByText('home.example.com: fix its provider config first')).toBeInTheDocument();
  });

  it('keeps the generic message for other toggle failures', async () => {
    vi.mocked(api.updateDomain).mockRejectedValue(new Error('boom'));
    await openDomains();
    fireEvent.click(within(screen.getByRole('main')).getByRole('checkbox'));
    expect(await screen.findByText('Failed to update domain')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run src/App.validation.test.tsx`
Expected: FAIL — the empty-hostname test never calls `createDomain`, the inline-errors test shows the `Failed to save domain` toast, the toggle test shows `Failed to update domain`.

- [ ] **Step 3: Update the handlers**

Replace `handleSaveDomain`:

```tsx
  // Rejects on failure so DomainModal can render the field errors inline.
  const handleSaveDomain = useCallback(
    async (value: DomainFormValue) => {
      if (editingDomain) await api.updateDomain(editingDomain.id, value);
      else await api.createDomain(value);
      pushToast(`Saved ${value.hostname}`, 'success');
      setDomainModalOpen(false);
      setEditingDomain(null);
      await loadConfig();
    },
    [editingDomain, loadConfig, pushToast],
  );
```

Replace the `catch` in `handleToggle`:

```tsx
      } catch (err) {
        pushToast(
          err instanceof api.ApiError && err.status === 422
            ? `${d.hostname}: fix its provider config first`
            : 'Failed to update domain',
          'error',
        );
      }
```

Replace `handleSaveHook`:

```tsx
  // Rejects on failure so HookModal can render the field errors inline.
  const handleSaveHook = useCallback(
    async (value: HookFormValue) => {
      if (editingHook) await api.updateHook(editingHook.id, value);
      else await api.createHook(value);
      pushToast('Hook saved', 'success');
      setHookModalOpen(false);
      setEditingHook(null);
      await loadConfig();
    },
    [editingHook, loadConfig, pushToast],
  );
```

- [ ] **Step 4: Run the full frontend suite and type-check**

Run: `cd frontend && npm test && npx tsc --noEmit -p tsconfig.app.json`
Expected: all PASS, coverage thresholds met, `tsc` clean.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/App.tsx frontend/src/App.validation.test.tsx
git commit -m "feat(ui): let modals own save errors and explain rejected domain toggles"
```

---

### Task 9: Real-browser proof of the invalid styling

**Files:**
- Create: `frontend/e2e/validation.spec.ts`

**Interfaces:**
- Consumes: the real backend (Task 3) for the domain case; a routed 422 for the hook case.

- [ ] **Step 1: Write the e2e spec**

```ts
import { test, expect, type Page } from '@playwright/test';

// Computed colour of the --err token, in the same rgb() form toHaveCSS reports.
async function errColor(page: Page): Promise<string> {
  return page.evaluate(() => {
    const probe = document.createElement('div');
    probe.style.color = 'var(--err)';
    document.body.appendChild(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  });
}

test('a domain saved without its provider token is flagged on the token field', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('navigation').getByRole('button', { name: /Domains/ }).click();
  await page.getByRole('main').getByRole('button', { name: 'Add Domain' }).click();
  const modal = page.locator('.modal-overlay.open .modal');
  await expect(modal).toHaveCSS('transform', 'none');

  await modal.getByLabel('Hostname / FQDN').fill('cf.example.com');
  await modal.getByLabel('DNS Provider').selectOption({ label: 'Cloudflare' });
  await modal.locator('.modal-foot').getByRole('button', { name: 'Add Domain' }).click();

  const token = modal.getByLabel('API Token', { exact: true });
  await expect(token).toHaveAttribute('aria-invalid', 'true');
  await expect(token).toHaveCSS('border-color', await errColor(page));
  await expect(modal.locator('#sf-api_token-help')).toHaveText('Required');
});

test('hook save errors decorate the custom select and a schema select', async ({ page }) => {
  await page.route('**/api/hooks-config', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    return route.fulfill({
      status: 422,
      json: { detail: [
        { loc: ['body', 'hook'], msg: 'Unknown hook', type: 'unknown_hook' },
        { loc: ['body', 'config', 'ip_version'], msg: "Input should be 'ipv4' or 'ipv6'", type: 'literal_error' },
      ] },
    });
  });
  await page.goto('/');
  await page.getByRole('navigation').getByRole('button', { name: /Hooks/ }).click();
  await page.getByRole('main').getByRole('button', { name: 'Add Hook' }).click();
  const modal = page.locator('.modal-overlay.open .modal');
  await expect(modal).toHaveCSS('transform', 'none');

  await modal.getByLabel('Hook', { exact: true }).selectOption({ label: 'Router Firewall (ZTE)' });
  await modal.locator('.modal-foot').getByRole('button', { name: 'Add Hook' }).click();

  const err = await errColor(page);
  await expect(modal.getByLabel('Hook', { exact: true })).toHaveAttribute('aria-invalid', 'true');
  await expect(modal.locator('.cs-trigger').first()).toHaveCSS('border-color', err);
  const ipVersion = modal.getByLabel('IP Version');
  await expect(ipVersion).toHaveAttribute('aria-invalid', 'true');
  await expect(ipVersion).toHaveCSS('border-color', err);
});
```

- [ ] **Step 2: Run the e2e spec**

Run: `cd frontend && npx playwright test e2e/validation.spec.ts`
Expected: 2 passed. (Port 8123 must be free; the webServer builds the frontend first.)

- [ ] **Step 3: Run the whole e2e suite**

Run: `cd frontend && npx playwright test`
Expected: all pass — in particular `add a domain from the Domains view` (DuckDNS with a token) and `heartbeat settings show the validation message inline` (URL message is not rewritten).

- [ ] **Step 4: Commit**

```bash
git add frontend/e2e/validation.spec.ts
git commit -m "test(e2e): prove invalid field styling on domain and hook modals"
```

---

### Task 10: Final verification

- [ ] **Step 1: Backend gates**

Run: `source .venv/bin/activate && pytest test/test_flake8.py test/test_ruff.py test/test_mypy.py test/test_pyright.py && pytest test/ --cov=tether_ddns --cov-fail-under=90`
Expected: PASS, coverage ≥ 90%.

- [ ] **Step 2: Frontend gates**

Run: `cd frontend && npm test && npx tsc --noEmit -p tsconfig.app.json && npx playwright test`
Expected: PASS.

- [ ] **Step 3: Confirm no stale references**

Run: `grep -rn "hc-invalid\|_validate_hook_events\|Please enter a hostname" tether_ddns frontend/src frontend/e2e test`
Expected: no output.
