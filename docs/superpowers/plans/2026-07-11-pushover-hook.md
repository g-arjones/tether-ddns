# Pushover Hook Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `pushover` hook that implements all three domain-update events, sending a descriptive Pushover notification per event (error at high priority).

**Architecture:** A single self-contained module `tether_ddns/hooks/registered_hooks/pushover.py`, auto-discovered by `load_hooks()`. Config is `token` + `user` (both `SecretStr`, auto-masked by existing config handling). The hook overrides the three `on_domain_update_*` methods, so `supported_events()` and `/api/hooks` pick them up automatically. Each method POSTs form-encoded data to the Pushover Messages API; a non-200 or `status != 1` raises `RuntimeError` (the scheduler dispatcher isolates and logs it).

**Tech Stack:** Python 3, Pydantic v2 (`SecretStr`), aiohttp, pytest, pytest-asyncio.

## Global Constraints

**Depends on the domain-update hook events feature (already implemented):** `tether_ddns/hooks/base.py` exports `Hook`, `register_hook`, `DomainUpdatePendingEvent(domain_id, hostname, record_type, family, current_ip)`, `DomainUpdateSuccessEvent(domain_id, hostname, record_type, family, ip)`, `DomainUpdateErrorEvent(domain_id, hostname, record_type, family, ip, message)`.

- Config fields: `token: SecretStr`, `user: SecretStr` (via `Annotated[..., labeled_field(...)]`).
- API endpoint: `https://api.pushover.net/1/messages.json`, POST, form-encoded body.
- Priority: success `0`, pending `0`, error `1`.
- On HTTP status != 200 or JSON `status != 1`, raise `RuntimeError`; the raised message must NOT contain the token or user key.
- Secrets read via `.get_secret_value()`.
- Python style: `from __future__ import annotations`, single-quoted strings, existing conventions.
- Run `pytest test/unit -q` before each commit.

---

### Task 1: Pushover hook module and tests

**Files:**
- Create: `tether_ddns/hooks/registered_hooks/pushover.py`
- Create: `test/unit/test_pushover.py`

**Interfaces:**
- Consumes: `Hook`, `register_hook`, `DomainUpdatePendingEvent`, `DomainUpdateSuccessEvent`, `DomainUpdateErrorEvent` from `tether_ddns.hooks.base`; `labeled_field` from `tether_ddns.schema_fields`.
- Produces: `PushoverConfig(token: SecretStr, user: SecretStr)`, `PushoverHook` (key `'pushover'`), module constant `API_URL`.

- [ ] **Step 1: Write the failing tests**

Create `test/unit/test_pushover.py`:
```python
"""Tests for the Pushover hook."""
from unittest.mock import AsyncMock, MagicMock, patch

from pydantic import SecretStr

import pytest

from tether_ddns.hooks.base import (
    DomainUpdateErrorEvent,
    DomainUpdatePendingEvent,
    DomainUpdateSuccessEvent,
)
from tether_ddns.hooks.registered_hooks.pushover import (
    PushoverConfig,
    PushoverHook,
)


def _cfg() -> PushoverConfig:
    return PushoverConfig(token=SecretStr('tok123'), user=SecretStr('usr456'))


def _session_returning(status: int, body: dict[str, object]) -> MagicMock:
    resp = MagicMock()
    resp.status = status
    resp.json = AsyncMock(return_value=body)
    session = MagicMock()
    session.post.return_value.__aenter__ = AsyncMock(return_value=resp)
    session.post.return_value.__aexit__ = AsyncMock(return_value=False)
    return session


def _patch_session(session: MagicMock) -> object:
    cs = patch(
        'tether_ddns.hooks.registered_hooks.pushover.aiohttp.ClientSession')
    mock = cs.start()
    mock.return_value.__aenter__ = AsyncMock(return_value=session)
    mock.return_value.__aexit__ = AsyncMock(return_value=False)
    return cs


def test_supported_events() -> None:
    """The hook supports exactly the three domain-update events."""
    assert set(PushoverHook.supported_events()) == {
        'domain_update_pending', 'domain_update_success',
        'domain_update_error'}


@pytest.mark.asyncio
async def test_success_posts_message() -> None:
    """A success event posts a normal-priority message with token/user."""
    session = _session_returning(200, {'status': 1})
    cs = _patch_session(session)
    try:
        await PushoverHook().on_domain_update_success(
            DomainUpdateSuccessEvent(
                domain_id='a', hostname='home.example.com',
                record_type='A', family='ipv4', ip='1.2.3.4'),
            _cfg())
    finally:
        cs.stop()
    call = session.post.call_args
    assert call.args[0] == 'https://api.pushover.net/1/messages.json'
    data = call.kwargs['data']
    assert data['token'] == 'tok123'
    assert data['user'] == 'usr456'
    assert data['title'] == 'home.example.com'
    assert data['message'] == 'Updated home.example.com A -> 1.2.3.4'
    assert data['priority'] == 0


@pytest.mark.asyncio
async def test_pending_posts_message() -> None:
    """A pending event posts a normal-priority staleness message."""
    session = _session_returning(200, {'status': 1})
    cs = _patch_session(session)
    try:
        await PushoverHook().on_domain_update_pending(
            DomainUpdatePendingEvent(
                domain_id='a', hostname='home.example.com',
                record_type='AAAA', family='ipv6', current_ip='2001:db8::9'),
            _cfg())
    finally:
        cs.stop()
    data = session.post.call_args.kwargs['data']
    assert data['message'] == (
        'home.example.com AAAA is stale (current IP 2001:db8::9)')
    assert data['priority'] == 0


@pytest.mark.asyncio
async def test_error_posts_high_priority() -> None:
    """An error event posts a high-priority failure message."""
    session = _session_returning(200, {'status': 1})
    cs = _patch_session(session)
    try:
        await PushoverHook().on_domain_update_error(
            DomainUpdateErrorEvent(
                domain_id='a', hostname='home.example.com',
                record_type='A', family='ipv4', ip='1.2.3.4',
                message='provider down'),
            _cfg())
    finally:
        cs.stop()
    data = session.post.call_args.kwargs['data']
    assert data['message'] == (
        'Failed to update home.example.com A: provider down')
    assert data['priority'] == 1


@pytest.mark.asyncio
async def test_api_error_raises_without_secrets() -> None:
    """A status!=1 response raises and does not leak token or user."""
    session = _session_returning(
        400, {'status': 0, 'errors': ['user identifier is invalid']})
    cs = _patch_session(session)
    try:
        with pytest.raises(RuntimeError) as exc:
            await PushoverHook().on_domain_update_success(
                DomainUpdateSuccessEvent(
                    domain_id='a', hostname='home.example.com',
                    record_type='A', family='ipv4', ip='1.2.3.4'),
                _cfg())
    finally:
        cs.stop()
    text = str(exc.value)
    assert 'user identifier is invalid' in text
    assert 'tok123' not in text
    assert 'usr456' not in text


@pytest.mark.asyncio
async def test_non_200_raises() -> None:
    """A non-200 HTTP status raises even when body status is 1."""
    session = _session_returning(500, {'status': 1})
    cs = _patch_session(session)
    try:
        with pytest.raises(RuntimeError):
            await PushoverHook().on_domain_update_success(
                DomainUpdateSuccessEvent(
                    domain_id='a', hostname='home.example.com',
                    record_type='A', family='ipv4', ip='1.2.3.4'),
                _cfg())
    finally:
        cs.stop()
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest test/unit/test_pushover.py -q`
Expected: FAIL (`ModuleNotFoundError: tether_ddns.hooks.registered_hooks.pushover`).

- [ ] **Step 3: Create the hook module**

Create `tether_ddns/hooks/registered_hooks/pushover.py`:
```python
"""Hook that sends Pushover notifications for domain-update events."""
from __future__ import annotations

from typing import Annotated

import aiohttp

from pydantic import BaseModel, SecretStr

from tether_ddns.hooks.base import (
    DomainUpdateErrorEvent,
    DomainUpdatePendingEvent,
    DomainUpdateSuccessEvent,
    Hook,
    register_hook,
)
from tether_ddns.schema_fields import labeled_field

API_URL = 'https://api.pushover.net/1/messages.json'


class PushoverConfig(BaseModel):
    """Configuration for the Pushover hook."""

    token: Annotated[SecretStr, labeled_field(title='API Token')]
    user: Annotated[SecretStr, labeled_field(title='User Key')]


@register_hook
class PushoverHook(Hook):
    """Sends Pushover notifications for domain-update events."""

    key = 'pushover'
    display_name = 'Pushover'
    ConfigModel = PushoverConfig

    async def on_domain_update_success(
            self, event: DomainUpdateSuccessEvent, config: BaseModel) -> None:
        """Send a success notification."""
        assert isinstance(config, PushoverConfig)
        await self._send(
            config, event.hostname,
            f'Updated {event.hostname} {event.record_type} -> {event.ip}', 0)

    async def on_domain_update_pending(
            self, event: DomainUpdatePendingEvent, config: BaseModel) -> None:
        """Send a staleness notification."""
        assert isinstance(config, PushoverConfig)
        await self._send(
            config, event.hostname,
            f'{event.hostname} {event.record_type} is stale '
            f'(current IP {event.current_ip})', 0)

    async def on_domain_update_error(
            self, event: DomainUpdateErrorEvent, config: BaseModel) -> None:
        """Send a high-priority failure notification."""
        assert isinstance(config, PushoverConfig)
        await self._send(
            config, event.hostname,
            f'Failed to update {event.hostname} {event.record_type}: '
            f'{event.message}', 1)

    async def _send(
            self, config: PushoverConfig, title: str, message: str,
            priority: int) -> None:
        """POST a message to the Pushover API, raising on failure."""
        data = {
            'token': config.token.get_secret_value(),
            'user': config.user.get_secret_value(),
            'title': title,
            'message': message,
            'priority': priority,
        }
        async with aiohttp.ClientSession() as session:
            async with session.post(API_URL, data=data) as resp:
                status = resp.status
                body = await resp.json()
        if status != 200 or body.get('status') != 1:
            raise RuntimeError(
                f'Pushover API error (HTTP {status}): '
                f'{body.get("errors", body.get("status"))}')
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest test/unit/test_pushover.py -q`
Expected: PASS (6 tests).

- [ ] **Step 5: Run the full unit suite**

Run: `pytest test/unit -q`
Expected: PASS (the new hook auto-registers; no existing test asserts a fixed hook count, but if one does, update it to include `'pushover'`).

- [ ] **Step 6: Commit**

```bash
git add tether_ddns/hooks/registered_hooks/pushover.py test/unit/test_pushover.py
git commit -m "feat(hooks): add Pushover hook for domain-update events"
```

---

### Task 2: README and static checks

**Files:**
- Modify: `README.md`
- Verify: `tether_ddns/`, `test/`.

- [ ] **Step 1: Update the README hooks line**

Replace:
```markdown
- Pluggable **DDNS providers** (DuckDNS and Cloudflare included), **hooks**
  (log and ZTE router-firewall hooks included), and **IP sources** (ipify /
  icanhazip included).
```
with:
```markdown
- Pluggable **DDNS providers** (DuckDNS and Cloudflare included), **hooks**
  (log, ZTE router-firewall, and Pushover hooks included), and **IP sources**
  (ipify / icanhazip included).
```

- [ ] **Step 2: Run the lint/type gate**

Run: `pytest test/test_ruff.py test/test_mypy.py test/test_pyright.py test/test_flake8.py -q`
Expected: PASS. Fix any findings inline (e.g. a `# type: ignore` for `body.get` on an untyped JSON dict, or import ordering) and re-run.

- [ ] **Step 3: Run the full suite once more**

Run: `pytest test/unit -q`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "docs: list Pushover hook in README"
```

---

## Self-Review

- **Spec coverage:** module + config (`token`/`user` SecretStr) + three `on_domain_update_*` methods + `_send` with raise-on-failure + `API_URL` (Task 1) ✓; per-event messages and priorities (Task 1 tests assert exact strings and 0/0/1) ✓; secret-safe error message (Task 1 `test_api_error_raises_without_secrets`) ✓; `supported_events()` inference (Task 1) ✓; README + lint gate (Task 2) ✓.
- **Placeholder scan:** every code step shows complete code; no TBD/TODO.
- **Type consistency:** `PushoverConfig(token, user)`, `PushoverHook` key `'pushover'`, `API_URL`, `_send(config, title, message, priority)`, and the three event payload field names match `base.py`.
