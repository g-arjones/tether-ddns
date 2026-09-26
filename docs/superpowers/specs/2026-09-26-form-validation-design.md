# Domain & Hook Form Validation — Design

Date: 2026-09-26
Branch: `improve_form_validations`

## Problem

The Domain and Hook add/edit endpoints validate only the top-level request shape.
`provider_config` / `config` is stored as-is and is only validated at run time
(`services/sync.py`, `services/dispatch.py`), so a missing or empty token is
accepted, persisted, and surfaces later as a sync/dispatch failure. The modals
show a generic "Failed to save" toast and nothing on the offending field.

The healthchecks project flow already does this correctly: pydantic input model,
422 in FastAPI's shape with `loc: ['body', <field>]`, and `ProjectModal` decorating
the matching input. This design applies that pattern to domains and hooks.

## Decisions

- **Strictness:** structural validation plus tightened plugin config models and
  request models. No upstream credential checks.
- **Where:** explicit validation in the four route handlers, **after**
  `merge_secrets`. Not in the request models (they cannot see stored secrets) and
  not in the persisted models (a bad config file would stop the app from booting).
- **Already-invalid saved configs:** every write validates. The Overview enable
  toggle does a full PUT, so a broken domain fails with a clear toast. Loading from
  disk stays unvalidated.
- **Client side:** server is the only validator. The frontend adds required markers
  from the JSON schema `required` list.

## Backend

### Shared field types — `tether_ddns/schema_fields.py`

```python
RequiredStr = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]
RequiredSecret = Annotated[SecretStr, Field(min_length=1)]
```

Verified on pydantic 2.13.4: `Field(min_length=1)` is enforced on `SecretStr` and
emits `minLength: 1` alongside `format: password` in the JSON schema.

### Tightened plugin config models

Fields use real pydantic types where one exists, so the validated model carries
the parsed value and the hook code adapts to it (see *Router firewall hook* below).

| Model | Field | Rule |
|---|---|---|
| `DuckDNSConfig` | `token` | `RequiredSecret` |
| `CloudflareConfig` | `api_token` | `RequiredSecret` |
| `CloudflareConfig` | `ttl` | `1` (auto) or `60..86400` |
| `PushoverConfig` | `token`, `user` | `RequiredSecret` |
| `RouterFirewallConfig` | `username`, `rule_name` | `RequiredStr` |
| `RouterFirewallConfig` | `password` | `RequiredSecret` |
| `RouterFirewallConfig` | `router_url` | `HttpUrl`, default `HttpUrl('https://192.168.0.1')` |
| `RouterFirewallConfig` | `source_ip` | `IPvAnyAddress`, default `IPv6Address('::')` |

Fields with defaults keep them, so they stay out of the schema's `required` list.
`labeled_field(...)` metadata is preserved on every annotated field.

### Router firewall hook

The validated model now yields a pydantic `Url` and an `IPv4Address`/`IPv6Address`
instead of `str` (verified on pydantic 2.13.4: `Url` has no `rstrip`, and
`str(HttpUrl('https://192.168.0.1'))` is `'https://192.168.0.1/'`). Two call sites
change in `hooks/registered_hooks/router_firewall.py`:

- `on_ip_changed`: `base = str(config.router_url).rstrip('/')`. The existing
  `rstrip` already absorbs the trailing slash `HttpUrl` adds.
- `build_apply_payload`: `'SourceIP': str(config.source_ip)`. Without this the
  payload is not `dict[str, str]` and `encode_apply_body`'s `urllib.parse.quote`
  raises `TypeError`. The `SourceIPMask` f-string already stringifies.

Consequence: the router receives the IPv6 source in compressed form
(`2001:0db8::0001` → `2001:db8::1`). Same address, so the rule is unaffected.

The stored config keeps the operator's raw strings; only the validated model
carries the parsed types.

The JSON schema gains `format: uri` (plus `minLength`/`maxLength`) and
`format: ipvanyaddress`; `SchemaForm` already renders unknown formats as text
inputs.

### Request models — `tether_ddns/api.py`

- `DomainInput`
  - `hostname: RequiredStr`
  - `record_type: Literal['A', 'AAAA'] = 'A'`
  - `provider`: field validator, must be in `PROVIDER_REGISTRY`, else
    `"Unknown provider"`.
- `HookInput`
  - `hook`: field validator, must be in `HOOK_REGISTRY`, else `"Unknown hook"`.
  - `events`: field validator (runs after `hook`, reads it from
    `ValidationInfo.data`) checks each event against
    `HOOK_REGISTRY[hook].supported_events()`; skipped when `hook` already
    failed. Error: `"Unsupported event <key>"` at loc `events`.
  - `_validate_hook_events` (plain-text 400) is removed.

### Handler helper

```python
def validate_plugin_config(
    cls: type[ConfigModelMixin], config: dict[str, object], field: str,
) -> None:
    try:
        cls.ConfigModel.model_validate(config)
    except ValidationError as exc:
        raise _body_validation_error(exc, prefix=(field,)) from exc
```

- Called in `create_domain`, `update_domain` (`field='provider_config'`) and
  `create_hook`, `update_hook` (`field='config'`), after `merge_secrets` on updates.
- The handler persists the **merged raw dict**, never `model_dump()` — dumping a
  `SecretStr` writes `'**********'` and destroys the stored secret.
- `_body_validation_error(exc, prefix=())` gains the `prefix` argument; locs become
  `('body', *prefix, *error['loc'])`, e.g. `['body', 'provider_config', 'api_token']`.

### Message normalisation

One `RequestValidationError` exception handler, registered in `register_routes`,
rewrites `msg` to **`"Required"`** when:

- `type == 'missing'`, or
- `type in {'too_short', 'string_too_short'}` and `ctx['min_length'] == 1`.

It covers both FastAPI's own request-body 422s (e.g. `hostname`, raised before the
handler runs) and the ones raised from `_body_validation_error` /
`_upstream_error`, so every 422 reads the same. All other messages pass through
unchanged; settings and healthchecks tests assert locs or upstream messages,
which are unaffected.

### Unchanged

- Runtime `model_validate` in sync/dispatch stays as the guard for configs saved
  before this change.
- IP sources have no config model; out of scope.

## Frontend

### `api.ts`

- `fieldErrorsOf` keys each message by its **dotted path with the leading `body`
  removed**: `['body', 'provider_config', 'api_token']` → `provider_config.api_token`,
  `['body', 'hostname']` → `hostname`. Existing top-level keys (`api_key`,
  `base_url`, `heartbeat_url`, …) are unchanged, so `ProjectModal` and
  `SettingsView` need no changes beyond the CSS class rename below.
- New export `subErrors(errors, prefix)`: returns the errors under `prefix.`, keyed by
  the **first** segment after the prefix (`provider_config.ports.0` → `ports`). An
  error whose key equals `prefix` exactly is returned under the key `''` (a
  whole-config error).

### `SchemaForm`

- New prop `errors?: Record<string, string>` (default `{}`).
- Text/number/password inputs and enum `<select>`s get:
  - `className="field-invalid"` when in error,
  - `aria-invalid={error ? true : undefined}`,
  - `aria-describedby="sf-<key>-help"` when a help line exists.
- The help div `id="sf-<key>-help"` renders only when it has text: the error (with
  `hb-error`) in place of the description, else the description. An empty div
  would add a 7px `.field` flex gap.
- Boolean switches are not decorated.
- Required markers: for keys in `schema.required`, the label gets
  `<span className="req" aria-hidden="true">*</span>` and the control gets
  `aria-required="true"`. `JsonSchema.required` is already typed.

### `Select`

New optional props `invalid?: boolean` and `describedBy?: string`:
- native `<select>`: `aria-invalid`, `aria-describedby`;
- `.cs-trigger`: `field-invalid` class.

### CSS — `styles.css`

- Replace `.field input.hc-invalid` with
  `.field :is(input, select, .cs-trigger).field-invalid` (same border + `--err-soft`
  ring). `ProjectModal` switches `hc-invalid` → `field-invalid`.
- `.field label .req { color: var(--text-3); margin-left: 2px; }` — neutral, not the
  blue accent (interactive only) and not red (errors only).
- `.hb-url input.hb-invalid` (SettingsView) is untouched.

### `DomainModal` / `HookModal`

Follow the `ProjectModal` pattern:

- State: `errors`, `formError`, `saving`.
- `onSave: (value) => Promise<void>`; rejects on failure.
- On `ApiError`: `setErrors(err.fieldErrors)`. `formError` is set when there are no
  field errors ("Failed to save domain" / "Failed to save hook") **or** when
  `subErrors(errors, prefix)['']` exists (shown as that message).
- Top-level fields decorated directly: `hostname`, `provider`, `record_type`
  (DomainModal); `hook`, `events` (HookModal). The events error renders in a help
  line under the event checklist.
- `SchemaForm` receives `errors={subErrors(errors, 'provider_config')}` (or
  `'config'`).
- Editing a field clears only that key. Changing provider / hook type clears every
  `provider_config.*` / `config.*` key.
- Submit button `disabled={saving}`.
- Form-level error renders as `<div className="field-help hb-error" role="alert">`.

### Reconnect-reset fix (DomainModal)

Today the reset effect depends on `[editing, providers, open]`, so a ws reconnect
refetching `providers` wipes the form (and would now wipe inline errors). The
effect depends on `[editing, open]` only; the default provider for a new domain is
read from a ref holding the latest `providers`. HookModal has the same bug
(`[editing, hooks, open]`) and gets the same fix.

If `providers` is still empty when an Add modal opens, the provider stays `''`; a
second effect fills it in once when `form.provider === ''` and providers arrive,
without touching other fields.

### `App.tsx`

- `handleSaveDomain` / `handleSaveHook` rethrow like `handleSaveProject`; the
  success toast stays, the error toast is removed.
- The client-side `"Please enter a hostname"` check is removed.
- `handleToggle`: on `ApiError` with status 422, toast
  **"{hostname}: fix its provider config first"** (the toggle can be disabling
  too); otherwise keep
  "Failed to update domain".

## Error handling summary

| Response | Where it shows |
|---|---|
| 422 with a field loc | Inline on that field; modal stays open, input kept |
| 422 with loc ending at `provider_config` / `config` | Form-level alert |
| 404, 5xx, network error | Form-level alert ("Failed to save domain/hook") |
| Overview toggle 422 | Toast naming the hostname |

## Testing

### Backend — new `test/unit/test_api_validation.py`

- Domain create (DuckDNS) → 422 at `body.provider_config.token`,
  `msg == 'Required'`, for a missing and an empty token.
- Domain create with hostname `'   '` → 422 at `body.hostname`, `msg == 'Required'`
  (proves strip + the FastAPI-level message rewrite).
- Domain update with the masked value **and** with `''` for a secret → 200
  (proves merge happens before validation).
- Stored `provider_config` keeps the real secret string (proves no `model_dump()`).
- 422s: unknown provider (`body.provider`), `record_type: 'MX'`
  (`body.record_type`), blank hostname (`body.hostname`), Cloudflare `ttl: 30`
  (`body.provider_config.ttl`).
- Hooks: Pushover missing `user` → 422 at `body.config.user`; unknown hook →
  `body.hook`; unsupported event → `body.events`.
- Message rewrite: `"Required"` for `missing` and `min_length == 1`; another
  message (e.g. literal mismatch) passes through verbatim.
- Per-model constraint tests for each tightened config model: bad URL (`ftp://x`,
  `not a url`) and bad IP (`999.1.1.1`) rejected at `body.config.router_url` /
  `body.config.source_ip`.
- Router firewall hook tests: `build_apply_payload` values are all `str`
  (`SourceIP == '::'` for the default); `on_ip_changed` builds the base URL without
  a doubled slash for both `https://192.168.0.1` and `https://192.168.0.1/`;
  `encode_apply_body` round-trips an IPv4 and an IPv6 `source_ip`.
- **Audit:** existing tests/fixtures that create domains or hooks with incomplete
  config (e.g. `provider_config: {}`) are fixed to send valid config, or converted
  to explicit 422 tests. The existing 400-on-bad-event test becomes a 422 test.
- Gates: `flake8 test/ tether_ddns/`, `ruff`, `mypy .`, `pyright`,
  `pytest test/ --cov=tether_ddns --cov-fail-under=90`.

### Frontend — Vitest

- `api.test.ts`: dotted keys, `body` stripped, top-level keys unchanged;
  `subErrors` including the `''` whole-config key and deep-path collapse.
- `SchemaForm.test.tsx`: error → `aria-invalid`, help text replaces description,
  `aria-describedby` resolves; enum `<select>` decorated; required `*` +
  `aria-required` only on required keys.
- `Select.test.tsx`: `invalid` / `describedBy` wiring.
- `DomainModal.test.tsx` / `HookModal.test.tsx`: field errors after a rejected
  save; editing clears only that key; provider change clears config keys; fallback
  alert; submit disabled while saving; **regression:** rerender with a new
  `providers` array keeps form values and errors.
- App tests: toggle 422 toast; hostname toast gone.
- Gate: `npm test` **and** `npx tsc --noEmit -p tsconfig.app.json` (`onSave`
  signature changes).

### E2E — Playwright

One spec: open Add Domain, pick Cloudflare, submit without a token. After
`await expect(page.locator('.modal')).toHaveCSS('transform', 'none')`, assert on
the token input: `aria-invalid="true"`, computed `border-color` equals `--err`, help
text `"Required"`. Second case: open Add Hook, pick Router Firewall, and
`page.route` the POST to return a 422 at `body.hook` and `body.config.ip_version`;
assert the same border on the hook `Select`'s `.cs-trigger` and on the
`ip_version` SchemaForm `<select>`. jsdom cannot prove the `:is(...)` selector
applies; this test does.

## Out of scope

- Upstream credential checks for providers/hooks.
- Client-side pre-validation beyond required markers.
- IP source configuration.
- Validating configs on load from disk.
