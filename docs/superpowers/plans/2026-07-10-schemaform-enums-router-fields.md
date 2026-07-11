# Schema Enum Selects + Router Hook Field Types — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render JSON-schema `enum` fields as dropdowns in SchemaForm (app-wide), and improve the router hook fields (filter target → toggle; ingress/egress → friendly enums mapped to router codes).

**Architecture:** One frontend change (SchemaForm) + one backend change (router hook config/mapping). Both are plugin-schema driven; the hook's enums render via the SchemaForm change with no per-field UI code.

**Tech Stack:** React + TypeScript + Vite; Python 3.12 (pydantic).

## Global Constraints

- Strict gates: backend flake8/mypy/pyright-strict/ruff, coverage ≥ 90 (`pytest test/`); frontend strict TS, `tsc --noEmit` clean, Vitest + coverage thresholds, Playwright e2e.
- Backward-compat: pydantic `extra='ignore'` drops stale hook config keys; no migration.
- Venv at `.venv` (`source .venv/bin/activate`; project uses `uv`).
- Confirmed router codes: LAN=`DEV.IP.IF1`, Internet=`DEV.IP.IF4`, DS-Lite=`DEV.IP.IF8`.

---

## Task 1: SchemaForm renders enums as `<select>`

**Files:**
- Modify: `frontend/src/components/SchemaForm.tsx`
- Test: `frontend/src/components/SchemaForm.test.tsx`

**Interfaces:**
- `SchemaProperty` gains `enum?: (string | number)[]`.
- Helper `humanizeOption(v: string | number): string` — for strings, split on `_`, capitalize each word (`tcp_udp` → `Tcp Udp`, `ipv6` → `Ipv6`); numbers → `String(v)`.
- When `prop.enum` is present and `prop.type !== 'boolean'`, render a `<select>`.

- [ ] **Step 1: Write the failing test**

Add to `frontend/src/components/SchemaForm.test.tsx`:
```tsx
it('renders an enum field as a select and emits the chosen value', () => {
  const schema = { properties: { protocol: { type: 'string', title: 'Protocol', enum: ['tcp', 'udp'] } } };
  const onChange = vi.fn();
  render(<SchemaForm schema={schema} value={{ protocol: 'tcp' }} onChange={onChange} />);
  const select = screen.getByLabelText('Protocol') as HTMLSelectElement;
  expect(select.tagName).toBe('SELECT');
  expect(Array.from(select.options).map((o) => o.value)).toEqual(['tcp', 'udp']);
  fireEvent.change(select, { target: { value: 'udp' } });
  expect(onChange).toHaveBeenCalledWith({ protocol: 'udp' });
});
```
(Ensure `fireEvent` is imported in the test file.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npx vitest run src/components/SchemaForm.test.tsx`
Expected: FAIL — currently renders a text input, not a select.

- [ ] **Step 3: Implement**

In `frontend/src/components/SchemaForm.tsx`:
- Extend the interface:
```tsx
export interface SchemaProperty {
  title?: string;
  type?: string;
  format?: string;
  description?: string;
  enum?: (string | number)[];
}
```
- Add the helper above the component:
```tsx
function humanizeOption(v: string | number): string {
  if (typeof v === 'number') return String(v);
  return v.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}
```
- In the render map, after the boolean branch and before `const type = inputType(prop);`, add:
```tsx
        if (prop.enum && prop.enum.length > 0) {
          const numeric = prop.enum.every((o) => typeof o === 'number');
          return (
            <div className="field" key={key}>
              <label htmlFor={`sf-${key}`}>{label}</label>
              <select
                id={`sf-${key}`}
                aria-label={label}
                value={current == null ? '' : String(current)}
                onChange={(e) => update(key, numeric ? Number(e.target.value) : e.target.value)}
              >
                {prop.enum.map((opt) => (
                  <option key={String(opt)} value={String(opt)}>{humanizeOption(opt)}</option>
                ))}
              </select>
            </div>
          );
        }
```

- [ ] **Step 4: Verify**

Run: `cd frontend && npx vitest run src/components/SchemaForm.test.tsx` → PASS.
Run: `cd frontend && npx tsc --noEmit` → clean.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/SchemaForm.tsx frontend/src/components/SchemaForm.test.tsx
git commit -m "feat: SchemaForm renders enum fields as dropdowns"
```

---

## Task 2: Router hook — filter toggle + friendly ingress/egress

**Files:**
- Modify: `tether_ddns/hooks/registered_hooks/router_firewall.py`
- Test: `test/unit/test_router_firewall_hook.py`

**Interfaces:**
- Config: replace `filter_target: Literal['allow','drop'] = 'allow'` with `allow_traffic: bool = True`; replace `ingress_view: str`/`egress_view: str` with `ingress: Literal['lan','internet','dslite'] = 'internet'` and `egress: Literal['lan','internet','dslite'] = 'lan'`.
- Add `_VIEW_CODES = {'lan': 'DEV.IP.IF1', 'internet': 'DEV.IP.IF4', 'dslite': 'DEV.IP.IF8'}`.
- `_build_apply_payload`: `FilterTarget` from `allow_traffic`; `INCViewName`/`OUTCViewName` from `_VIEW_CODES`.

- [ ] **Step 1: Update the tests first**

In `test/unit/test_router_firewall_hook.py`, the `test_handle_updates_dest_ip` flow test should also assert the new payload fields. Add assertions after the existing ones:
```python
    assert payload['FilterTarget'] == '1'          # allow_traffic default True
    assert payload['INCViewName'] == 'DEV.IP.IF4'   # ingress default internet
    assert payload['OUTCViewName'] == 'DEV.IP.IF1'  # egress default lan
```
Add a focused mapping test (pure, no HTTP):
```python
def test_build_apply_payload_maps_toggle_and_views() -> None:
    """allow_traffic and friendly views map to router codes."""
    from tether_ddns.hooks.registered_hooks.router_firewall import _build_apply_payload
    cfg = RouterFirewallHook.ConfigModel(
        username='u', password=SecretStr('p'), ip_version='ipv6',
        allow_traffic=False, ingress='dslite', egress='internet')
    payload = _build_apply_payload(cfg, '1', '2001:db8::9')
    assert payload['FilterTarget'] == '0'
    assert payload['INCViewName'] == 'DEV.IP.IF8'
    assert payload['OUTCViewName'] == 'DEV.IP.IF4'
```
(`_build_apply_payload` is module-private; importing it inside the test is fine in-package, but pyright's `reportPrivateUsage` will flag a top-level import. To avoid that, import it *inside* the test function as shown, or make it public. Prefer the in-function import to keep the module surface small; if pyright still flags it, make `_build_apply_payload` public as `build_apply_payload` and update `handle` + tests.)

- [ ] **Step 2: Run to verify it fails**

Run: `python -m pytest test/unit/test_router_firewall_hook.py -v`
Expected: FAIL (new fields/mapping not present).

- [ ] **Step 3: Implement the config + mapping changes**

In `tether_ddns/hooks/registered_hooks/router_firewall.py`:
- Remove the `_FILTER_TARGETS` constant usage and replace the config fields:
```python
    ip_version: Literal['ipv4', 'ipv6'] = 'ipv6'
    allow_traffic: bool = True
    source_ip: str = '::'
    source_prefix: int = 0
    dest_prefix: int = 128
    protocol: Literal['any', 'tcp', 'udp', 'icmpv6', 'tcp_udp'] = 'udp'
    min_src_port: int = 1
    max_src_port: int = 65535
    min_dst_port: int = 443
    max_dst_port: int = 443
    ingress: Literal['lan', 'internet', 'dslite'] = 'internet'
    egress: Literal['lan', 'internet', 'dslite'] = 'lan'
    verify_tls: bool = False
```
- Replace the `_FILTER_TARGETS` module constant with:
```python
_VIEW_CODES = {'lan': 'DEV.IP.IF1', 'internet': 'DEV.IP.IF4', 'dslite': 'DEV.IP.IF8'}
```
  (Delete the now-unused `_FILTER_TARGETS`. Keep `_IP_VERSIONS`.)
- In `_build_apply_payload`, update the three lines:
```python
        'FilterTarget': '1' if config.allow_traffic else '0',
        ...
        'INCViewName': _VIEW_CODES[config.ingress],
        'OUTCViewName': _VIEW_CODES[config.egress],
```

- [ ] **Step 4: Verify**

Run: `python -m pytest test/unit/test_router_firewall_hook.py -v` → all PASS.
Run: `python -m pytest test/ -q` → all pass, coverage ≥ 90.
Lint: `ruff check`, `flake8`, `mypy tether_ddns/hooks/registered_hooks/router_firewall.py`, `pyright tether_ddns/hooks/registered_hooks/router_firewall.py`. Fix violations.

- [ ] **Step 5: Commit**

```bash
git add tether_ddns/hooks/registered_hooks/router_firewall.py test/unit/test_router_firewall_hook.py
git commit -m "feat: router hook allow-traffic toggle and friendly ingress/egress views"
```

---

## Task 3: Verify + live

**Files:** none.

- [ ] **Step 1: Frontend + e2e**

Run: `cd frontend && npx vitest run --coverage && npx playwright test` → all pass.

- [ ] **Step 2: Live UI check**

Build + serve, open Add Hook → Router Firewall (ZTE). Confirm: IP Version, Protocol, Ingress, Egress render as dropdowns (with friendly labels); "Allow matching traffic" (allow_traffic) renders as a toggle; Password stays masked. Confirm the Cloudflare provider form still renders correctly (its `proxied` toggle + `ttl` number, no regressions).

---

## Self-Review Notes

- **Spec coverage:** SchemaForm enum→select app-wide (T1) covers router IP Version + Protocol and any future enum; router filter_target→bool toggle + ingress/egress friendly enums mapped to confirmed codes (T2); verify incl. live (T3). Dest IP intentionally absent (auto). All mapped.
- **Type consistency:** `enum?` on `SchemaProperty`; `allow_traffic`/`ingress`/`egress` in config; `_VIEW_CODES` mapping; `_build_apply_payload` fields updated. mypy/tsc catch missed refs.
- **Placeholders:** none — full code provided. Backward-compat via extra-ignore noted.
