# Tether DDNS — Polish Follow-ups Design Spec

**Date:** 2026-07-10
**Status:** Approved

## Overview

Five focused follow-up fixes identified during the final whole-branch review of the
Tether DDNS app. None change the core architecture; each hardens correctness, safety,
or maintainability. Delivered on `feat/tether-ddns-polish`.

## Changes

### 1. WebSocket scheme + dead ref — `frontend/src/useLiveState.ts`
- The hook hardcodes `ws://${location.host}/api/ws`, which fails (blocked mixed-content)
  when the SPA is served over HTTPS.
- Fix: derive the scheme — `location.protocol === 'https:' ? 'wss:' : 'ws:'`.
- Remove the unused `wsRef` (assigned, never read).
- Vitest: assert the socket URL uses `wss:` when `location.protocol` is `https:`, and
  `ws:` otherwise.

### 2. Strict settings validation — `tether_ddns/api.py` `PUT /api/settings`
- Current handler builds `AppSettings(**{**current, **payload})` from a raw
  `dict[str, Any]`: a wrong-typed value raises an unhandled 500, and unknown keys are
  silently dropped.
- Fix: accept a dedicated `SettingsUpdate` pydantic model — every `AppSettings` field
  as optional, `model_config = ConfigDict(extra='forbid')`. FastAPI then returns 422 on
  both bad types and unknown keys. Apply only explicitly-set fields
  (`model_dump(exclude_unset=True)`) onto the current settings, persist, return the
  updated settings dump.
- Tests: valid partial update round-trips; bad type → 422; unknown key → 422.

### 3. Forced sync detects IP first — `tether_ddns/api.py` `POST /api/domains/{id}/sync`
- Current handler passes `runtime.public_ip or ''` — a forced sync before the first IP
  detection sends an empty `ip` to the provider.
- Fix: if `runtime.public_ip` is falsy, run `detect_public_ip(config.settings.ip_source)`.
  On success, update runtime (`set_public_ip`) and use the detected IP; on failure,
  return `HTTPException(503, detail='public IP unknown')`. Then call `sync_domain`.
- Tests: sync with a known public IP still works; sync with no IP triggers detection
  (mocked) then syncs; detection failure → 503.

### 4. Provider `EmptyConfig` default — `tether_ddns/providers/base.py`
- The base defaults `ConfigModel = BaseModel`; the hook base uses an explicit
  `EmptyConfig(BaseModel)`. A provider omitting a config model would validate against
  bare `BaseModel` (silently dropping any config).
- Fix: add `EmptyConfig(BaseModel)` in the providers module and default
  `ConfigModel = EmptyConfig`, mirroring hooks. Behavior-preserving — DuckDNS overrides
  it; the shipped provider registry tests stay green.

### 5. Non-deprecated aiodns call — `tether_ddns/reachability.py`
- `_query_one` calls `resolver.query(host, 'A')`, deprecated in aiodns 4.x
  ("query() is deprecated, use query_dns() instead").
- Fix: call `resolver.query_dns(host, 'A')` (same `(host, qtype)` signature, verified
  against aiodns 4.0.4). Keep the `asyncio.wait_for` timeout wrapper and the three-tier
  exception handling (TimeoutError / aiodns.error.DNSError / generic). Existing quorum
  tests patch `_query_one`, so they remain valid; add/keep a focused test if useful.

## Testing & gates

All changes must keep the existing gates green:
- Backend: `pytest test/` passes, coverage ≥ 90 (`--cov-fail-under=90`), and the
  flake8 / mypy / pyright-strict / ruff linter gate tests pass.
- Frontend: `tsc --noEmit` clean, Vitest + coverage thresholds pass, Playwright e2e
  (both tests) pass with the live WebSocket working.

## Out of scope

- No new features, endpoints, or UI surfaces.
- `retry_on_failure` and `update_on_startup` are already implemented; untouched here.
