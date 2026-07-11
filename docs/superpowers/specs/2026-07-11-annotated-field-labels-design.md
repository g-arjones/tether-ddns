# Annotated Field Display Names + UI-Friendly Enum Labels — Design Spec

**Date:** 2026-07-11
**Status:** Approved

## Overview

Provider and hook config models render in the frontend via `SchemaForm`, driven by
`model_json_schema()`. Field labels come from pydantic's auto-generated `title` (e.g.
`router_url` → "Router Url"), and enum/Literal option labels come from a `humanizeOption`
helper that title-cases underscore-split values (e.g. `tcp_udp` → "Tcp Udp", `icmpv6` →
"Icmpv6", `dslite` → "Dslite"). Both are often wrong or ugly.

This adds a small, reusable mechanism to declare friendly field titles/descriptions and
per-value enum labels on config models using `typing.Annotated`, and teaches `SchemaForm` to
honor the enum labels. It then applies the mechanism to `RouterFirewallConfig` (the only
enum-heavy model today).

## Mechanism

### Python helper — `tether_ddns/schema_fields.py` (new)

```python
def labeled_field(
    *,
    title: str | None = None,
    description: str | None = None,
    labels: dict[str, str] | None = None,
    **kwargs: object,
) -> Any:
    """Build a pydantic Field with a title and optional enum-value labels."""
```

- Returns `pydantic.Field(...)` with `title`/`description` set when provided and
  `json_schema_extra={'x-enum-labels': labels}` when `labels` is provided. Any caller-supplied
  `json_schema_extra` in `kwargs` is merged (the `x-enum-labels` key is added to it).
- Used in `Annotated[T, labeled_field(...)]` position, so field defaults remain declared on the
  model attribute (e.g. `protocol: Annotated[Literal[...], labeled_field(...)] = 'udp'`).
- Return type is `Any` because pydantic's `Field` returns a sentinel typed for assignment
  positions; this matches how `Field` is normally used.

The resulting JSON schema for such a field carries `title`, optional `description`, and
`x-enum-labels: {value: label}`.

### Frontend — `frontend/src/components/SchemaForm.tsx`

- Extend `SchemaProperty` with `'x-enum-labels'?: Record<string, string>`.
- In the enum branch, resolve each option's label as
  `prop['x-enum-labels']?.[String(opt)] ?? humanizeOption(opt)`.
- No other changes: value-type inference (numeric vs string), the boolean/switch branch, and
  the text/number branch are untouched. Fully backward-compatible — fields without
  `x-enum-labels` behave exactly as today.

## Applied Usage — `RouterFirewallConfig`

Convert the Literal fields to `Annotated[..., labeled_field(...)]` with these labels:

- `ip_version`: `ipv4` → "IPv4", `ipv6` → "IPv6"
- `protocol`: `any` → "Any", `tcp` → "TCP", `udp` → "UDP", `icmpv6` → "ICMPv6",
  `tcp_udp` → "TCP + UDP"
- `ingress` / `egress`: `lan` → "LAN", `internet` → "Internet", `dslite` → "DS-Lite"

Add friendly `title` (and `description` where helpful) to the non-obvious scalar fields so the
auto-generated labels read well, e.g.:

- `router_url` → title "Router URL"
- `rule_name` → title "Rule Name"
- `allow_traffic` → title "Allow Traffic"
- `source_ip` → title "Source IP"; `source_prefix` → "Source Prefix"
- `dest_prefix` → "Destination Prefix"
- `min_src_port` / `max_src_port` / `min_dst_port` / `max_dst_port` → "Min/Max Source/Dest Port"
- `verify_tls` → "Verify TLS"

Field defaults, types, and validation are unchanged — only presentation metadata is added.

## Testing

**Python (`test/unit/`):**
- `labeled_field` with `title`/`description`/`labels` produces a field whose JSON schema (via a
  tiny throwaway model) contains the expected `title`, `description`, and
  `x-enum-labels` mapping.
- `labeled_field` merges an existing `json_schema_extra` passed via `kwargs` rather than
  overwriting it.
- `RouterFirewallConfig.model_json_schema()` contains `x-enum-labels` with "TCP + UDP" on
  `protocol` and "DS-Lite" on `ingress`/`egress`, and the friendly `title` on `router_url`.

**Frontend (Vitest, `frontend/src/components/SchemaForm.test.tsx`):**
- An enum property with `x-enum-labels` renders `<option>` text using the custom labels.
- An enum property without `x-enum-labels` still renders via `humanizeOption` (regression).

## Out of Scope

- Changing how values are submitted (still raw enum values).
- Provider configs (DuckDNS/Cloudflare have no enum fields today).
- Replacing or changing the `humanizeOption` fallback behavior.
- A general enum-subclass/label-registry system (YAGNI — the Field helper suffices).
