# Pushover Hook — Design

**Date:** 2026-07-11
**Status:** Approved

**Depends on:** `2026-07-11-domain-update-hook-events-design.md` (the
`domain_update_pending` / `_success` / `_error` events and their payloads).

## Problem

Operators want push notifications on their phone when a domain's DNS record
becomes stale, is updated, or fails to update. Pushover is a simple, popular
push-notification service well suited to a homelab audience.

## Goal

Add a `pushover` hook that implements all three domain-update events, sending a
descriptive notification per event via the Pushover Messages API.

## Decisions

- **Config:** `token` and `user`, both `SecretStr` (auto-masked by existing
  config secret handling; no `api.py` change).
- **Messages:** title = hostname; descriptive per-event message body.
- **Priority:** error uses Pushover high priority (`1`); pending and success use
  normal priority (`0`). Priority is derived from the event, not configured.
- **Failure handling:** on a non-200 HTTP status or a JSON `status != 1`, the
  hook **raises** `RuntimeError`; the scheduler's `_dispatch` already isolates
  and logs hook exceptions via `_log.exception`. No retry (per Pushover
  guidance that repeating an invalid request will not help).
- Secrets never appear in exception messages (only the API `errors`/status).

## Design

### Module

New file `tether_ddns/hooks/registered_hooks/pushover.py`, auto-discovered by
`load_hooks()` because it lives under `registered_hooks/`.

### Config model

```python
from typing import Annotated
from pydantic import BaseModel, SecretStr
from tether_ddns.schema_fields import labeled_field


class PushoverConfig(BaseModel):
    """Configuration for the Pushover hook."""

    token: Annotated[SecretStr, labeled_field(title='API Token')]
    user: Annotated[SecretStr, labeled_field(title='User Key')]
```

Both fields serialize to JSON schema `format: 'password'`, so the existing
`mask_secrets`/`merge_secrets` machinery masks them in `/api/hooks-config`
responses and preserves them on edit.

### Hook

```python
API_URL = 'https://api.pushover.net/1/messages.json'


@register_hook
class PushoverHook(Hook):
    """Sends Pushover notifications for domain-update events."""

    key = 'pushover'
    display_name = 'Pushover'
    ConfigModel = PushoverConfig

    async def on_domain_update_success(
            self, event: DomainUpdateSuccessEvent, config: BaseModel) -> None:
        assert isinstance(config, PushoverConfig)
        await self._send(
            config, event.hostname,
            f'Updated {event.hostname} {event.record_type} -> {event.ip}', 0)

    async def on_domain_update_pending(
            self, event: DomainUpdatePendingEvent, config: BaseModel) -> None:
        assert isinstance(config, PushoverConfig)
        await self._send(
            config, event.hostname,
            f'{event.hostname} {event.record_type} is stale '
            f'(current IP {event.current_ip})', 0)

    async def on_domain_update_error(
            self, event: DomainUpdateErrorEvent, config: BaseModel) -> None:
        assert isinstance(config, PushoverConfig)
        await self._send(
            config, event.hostname,
            f'Failed to update {event.hostname} {event.record_type}: '
            f'{event.message}', 1)

    async def _send(
            self, config: PushoverConfig, title: str, message: str,
            priority: int) -> None:
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

Because the hook overrides exactly the three `on_domain_update_*` methods,
`PushoverHook.supported_events()` reports exactly those three keys, and
`/api/hooks` surfaces them automatically. `aiohttp` is already a dependency.

### Per-event notifications (title = hostname)

| Event | Message | Priority |
|-------|---------|----------|
| success | `Updated <hostname> <record_type> -> <ip>` | 0 |
| pending | `<hostname> <record_type> is stale (current IP <current_ip>)` | 0 |
| error | `Failed to update <hostname> <record_type>: <message>` | 1 |

## Testing

New `test/unit/test_pushover.py`, mirroring the DuckDNS aiohttp mock pattern:

- Each `on_domain_update_*` method POSTs to `API_URL` with `token`/`user` from
  config and the expected `title`, `message`, and `priority` (success/pending
  `0`, error `1`).
- A response with HTTP 200 and `{'status': 1}` succeeds silently.
- A response with `{'status': 0, 'errors': [...]}` (or a non-200 status) raises
  `RuntimeError`, and the raised message does not contain the token or user key.
- `PushoverHook.supported_events()` == the three `domain_update_*` keys.

## Docs

Add Pushover to the README hooks feature line (alongside the log and
ZTE router-firewall hooks).

## Non-goals

- No configurable device, sound, or priority overrides.
- No emergency-priority (2) retries/receipts.
- No attachments or HTML formatting.
