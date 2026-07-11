# Modal Descriptions — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show each field's `description` as help text in `SchemaForm`, and each plugin's class docstring as a blurb under the provider/hook picker.

**Architecture:** Pure frontend rendering of data already present in `model_json_schema()` (field `description`s and the schema's top-level `description`).

**Tech Stack:** React + TypeScript + Vitest, CSS.

## Global Constraints

- Frontend must pass `npm run lint`, `npm run build` (tsc), and `npx vitest run`.
- No backend change. Plain-text rendering (no markdown).
- Backward compatible: fields/plugins without descriptions render as before.

---

### Task 1: SchemaForm renders field descriptions for all field types

**Files:**
- Modify: `frontend/src/components/SchemaForm.tsx`
- Modify: `frontend/src/components/SchemaForm.test.tsx`
- Modify: `frontend/src/styles.css`

**Interfaces:**
- Consumes: `SchemaProperty.description` (already declared on the interface).
- Produces: a `.field-help` element under text/number/enum fields when a
  description is present.

- [ ] **Step 1: Write the failing test**

Append to `frontend/src/components/SchemaForm.test.tsx` inside the `describe`:

```typescript
  it('renders field description help text for a text field', () => {
    const schema = {
      properties: {
        token: { title: 'Token', type: 'string', description: 'Your API token' },
      },
    };
    render(<SchemaForm schema={schema} value={{}} onChange={vi.fn()} />);
    expect(screen.getByText('Your API token')).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/components/SchemaForm.test.tsx`
Expected: FAIL — description is not rendered for text fields.

- [ ] **Step 3: Implement help text in SchemaForm**

In `frontend/src/components/SchemaForm.tsx`, in the enum branch add the help
element after the `</select>` (inside the `.field` div):

```tsx
              </select>
              {prop.description ? <div className="field-help">{prop.description}</div> : null}
            </div>
```

And in the default text/number branch, after the `<input ... />`:

```tsx
            />
            {prop.description ? <div className="field-help">{prop.description}</div> : null}
          </div>
```

(The boolean branch already shows the description as `.d` — leave it unchanged.)

- [ ] **Step 4: Add `.field-help` style**

In `frontend/src/styles.css`, after the `.field label` rule:

```css
.field-help { font-size: 12px; color: var(--text-3); }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/components/SchemaForm.test.tsx`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/SchemaForm.tsx frontend/src/components/SchemaForm.test.tsx frontend/src/styles.css
git commit -m "feat(schemaform): render field descriptions as help text"
```

---

### Task 2: Modals show the plugin class-docstring blurb

**Files:**
- Modify: `frontend/src/components/SchemaForm.tsx` (add `description?` to `JsonSchema`)
- Modify: `frontend/src/components/DomainModal.tsx`
- Modify: `frontend/src/components/HookModal.tsx`
- Modify: `frontend/src/components/DomainModal.test.tsx`
- Modify: `frontend/src/styles.css`

**Interfaces:**
- Consumes: `JsonSchema.description` (the class docstring from the schema).

- [ ] **Step 1: Write the failing test**

Append to `frontend/src/components/DomainModal.test.tsx` inside the `describe`.
First give the fixture provider a schema description:

```typescript
  it('shows the selected provider class-docstring blurb', () => {
    const withDesc: Provider[] = [
      { key: 'duckdns', display_name: 'DuckDNS', schema: { description: 'DuckDNS provider config.' } },
    ];
    render(<DomainModal
      open providers={withDesc} editing={null}
      onClose={vi.fn()} onSave={vi.fn()} />);
    expect(screen.getByText('DuckDNS provider config.')).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/components/DomainModal.test.tsx`
Expected: FAIL — the blurb is not rendered.

- [ ] **Step 3: Add `description` to `JsonSchema`**

In `frontend/src/components/SchemaForm.tsx`:

```typescript
export interface JsonSchema {
  properties?: Record<string, SchemaProperty>;
  required?: string[];
  description?: string;
}
```

- [ ] **Step 4: Render the blurb in DomainModal**

In `frontend/src/components/DomainModal.tsx`, locate where the provider `<select>`
lives and the schema is resolved (the modal computes the selected provider's
schema for `SchemaForm`). Immediately under the provider `<select>`'s `.field`,
render:

```tsx
        {schema.description ? <p className="modal-blurb">{schema.description}</p> : null}
```

Ensure `schema` is the selected provider's schema object typed as `JsonSchema`
(cast where the modal already builds it for `SchemaForm`). Read the file first to
place the blurb after the provider picker and before `<SchemaForm .../>`.

- [ ] **Step 5: Render the blurb in HookModal**

In `frontend/src/components/HookModal.tsx`, the schema is already computed as
`const schema = (selected?.schema ?? {}) as JsonSchema;`. Under the hook
`<select>` `.field` (and before the Events block), render:

```tsx
          {schema.description ? <p className="modal-blurb">{schema.description}</p> : null}
```

- [ ] **Step 6: Add `.modal-blurb` style**

In `frontend/src/styles.css`, after `.field-help`:

```css
.modal-blurb { font-size: 12.5px; color: var(--text-3); margin: -4px 0 4px; }
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/components/DomainModal.test.tsx src/components/HookModal.test.tsx`
Expected: all PASS.

- [ ] **Step 8: Verify build, lint, and full suite**

Run:
```bash
cd frontend
npm run build
npm run lint
npx vitest run
```
Expected: build passes, no new lint errors, all tests pass.

- [ ] **Step 9: Commit**

```bash
git add frontend/src/components/SchemaForm.tsx frontend/src/components/DomainModal.tsx frontend/src/components/HookModal.tsx frontend/src/components/DomainModal.test.tsx frontend/src/styles.css
git commit -m "feat(modals): show plugin class-docstring blurb under the picker"
```

---

## Final Verification

- [ ] `cd frontend && npx vitest run` → all pass.
- [ ] Manual: open Add Hook → Router Firewall; the class docstring appears under the picker and field descriptions (where present) appear under inputs.
