# Remove Generic Domain TTL — Design Spec

**Date:** 2026-07-10
**Status:** Approved

## Overview

The Add/Edit Domain modal renders a fixed generic "TTL (seconds)" `<select>` bound to
`DomainConfig.ttl`. The Cloudflare provider *also* exposes a `ttl` field in its config
schema, which the schema-driven form renders as a second "Ttl" input — so selecting
Cloudflare shows two TTL fields. Moreover, the generic `DomainConfig.ttl` is **dead**: it is
stored but never passed to any provider's `update()` (DuckDNS ignores TTL; Cloudflare uses
its own `ttl`). Per the chosen direction, we **drop the generic TTL entirely and let each
provider own its TTL** in its own config schema. Delivered on `fix/duplicate-ttl`.

## Change

Remove the generic domain-level TTL from both ends. Providers that need a TTL declare it in
their own `ConfigModel` (Cloudflare already does; DuckDNS has none).

**Backend:**
- `tether_ddns/config.py`: remove `ttl` from `DomainConfig`.
- `tether_ddns/api.py`: remove `ttl` from `DomainInput`.
- Cloudflare's `ttl` is untouched (it remains in `CloudflareConfig` and the apply payload).
- Old config files that still contain a domain `ttl` key are ignored on load (pydantic
  default `extra='ignore'`), so this is backward-compatible.

**Frontend:**
- `frontend/src/types.ts`: remove `ttl` from the `DomainConfig` interface.
- `frontend/src/components/DomainModal.tsx`: remove the TTL `<select>`, the `ttl` field from
  `DomainFormValue`, the `EMPTY` default, and the edit-prefill/`onSave` handling of it.
- `frontend/src/components/DomainCard.tsx`: remove the `· TTL {domain.ttl}` from the card meta.

## Testing

- Backend: update `test/unit/test_api.py` / any config test that references domain `ttl`
  (create/update payloads and assertions) to drop it. The Cloudflare provider tests are
  unaffected.
- Frontend: update `DomainModal.test.tsx` and `DomainCard.test.tsx` to remove `ttl` from the
  domain fixtures and any TTL assertions.
- Keeps strict gates green (flake8, mypy, pyright strict, ruff), backend coverage ≥ 90,
  frontend `tsc`/Vitest/coverage, and Playwright e2e.

## Out of scope

- Adding a TTL to DuckDNS (it has no TTL concept in its simple update API).
- Changing how Cloudflare's `ttl` works (already provider-owned and functional).
- Migrating/rewriting existing on-disk config files (the stale key is simply ignored).
