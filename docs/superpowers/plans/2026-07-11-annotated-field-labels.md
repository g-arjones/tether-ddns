# Annotated Field Labels + Friendly Enums — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let config models declare friendly field titles and per-value enum labels via `typing.Annotated`, and have `SchemaForm` render the enum labels; apply to `RouterFirewallConfig`.

**Architecture:** A tiny Python helper `labeled_field()` emits `Field(title=..., description=..., json_schema_extra={'x-enum-labels': {...}})`. The frontend reads `x-enum-labels` in the enum branch, falling back to `humanizeOption`.

**Tech Stack:** Python 3.12, pydantic v2, React + TypeScript + Vitest.

## Global Constraints

- Docstrings on all public Python functions (flake8 pep257); single quotes; alphabetical imports.
- Must pass: `flake8`, `ruff check`, `mypy .`, `pyright tether_ddns`, `pytest --cov-fail-under=90`; frontend `npm run lint`, `npm run typecheck`, `npm test`.
- No new dependencies. Backward compatible: fields without `x-enum-labels` behave exactly as today.

---

### Task 1: `labeled_field` helper

**Files:**
- Create: `tether_ddns/schema_fields.py`
- Test: `test/unit/test_schema_fields.py`

**Interfaces:**
- Produces: `labeled_field(*, title: str | None = None, description: str | None = None, labels: dict[str, str] | None = None, **kwargs: object) -> Any` — returns a pydantic `FieldInfo` (via `Field`) carrying `title`, `description`, and `json_schema_extra={'x-enum-labels': labels}` (merged with any caller `json_schema_extra`).

- [ ] **Step 1: Write the failing tests**

Create `test/unit/test_schema_fields.py`:

```python
"""Tests for the labeled_field schema helper."""
from typing import Annotated, Literal

from pydantic import BaseModel

from tether_ddns.schema_fields import labeled_field


def test_labeled_field_sets_title_description_and_enum_labels() -> None:
    """labeled_field surfaces title, description and x-enum-labels in the schema."""
    class Model(BaseModel):
        proto: Annotated[
            Literal['tcp', 'tcp_udp'],
            labeled_field(
                title='Protocol', description='Wire protocol',
                labels={'tcp': 'TCP', 'tcp_udp': 'TCP + UDP'}),
        ] = 'tcp'

    schema = Model.model_json_schema()
    prop = schema['properties']['proto']
    assert prop['title'] == 'Protocol'
    assert prop['description'] == 'Wire protocol'
    assert prop['x-enum-labels'] == {'tcp': 'TCP', 'tcp_udp': 'TCP + UDP'}


def test_labeled_field_without_labels_has_no_enum_labels_key() -> None:
    """Omitting labels leaves the schema free of an x-enum-labels key."""
    class Model(BaseModel):
        name: Annotated[str, labeled_field(title='Name')] = ''

    prop = Model.model_json_schema()['properties']['name']
    assert prop['title'] == 'Name'
    assert 'x-enum-labels' not in prop


def test_labeled_field_merges_existing_json_schema_extra() -> None:
    """A caller-provided json_schema_extra is preserved alongside x-enum-labels."""
    class Model(BaseModel):
        v: Annotated[
            str,
            labeled_field(
                labels={'a': 'A'}, json_schema_extra={'x-foo': 'bar'}),
        ] = 'a'

    prop = Model.model_json_schema()['properties']['v']
    assert prop['x-enum-labels'] == {'a': 'A'}
    assert prop['x-foo'] == 'bar'
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest test/unit/test_schema_fields.py -v -o addopts=""`
Expected: FAIL with `ModuleNotFoundError: No module named 'tether_ddns.schema_fields'`.

- [ ] **Step 3: Implement the helper**

Create `tether_ddns/schema_fields.py`:

```python
"""Helpers for declaring UI-friendly config-model fields."""
from __future__ import annotations

from typing import Any, cast

from pydantic import Field


def labeled_field(
    *,
    title: str | None = None,
    description: str | None = None,
    labels: dict[str, str] | None = None,
    **kwargs: object,
) -> Any:
    """Build a pydantic Field with a title and optional enum-value labels.

    ``labels`` maps enum/Literal values to human labels and is emitted under the
    schema key ``x-enum-labels`` (merged with any ``json_schema_extra`` passed in
    ``kwargs``). Intended for use in ``Annotated[T, labeled_field(...)]`` so the
    field default stays on the model attribute.
    """
    field_kwargs = dict(kwargs)
    if title is not None:
        field_kwargs['title'] = title
    if description is not None:
        field_kwargs['description'] = description
    if labels is not None:
        extra = field_kwargs.get('json_schema_extra')
        merged: dict[str, object] = dict(cast('dict[str, object]', extra)) if extra else {}
        merged['x-enum-labels'] = labels
        field_kwargs['json_schema_extra'] = merged
    return Field(**field_kwargs)  # pyright: ignore[reportUnknownMemberType]
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest test/unit/test_schema_fields.py -v -o addopts=""`
Expected: all PASS.

- [ ] **Step 5: Lint and type-check**

Run:
```bash
ruff check tether_ddns/schema_fields.py test/unit/test_schema_fields.py
flake8 tether_ddns/schema_fields.py test/unit/test_schema_fields.py
mypy .
pyright tether_ddns
```
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add tether_ddns/schema_fields.py test/unit/test_schema_fields.py
git commit -m "feat(schema): add labeled_field helper for titles and enum labels"
```

---

### Task 2: Apply labeled_field to RouterFirewallConfig

**Files:**
- Modify: `tether_ddns/hooks/registered_hooks/router_firewall.py`
- Test: `test/unit/test_router_firewall_hook.py`

**Interfaces:**
- Consumes: `labeled_field` from Task 1.

- [ ] **Step 1: Write the failing test**

Append to `test/unit/test_router_firewall_hook.py`:

```python
def test_config_schema_has_friendly_labels_and_titles() -> None:
    """The config schema carries friendly enum labels and field titles."""
    schema = RouterFirewallConfig.model_json_schema()
    props = schema['properties']
    assert props['protocol']['x-enum-labels']['tcp_udp'] == 'TCP + UDP'
    assert props['protocol']['x-enum-labels']['icmpv6'] == 'ICMPv6'
    assert props['ingress']['x-enum-labels']['dslite'] == 'DS-Lite'
    assert props['egress']['x-enum-labels']['internet'] == 'Internet'
    assert props['ip_version']['x-enum-labels']['ipv6'] == 'IPv6'
    assert props['router_url']['title'] == 'Router URL'
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest test/unit/test_router_firewall_hook.py::test_config_schema_has_friendly_labels_and_titles -v -o addopts=""`
Expected: FAIL (`KeyError: 'x-enum-labels'`).

- [ ] **Step 3: Update the config model**

In `tether_ddns/hooks/registered_hooks/router_firewall.py`:

Add imports (keep ordering — `Annotated` joins the existing `from typing import Literal`, and a new import for the helper in the local-package group):

```python
from typing import Annotated, Literal
```
and, in the `tether_ddns` import group:
```python
from tether_ddns.schema_fields import labeled_field
```

Replace the `RouterFirewallConfig` field declarations with annotated versions (defaults stay on the attribute):

```python
class RouterFirewallConfig(BaseModel):
    """Configuration for the ZTE router firewall hook."""

    router_url: Annotated[str, labeled_field(title='Router URL')] = 'https://192.168.0.1'
    username: str
    password: SecretStr
    rule_name: Annotated[str, labeled_field(title='Rule Name')] = 'Wireguard'
    ip_version: Annotated[
        Literal['ipv4', 'ipv6'],
        labeled_field(
            title='IP Version',
            labels={'ipv4': 'IPv4', 'ipv6': 'IPv6'}),
    ] = 'ipv6'
    allow_traffic: Annotated[bool, labeled_field(title='Allow Traffic')] = True
    source_ip: Annotated[str, labeled_field(title='Source IP')] = '::'
    source_prefix: Annotated[int, labeled_field(title='Source Prefix')] = 0
    dest_prefix: Annotated[int, labeled_field(title='Destination Prefix')] = 128
    protocol: Annotated[
        Literal['any', 'tcp', 'udp', 'icmpv6', 'tcp_udp'],
        labeled_field(
            title='Protocol',
            labels={
                'any': 'Any', 'tcp': 'TCP', 'udp': 'UDP',
                'icmpv6': 'ICMPv6', 'tcp_udp': 'TCP + UDP'}),
    ] = 'udp'
    min_src_port: Annotated[int, labeled_field(title='Min Source Port')] = 1
    max_src_port: Annotated[int, labeled_field(title='Max Source Port')] = 65535
    min_dst_port: Annotated[int, labeled_field(title='Min Destination Port')] = 443
    max_dst_port: Annotated[int, labeled_field(title='Max Destination Port')] = 443
    ingress: Annotated[
        Literal['lan', 'internet', 'dslite'],
        labeled_field(
            title='Ingress',
            labels={'lan': 'LAN', 'internet': 'Internet', 'dslite': 'DS-Lite'}),
    ] = 'internet'
    egress: Annotated[
        Literal['lan', 'internet', 'dslite'],
        labeled_field(
            title='Egress',
            labels={'lan': 'LAN', 'internet': 'Internet', 'dslite': 'DS-Lite'}),
    ] = 'lan'
    verify_tls: Annotated[bool, labeled_field(title='Verify TLS')] = False
```

- [ ] **Step 4: Run the router firewall tests**

Run: `python -m pytest test/unit/test_router_firewall_hook.py -v -o addopts=""`
Expected: all PASS (existing tests unaffected; new label test passes).

- [ ] **Step 5: Lint and type-check**

Run:
```bash
ruff check tether_ddns/hooks/registered_hooks/router_firewall.py
flake8 tether_ddns/hooks/registered_hooks/router_firewall.py
mypy .
pyright tether_ddns
```
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add tether_ddns/hooks/registered_hooks/router_firewall.py test/unit/test_router_firewall_hook.py
git commit -m "feat(router-firewall): friendly field titles and enum labels"
```

---

### Task 3: SchemaForm renders x-enum-labels

**Files:**
- Modify: `frontend/src/components/SchemaForm.tsx`
- Test: `frontend/src/components/SchemaForm.test.tsx`

**Interfaces:**
- Consumes: schema properties that may carry `'x-enum-labels'?: Record<string, string>`.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/components/SchemaForm.test.tsx` inside the `describe` block:

```typescript
  it('renders enum option labels from x-enum-labels', () => {
    const schema = {
      properties: {
        protocol: {
          type: 'string', title: 'Protocol', enum: ['tcp', 'tcp_udp'],
          'x-enum-labels': { tcp: 'TCP', tcp_udp: 'TCP + UDP' },
        },
      },
    };
    render(<SchemaForm schema={schema} value={{ protocol: 'tcp' }} onChange={vi.fn()} />);
    const select = screen.getByLabelText('Protocol') as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual(['TCP', 'TCP + UDP']);
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['tcp', 'tcp_udp']);
  });

  it('falls back to humanizeOption when x-enum-labels is absent', () => {
    const schema = { properties: { protocol: { type: 'string', title: 'Protocol', enum: ['tcp_udp'] } } };
    render(<SchemaForm schema={schema} value={{ protocol: 'tcp_udp' }} onChange={vi.fn()} />);
    const select = screen.getByLabelText('Protocol') as HTMLSelectElement;
    expect(select.options[0].textContent).toBe('Tcp Udp');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/components/SchemaForm.test.tsx`
Expected: the `x-enum-labels` test FAILS (options show "Tcp Udp" instead of "TCP + UDP").

- [ ] **Step 3: Implement the change**

In `frontend/src/components/SchemaForm.tsx`, extend the interface:

```typescript
export interface SchemaProperty {
  title?: string;
  type?: string;
  format?: string;
  description?: string;
  enum?: (string | number)[];
  'x-enum-labels'?: Record<string, string>;
}
```

In the enum branch, compute each option's label from `x-enum-labels` with a fallback. Replace the option render line:

```typescript
                {prop.enum.map((opt) => {
                  const labels = prop['x-enum-labels'];
                  const text = labels?.[String(opt)] ?? humanizeOption(opt);
                  return (
                    <option key={String(opt)} value={String(opt)}>{text}</option>
                  );
                })}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/components/SchemaForm.test.tsx`
Expected: all PASS.

- [ ] **Step 5: Lint and type-check the frontend**

Run: `cd frontend && npm run lint && npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/SchemaForm.tsx frontend/src/components/SchemaForm.test.tsx
git commit -m "feat(schemaform): render friendly enum labels from x-enum-labels"
```

---

## Final Verification (after all tasks)

- [ ] Run full backend suite: `python -m pytest` → all pass, coverage ≥ 90%.
- [ ] Run full frontend suite: `cd frontend && npm test` → all pass.
- [ ] Rebuild the frontend if the workflow requires it (`cd frontend && npm run build`) and spot-check the Router Firewall hook config form shows "TCP + UDP", "DS-Lite", "IPv6", and "Router URL".
