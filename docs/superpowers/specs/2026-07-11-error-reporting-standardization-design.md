# Error Reporting Standardization — Design

**Date:** 2026-07-11
**Status:** Approved

## Problem

Entity failures are hard to see and inconsistently modeled:

1. **Invisible in the UI.** `LogRingHandler.emit` stores only
   `record.getMessage()`, dropping `exc_info`. When the scheduler logs
   `_log.exception('Hook %s failed on %s', ...)`, the UI log viewer shows only
   the static prefix — the real exception message and traceback reach stdout
   only. Operators see "Hook X failed" with no cause.
2. **Inconsistent contracts.** DNS providers return a structured
   `UpdateResult(success, ip, message)`; IP sources return `str | None` (None on
   failure); hooks raise. The router-firewall hook logs `warning` and silently
   returns `None` on genuine failures (missing key/salt, rule not found, apply
   rejected), so a domain's firewall rule can silently never update.

## Goal

Make failures visible and standardize entity error handling on one rule:
**success returns data, failure raises.** The scheduler/detect layer catches
**all** exceptions and logs a clear, operator-facing message that now reaches
the UI.

## Decisions

- **Visibility:** the ring buffer appends the exception **type + message**
  (one line) to a record's message when `exc_info` is present. Full traceback
  still goes to stdout. No frontend change (the UI already renders `message`).
- **Shared exception:** a new `TetherError(Exception)` for expected,
  operator-facing failures with clean messages. Catch sites use broad
  `except Exception` and always log the message — `TetherError` is a
  convenience for clean text, **not** a filter.
- **Providers:** `update()` returns the assigned IP (`str`) on success; raises
  on failure. `UpdateResult` is removed.
- **IP sources:** `detect()` returns `str` on success; raises on failure.
  `detect_public_ip` catches, logs at **DEBUG**, and returns `None` (scheduler
  still skips that family). This keeps single-stack hosts quiet.
- **Router-firewall hook:** convert silent `warning`+`return None` to
  `raise TetherError(...)`; keep the family-mismatch guard a silent skip.
- **Hooks generally:** already raise; unchanged.

## Design

### 1. Ring-buffer visibility (`tether_ddns/logging_setup.py`)

In `LogRingHandler.emit`, fold exception detail into the stored message:

```python
message = record.getMessage()
if record.exc_info and record.exc_info[1] is not None:
    exc = record.exc_info[1]
    message = f'{message}: {type(exc).__name__}: {exc}'
entry: LogRecordDict = {
    'time': record.created,
    'level': record.levelname,
    'logger': record.name,
    'message': message,
}
```

The stdout `StreamHandler` keeps its full-traceback formatting. The UI log
viewer renders `message`, so the cause now appears there with no frontend
change.

### 2. Shared exception (`tether_ddns/errors.py`, new)

```python
"""Shared error types."""
from __future__ import annotations


class TetherError(Exception):
    """An expected, operator-facing failure with a clean message."""
```

### 3. DNS providers (`providers/base.py`, `duckdns.py`, `cloudflare.py`)

- Remove `UpdateResult` from `providers/base.py`. `DDNSProvider.update`'s
  return type becomes `str` (the assigned IP):

```python
@abstractmethod
async def update(
    self, hostname: str, record_type: str, ip: str, config: BaseModel,
) -> str:
    """Update the DNS record and return the assigned IP; raise on failure."""
```

- **DuckDNS:** on a non-`'OK'` body, `raise TetherError(f'DuckDNS returned
  {body}')`; on success return `ip`.
- **Cloudflare:** each current `UpdateResult(success=False, ...)` becomes
  `raise TetherError(<same message>)` (no zone, record not found, update
  failed); success returns `ip`.

### 4. `sync_domain` (`tether_ddns/scheduler.py`)

```python
async def sync_domain(domain: DomainConfig, ip: str, state: RuntimeState) -> Status:
    provider_cls = PROVIDER_REGISTRY.get(domain.provider)
    if provider_cls is None:
        state.set_status(domain.id, 'error', message=f'Unknown provider {domain.provider}')
        return 'error'
    state.set_status(domain.id, 'updating')
    try:
        config = provider_cls.ConfigModel.model_validate(domain.provider_config)
        assigned = await provider_cls().update(
            domain.hostname, domain.record_type, ip, config)
    except Exception as exc:  # noqa: BLE001 - provider errors must be contained
        _log.exception('Provider %s failed for %s', domain.provider, domain.hostname)
        state.set_status(domain.id, 'error', message=str(exc))
        return 'error'
    state.set_status(domain.id, 'synced', ip=assigned or ip, message='')
    return 'synced'
```

The `_log.exception` now carries the cause into the UI (Section 1); the domain's
status message is `str(exc)`.

### 5. IP sources (`ip_sources/base.py`, `registered_sources/http_sources.py`)

- `IPSource.detect` return type becomes `str` (raise on failure).
- `_fetch` calls `resp.raise_for_status()` so an HTTP error actually raises.
- `detect_public_ip` logs at DEBUG and still returns `None`:

```python
async def detect_public_ip(source_key: str, family: 'IPFamily') -> str | None:
    cls = IP_SOURCE_REGISTRY.get(source_key)
    if cls is None:
        _log.warning('Unknown IP source %s', source_key)
        return None
    try:
        return await cls().detect(family)
    except Exception:  # noqa: BLE001 - detection failure must not raise
        _log.debug('IP source %s failed for %s', source_key, family, exc_info=True)
        return None
```

(A single-stack host's per-cycle IPv6 failure is DEBUG noise, not an error.)

### 6. Router-firewall hook (`hooks/registered_hooks/router_firewall.py`)

Convert silent exits to raises; keep the family-mismatch skip; make logout
robust via `finally`:

```python
async def on_ip_changed(self, event, config):
    assert isinstance(config, RouterFirewallConfig)
    ip = event.new_ip
    if event.family != config.ip_version:
        return  # legitimate skip: event does not apply to this rule
    base = config.router_url.rstrip('/')
    headers = {**self._XHR_HEADERS, 'Referer': f'{base}/'}
    connector = aiohttp.TCPConnector(ssl=config.verify_tls)
    jar = aiohttp.CookieJar(unsafe=True)
    async with aiohttp.ClientSession(connector=connector, cookie_jar=jar) as session:
        public_key = await self._login(session, base, headers, config)
        try:
            token = await self._prepare_ipfilter(session, base, headers, config)
            await self._apply(session, base, headers, config, ip, token, public_key)
        finally:
            await self._logout(session, base, headers)
```

- `_login` returns `tuple[int, int]`; raises `TetherError('Router firewall:
  could not obtain public key')` / `'... login salt'`.
- `_prepare_ipfilter` returns `str`; raises `TetherError('Router firewall: rule
  <name> or token not found')`.
- `_apply` on non-200 or `SessionTimeout` raises `TetherError('Router firewall:
  apply failed (<status>): <result[:200]>')`; keeps the success `_log.info`.
- `_logout` stays best-effort (unchanged body); running it in `finally`
  releases the router's single admin session even when a step raises.

### 7. Scheduler catch sites

Unchanged in structure — broad `except Exception` + `_log.exception(...)`. With
Section 1, `exc_info` is now captured into the UI log. `_dispatch` (hooks) and
`sync_domain` (providers) already identify the failing entity in their message.

## Testing

- **logging_setup:** a record logged via `logger.exception(...)` inside an
  `except` yields a ring-buffer message containing the exception type and text;
  a plain `info` record is unchanged.
- **errors:** `TetherError` is an `Exception` subclass carrying its message.
- **providers:** DuckDNS/Cloudflare success returns the IP; each failure path
  raises `TetherError` with the expected message. Update existing tests that
  asserted `UpdateResult`.
- **sync_domain:** a raising provider leaves the domain `error` with the
  exception text as the status message and logs it.
- **ip sources:** `detect_public_ip` returns the IP on success; on a raising
  source it returns `None` and logs at DEBUG (assert via `caplog`).
- **router-firewall:** `test_handle_rule_not_found_does_not_apply` and
  `test_handle_aborts_without_salt` now assert `pytest.raises(TetherError)` and
  that `_logout` still ran (session released); `_apply` failure raises.

### Callers of `UpdateResult` to migrate

Removing `UpdateResult` touches these files, all of which construct or assert it
and must switch to a returned `str` / a raised `TetherError`:

- `test/unit/test_duckdns.py` — `result.success`/`result.ip` assertions become
  "returns the IP" / "raises `TetherError`".
- `test/unit/test_provider_registry.py` — the two stub providers'
  `update() -> UpdateResult` become `-> str` returning `ip`.
- `test/unit/test_scheduler.py` — `_ok_result` helper and the `AsyncMock(
  return_value=UpdateResult(...))` patches return the IP string instead; add a
  raising-provider case for the error path.
- `test/unit/test_api.py` — the `/sync` tests' `AsyncMock(return_value=
  UpdateResult(...))` return the IP string.
- `test/unit/test_pushover.py` — none (unrelated), but the manual-sync guard
  test in `test_api.py` also patches provider `update`; return the IP string.

## Non-goals

- No change to the UI log viewer or WebSocket schema.
- No change to the persisted config format.
- The separate "editing/enabling a Synced domain doesn't re-push until the IP
  changes" bug is out of scope (its own follow-up).
