# Schema-Driven Enum Selects + Router Hook Field Types — Design Spec

**Date:** 2026-07-10
**Status:** Approved

## Overview

Two grouped improvements to how config forms render, motivated by the Router Firewall hook
form showing plain text inputs where dropdowns/toggles belong:

1. **App-wide:** `SchemaForm` renders any JSON-schema `enum` field as a `<select>` (instead of
   a text input). This fixes the router hook's IP Version and Protocol, and the Cloudflare
   provider (and any future plugin) gets enum dropdowns for free.
2. **Router hook:** convert `filter_target` to a boolean toggle, and turn `ingress_view` /
   `egress_view` into friendly `LAN/Internet/DS-Lite` enums mapped to the router's internal
   codes.

Delivered on `feat/schemaform-enums-router-fields`. (Dest IP is intentionally absent from the
form — the hook always sets the rule's destination to the detected public IP; only the prefix
is configurable.)

## Confirmed router values (read live from the F6600P)

- `INCViewName` / `OUTCViewName` options: LAN=`DEV.IP.IF1`, Internet=`DEV.IP.IF4`,
  DS-Lite=`DEV.IP.IF8`.
- `IPVersion`: Any=`-1`, IPv4=`4`, IPv6=`6` (the hook keeps ipv4/ipv6 only; "Any" is not
  meaningful for IP-change tracking).

## Part 1 — SchemaForm enum rendering (`frontend/src/components/SchemaForm.tsx`)

- Extend `SchemaProperty` with `enum?: (string | number)[]`.
- In the render map, when `prop.enum` is present (and it's not a boolean), render a `<select>`
  with one `<option>` per enum value, labelled by a humanized version of the value
  (e.g. `tcp_udp` → `TCP UDP`, `ipv6` → `Ipv6`; keep it simple — title-case words split on
  `_`). The option `value` is the raw enum value; on change, emit the raw value (coerce to
  number if all enum values are numbers). Keep the current field label (`title ?? key`) and
  the `sf-${key}` id.
- Non-enum fields keep existing behavior (password/number/text inputs, boolean switch).
- Vitest: a schema with an `enum` string field renders a `<select>` with the right options and
  emits the selected value on change.

## Part 2 — Router hook field types (`tether_ddns/hooks/registered_hooks/router_firewall.py`)

- **filter_target → boolean toggle.** Replace `filter_target: Literal['allow','drop'] = 'allow'`
  with `allow_traffic: bool = True`. In `_build_apply_payload`, `FilterTarget` = `'1'` when
  `allow_traffic` else `'0'`. The schema emits `type: boolean`, which SchemaForm already renders
  as a labeled toggle. (Update the field title/description so it reads clearly, e.g. title
  "Allow matching traffic".)
- **ingress_view / egress_view → friendly enums.** Replace the raw-string fields with
  `ingress: Literal['lan','internet','dslite'] = 'internet'` and
  `egress: Literal['lan','internet','dslite'] = 'lan'`. Add a mapping
  `_VIEW_CODES = {'lan': 'DEV.IP.IF1', 'internet': 'DEV.IP.IF4', 'dslite': 'DEV.IP.IF8'}`.
  In `_build_apply_payload`, `INCViewName = _VIEW_CODES[config.ingress]`,
  `OUTCViewName = _VIEW_CODES[config.egress]`. These become enum schema fields → SchemaForm
  renders them as `<select>`.
- `ip_version` and `protocol` stay as their existing `Literal` enums; they now render as
  dropdowns purely via the Part 1 SchemaForm change (no hook change needed).
- Update `test/unit/test_router_firewall_hook.py`: the flow test asserts the apply payload's
  `FilterTarget`, `INCViewName`, `OUTCViewName` reflect the new boolean/enum config
  (defaults: allow→'1', internet→'DEV.IP.IF4', lan→'DEV.IP.IF1'); add a case with
  `allow_traffic=False` → `FilterTarget == '0'` and `ingress='dslite'` → `DEV.IP.IF8`.

## Backward compatibility

- Hooks are stateless plugins configured via the on-disk config; a previously-saved
  `router_firewall` hook config that used `filter_target`/`ingress_view`/`egress_view` will have
  those keys ignored (pydantic `extra='ignore'`) and fall back to the new defaults. Since the
  hook was only just added and not yet configured in production, this is acceptable; no migration.

## Testing & gates

- Backend: `pytest test/` passes, coverage ≥ 90, flake8/mypy/pyright-strict/ruff green.
- Frontend: `tsc --noEmit` clean; Vitest + coverage thresholds (incl. the new enum-select test);
  Playwright e2e passes.
- Live: the router hook form shows IP Version + Protocol + Ingress + Egress as dropdowns and
  Filter/Allow as a toggle; the Cloudflare provider form is unaffected except its enum-less
  fields (it has none) — verify no regression.

## Out of scope

- Rendering enums with richer human labels beyond simple humanization.
- Supporting the router's "Any" IP version or the second "Dslite" (`DEV.IP.IF9`) option.
- Any change to the ordering/prefix/port fields (they remain number/text inputs).
