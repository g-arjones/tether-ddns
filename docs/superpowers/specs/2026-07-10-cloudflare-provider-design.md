# Cloudflare DDNS Provider — Design Spec

**Date:** 2026-07-10
**Status:** Approved

## Overview

Add a Cloudflare DDNS provider plugin, ported from a reference Ruby script. It follows
the existing provider plugin pattern (subclass `DDNSProvider`, `@register_provider`,
auto-loaded from `providers/ddns_providers/`), so it requires no other wiring and appears
in the provider dropdown automatically. Delivered on `feat/cloudflare-provider`.

## Configuration model (`CloudflareConfig`)

Rendered as the provider form via the config JSON schema:
- `api_token: SecretStr` — a scoped Cloudflare API token (Zone:Read + DNS:Edit). Password
  field (write-only/masked, per existing secret handling).
- `proxied: bool = False` — whether the record is proxied through Cloudflare.
- `ttl: int = 1` — Cloudflare TTL; `1` means automatic.

No zone id or record id — the provider auto-resolves both.

## `update(hostname, record_type, ip, config)` behavior

Base URL `https://api.cloudflare.com/client/v4`, header `Authorization: Bearer <token>`,
`Content-Type: application/json`. Uses a single `aiohttp.ClientSession` for the calls.

1. **Resolve zone:** `GET /zones`. From the returned zones, pick the one whose `name` is
   the longest suffix of `hostname` matching on a label boundary (so `box.arjones.com`
   resolves to zone `arjones.com`, and `arjones.com` itself also matches). If none match,
   return `UpdateResult(success=False, ip=ip, message='no matching Cloudflare zone for <hostname>')`.
2. **Find record:** `GET /zones/{zone_id}/dns_records?type={record_type}&name={hostname}`.
   `record_type` is the domain's type (A→the IPv4 passed in, AAAA→IPv6). If the result list
   is empty, return `UpdateResult(success=False, ip=ip, message='record <hostname> (<type>) not found')`.
   Do **not** create the record.
3. **Update:** `PUT /zones/{zone_id}/dns_records/{record_id}` with JSON body
   `{type: record_type, name: hostname, content: ip, proxied: config.proxied, ttl: config.ttl}`.
   Parse the Cloudflare response JSON: on `success == true` →
   `UpdateResult(success=True, ip=ip, message='updated')`; otherwise join
   `errors[].message` into the message → `UpdateResult(success=False, ip=ip, message=...)`.

**Error handling:** the provider returns a failure `UpdateResult` for any non-success API
response or missing zone/record. It does not need its own try/except — the scheduler and
`POST /api/domains/{id}/sync` already wrap provider calls with exception isolation. HTTP
errors that raise are caught there and surface as the domain's `error` status.

**Dual-stack:** because `record_type`/`ip` are passed in, an `A` domain updates with the
detected IPv4 and an `AAAA` domain with the detected IPv6 automatically.

## Registration

`@register_provider` with `key = 'cloudflare'`, `display_name = 'Cloudflare'`,
`ConfigModel = CloudflareConfig`. Auto-loaded; no changes to app/api/scheduler.

## Testing

`test/unit/test_cloudflare.py` with mocked aiohttp (mirroring `test_duckdns.py` style):
- success: zone matched → record found → PUT `success:true`.
- zone not found → failure with the zone message.
- record not found → failure with the record message.
- Cloudflare error response (`success:false` with `errors`) → failure carrying the messages.
- longest-suffix zone selection (e.g. `box.arjones.com` picks `arjones.com`, not a partial
  string match like `jones.com`).

Keeps strict gates green (flake8, mypy, pyright strict, ruff) and backend coverage ≥ 90.

## Out of scope

- Auto-creating missing records.
- Caching zone/record ids between calls (each `update()` resolves fresh; acceptable for the
  sync cadence).
- Cloudflare pagination beyond the default page (zone/record counts for a home user fit one
  page; can be added later if needed).
