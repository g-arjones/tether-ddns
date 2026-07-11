# Cloudflare DDNS Provider — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an auto-loaded Cloudflare DDNS provider that resolves the zone and record from the hostname and updates the record via the Cloudflare API.

**Architecture:** One provider module (subclass `DDNSProvider`, `@register_provider`) plus a unit test. No other wiring — the registry auto-loads it and the UI renders its config form from the schema.

**Tech Stack:** Python 3.12 (aiohttp, pydantic).

## Global Constraints

- Python `>=3.12`. Strict gates: flake8 (pep257 docstrings, alphabetical import order, single quotes, naming), mypy (`mypy .`), pyright strict (`pyright tether_ddns`), ruff. Docstrings + full annotations.
- Backend coverage gate: `pytest test/` must pass with `--cov-fail-under=90`.
- Secrets use `pydantic.SecretStr`; the token is read via `.get_secret_value()`; the password form field is masked/write-only by existing handling.
- Provider `update()` returns a failure `UpdateResult` on API errors; it does NOT need its own broad try/except (scheduler/api wrap it). Do not add `# noqa: BLE001` here.
- No changes outside the new provider file + its test (registry auto-loads it).
- Venv at `.venv` (`source .venv/bin/activate`; project uses `uv`). Backend unit tests in `test/unit/`.

---

## Task 1: Cloudflare provider

**Files:**
- Create: `tether_ddns/providers/ddns_providers/cloudflare.py`
- Test: `test/unit/test_cloudflare.py`

**Interfaces:**
- `CloudflareConfig(BaseModel)`: `api_token: SecretStr`, `proxied: bool = False`, `ttl: int = 1`.
- `CloudflareProvider(DDNSProvider)`: `key = 'cloudflare'`, `display_name = 'Cloudflare'`, `ConfigModel = CloudflareConfig`, `async def update(self, hostname, record_type, ip, config) -> UpdateResult`.
- Module helper `def _zone_matches(zone_name: str, hostname: str) -> bool` — True if `hostname == zone_name` or `hostname` endswith `'.' + zone_name` (label-boundary suffix match).

- [ ] **Step 1: Write the failing tests**

Create `test/unit/test_cloudflare.py`. Use a helper that builds a fake `aiohttp.ClientSession` whose `get`/`put` return context managers yielding responses with a mocked async `.json()`. Because `update()` makes up to three calls (GET /zones, GET /zones/{id}/dns_records, PUT), drive them with `side_effect` sequences.

```python
"""Tests for the Cloudflare provider."""
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

from pydantic import BaseModel, SecretStr

import pytest

from tether_ddns.providers.ddns_providers.cloudflare import (
    CloudflareProvider,
    _zone_matches,
)


def _cfg(proxied: bool = False, ttl: int = 1) -> BaseModel:
    return CloudflareProvider.ConfigModel(
        api_token=SecretStr('tok'), proxied=proxied, ttl=ttl)


def _json_cm(payload: dict[str, Any]) -> MagicMock:
    """Build an async context manager whose response.json() returns payload."""
    resp = MagicMock()
    resp.json = AsyncMock(return_value=payload)
    cm = MagicMock()
    cm.__aenter__ = AsyncMock(return_value=resp)
    cm.__aexit__ = AsyncMock(return_value=False)
    return cm


def _session(get_payloads: list[dict[str, Any]], put_payload: dict[str, Any]) -> MagicMock:
    session = MagicMock()
    session.get = MagicMock(side_effect=[_json_cm(p) for p in get_payloads])
    session.put = MagicMock(return_value=_json_cm(put_payload))
    return session


def _patch_session(session: MagicMock) -> Any:
    cs = patch('tether_ddns.providers.ddns_providers.cloudflare.aiohttp.ClientSession')
    mock = cs.start()
    mock.return_value.__aenter__ = AsyncMock(return_value=session)
    mock.return_value.__aexit__ = AsyncMock(return_value=False)
    return cs


def test_zone_matches_label_boundary() -> None:
    """Zone match is on a label boundary, not a bare substring."""
    assert _zone_matches('arjones.com', 'box.arjones.com') is True
    assert _zone_matches('arjones.com', 'arjones.com') is True
    assert _zone_matches('jones.com', 'box.arjones.com') is False


@pytest.mark.asyncio
async def test_update_success() -> None:
    """Zone + record resolve and the PUT succeeds."""
    session = _session(
        get_payloads=[
            {'result': [{'id': 'z1', 'name': 'arjones.com'}]},
            {'result': [{'id': 'r1', 'name': 'box.arjones.com'}]},
        ],
        put_payload={'success': True, 'result': {'id': 'r1'}, 'errors': []},
    )
    cs = _patch_session(session)
    try:
        result = await CloudflareProvider().update(
            'box.arjones.com', 'AAAA', '2001:db8::1', _cfg())
    finally:
        cs.stop()
    assert result.success is True
    assert result.ip == '2001:db8::1'
    # PUT body carried the right type/content/proxied/ttl
    _, kwargs = session.put.call_args
    assert kwargs['json']['type'] == 'AAAA'
    assert kwargs['json']['content'] == '2001:db8::1'


@pytest.mark.asyncio
async def test_update_zone_not_found() -> None:
    """No matching zone yields a failure result."""
    session = _session(get_payloads=[{'result': []}], put_payload={})
    cs = _patch_session(session)
    try:
        result = await CloudflareProvider().update(
            'box.arjones.com', 'A', '1.2.3.4', _cfg())
    finally:
        cs.stop()
    assert result.success is False
    assert 'zone' in result.message


@pytest.mark.asyncio
async def test_update_record_not_found() -> None:
    """Zone matched but no record yields a failure result."""
    session = _session(
        get_payloads=[
            {'result': [{'id': 'z1', 'name': 'arjones.com'}]},
            {'result': []},
        ],
        put_payload={},
    )
    cs = _patch_session(session)
    try:
        result = await CloudflareProvider().update(
            'box.arjones.com', 'A', '1.2.3.4', _cfg())
    finally:
        cs.stop()
    assert result.success is False
    assert 'not found' in result.message


@pytest.mark.asyncio
async def test_update_api_error() -> None:
    """A Cloudflare error response surfaces its messages."""
    session = _session(
        get_payloads=[
            {'result': [{'id': 'z1', 'name': 'arjones.com'}]},
            {'result': [{'id': 'r1', 'name': 'box.arjones.com'}]},
        ],
        put_payload={'success': False, 'errors': [{'message': 'bad token'}]},
    )
    cs = _patch_session(session)
    try:
        result = await CloudflareProvider().update(
            'box.arjones.com', 'A', '1.2.3.4', _cfg())
    finally:
        cs.stop()
    assert result.success is False
    assert 'bad token' in result.message
```

- [ ] **Step 2: Run to verify it fails**

Run: `python -m pytest test/unit/test_cloudflare.py -v`
Expected: FAIL (module not found).

- [ ] **Step 3: Write the provider**

Create `tether_ddns/providers/ddns_providers/cloudflare.py`:
```python
"""Cloudflare dynamic DNS provider."""
from __future__ import annotations

from typing import Any

import aiohttp

from pydantic import BaseModel, SecretStr

from tether_ddns.providers.base import (
    DDNSProvider,
    UpdateResult,
    register_provider,
)

_API = 'https://api.cloudflare.com/client/v4'


class CloudflareConfig(BaseModel):
    """Configuration for the Cloudflare provider."""

    api_token: SecretStr
    proxied: bool = False
    ttl: int = 1


def _zone_matches(zone_name: str, hostname: str) -> bool:
    """Return True if the zone is a label-boundary suffix of the hostname."""
    return hostname == zone_name or hostname.endswith('.' + zone_name)


def _result_list(payload: object) -> list[dict[str, Any]]:
    """Extract the Cloudflare 'result' list from a response payload."""
    if isinstance(payload, dict):
        result = payload.get('result')
        if isinstance(result, list):
            return [item for item in result if isinstance(item, dict)]
    return []


@register_provider
class CloudflareProvider(DDNSProvider):
    """Updates a Cloudflare DNS record, resolving zone and record by name."""

    key = 'cloudflare'
    display_name = 'Cloudflare'
    ConfigModel = CloudflareConfig

    async def update(
        self, hostname: str, record_type: str, ip: str, config: BaseModel,
    ) -> UpdateResult:
        """Resolve the zone and record for hostname and update it to ip."""
        assert isinstance(config, CloudflareConfig)
        headers = {
            'Authorization': f'Bearer {config.api_token.get_secret_value()}',
            'Content-Type': 'application/json',
        }
        async with aiohttp.ClientSession(headers=headers) as session:
            async with session.get(f'{_API}/zones') as resp:
                zones = _result_list(await resp.json())
            matches = [
                z for z in zones if _zone_matches(str(z.get('name', '')), hostname)]
            zone = max(matches, key=lambda z: len(str(z.get('name', ''))), default=None)
            if zone is None:
                return UpdateResult(
                    success=False, ip=ip,
                    message=f'no matching Cloudflare zone for {hostname}')
            zone_id = str(zone.get('id', ''))

            params = {'type': record_type, 'name': hostname}
            async with session.get(
                    f'{_API}/zones/{zone_id}/dns_records', params=params) as resp:
                records = _result_list(await resp.json())
            if not records:
                return UpdateResult(
                    success=False, ip=ip,
                    message=f'record {hostname} ({record_type}) not found')
            record_id = str(records[0].get('id', ''))

            body = {
                'type': record_type,
                'name': hostname,
                'content': ip,
                'proxied': config.proxied,
                'ttl': config.ttl,
            }
            async with session.put(
                    f'{_API}/zones/{zone_id}/dns_records/{record_id}', json=body) as resp:
                payload = await resp.json()

        if isinstance(payload, dict) and payload.get('success') is True:
            return UpdateResult(success=True, ip=ip, message='updated')
        errors = payload.get('errors', []) if isinstance(payload, dict) else []
        messages = '; '.join(
            str(e.get('message', '')) for e in errors if isinstance(e, dict))
        return UpdateResult(
            success=False, ip=ip, message=messages or 'Cloudflare update failed')
```

- [ ] **Step 4: Run to verify it passes**

Run: `python -m pytest test/unit/test_cloudflare.py -v` → PASS.
Then the whole suite: `python -m pytest test/ -q` → all pass, coverage ≥ 90.
Lint: `ruff check tether_ddns/providers/ddns_providers/cloudflare.py test/unit/test_cloudflare.py`, `flake8 ...`, `mypy tether_ddns/providers/ddns_providers/cloudflare.py`, `pyright tether_ddns/providers/ddns_providers/cloudflare.py`. Fix all violations.

- [ ] **Step 5: Commit**

```bash
git add tether_ddns/providers/ddns_providers/cloudflare.py test/unit/test_cloudflare.py
git commit -m "feat: Cloudflare DDNS provider with zone/record auto-resolution"
```

---

## Task 2: Verify registration + gates

**Files:** none new.

- [ ] **Step 1: Confirm auto-registration**

Run: `python -c "from tether_ddns.providers.base import load_providers, PROVIDER_REGISTRY; load_providers(); print('cloudflare' in PROVIDER_REGISTRY)"` → `True`.
Optionally confirm the API lists it: it will appear in `GET /api/providers` with its schema (no code change needed).

- [ ] **Step 2: Full gate**

Run: `source .venv/bin/activate && pytest test/ -q` → all pass, coverage ≥ 90, flake8/mypy/pyright/ruff linter tests green.

- [ ] **Step 3: Commit any fixes** (only if needed)

```bash
git add -A
git commit -m "chore: verify Cloudflare provider passes full gates"
```

---

## Self-Review Notes

- **Spec coverage:** config model with api_token/proxied/ttl (T1), zone auto-resolve via longest label-boundary suffix (`_zone_matches` + `next(...)`), record find by type+name with not-found failure, PUT with correct body, Cloudflare error-message surfacing, registration + gates (T2). All spec points mapped.
- **Type consistency:** `CloudflareConfig`, `_zone_matches`, `_result_list`, `UpdateResult` used consistently; `update()` matches the `DDNSProvider` signature (`hostname, record_type, ip, config: BaseModel`) exactly like DuckDNS.
- **Placeholders:** none — full provider + tests provided. No provider-level try/except (scheduler/api own isolation), matching the spec.
- **Note:** the zone pick uses `max(matches, key=len(name))`, so when multiple zones match (e.g. `arjones.com` and a delegated `sub.arjones.com`) the longest — most specific — zone wins.
