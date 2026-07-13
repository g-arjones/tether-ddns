# DomainCard IPv6 Overflow Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent long IPv6 addresses from overflowing the `DomainCard` by giving the IP its own full-width row (slightly smaller mono font) and relocating the enable/disable toggle into the card footer.

**Architecture:** Pure frontend change. Move the `.switch` toggle JSX from the `.dc-ip` row into the `.dc-foot` action group in `DomainCard.tsx`, and adjust the corresponding CSS rules in `styles.css` (which contains two duplicate blocks that must both be updated).

**Tech Stack:** React 19 + TypeScript, Vitest + @testing-library/react, plain CSS.

## Global Constraints

- Do not truncate or ellipsize IP values (design principle: "show real state, don't summarize it away").
- No changes to `relTime` formatting or component props/signatures.
- `DomainCard` props unchanged: `domain`, `runtime`, `onSync`, `onEdit`, `onDelete`, `onToggle`.
- The toggle must remain `checked={domain.enabled}` and call `onToggle(domain.id)`.

---

### Task 1: Move toggle to footer and update styles

**Files:**
- Modify: `frontend/src/components/DomainCard.tsx`
- Modify: `frontend/src/styles.css` (two `.dc-ip` blocks at ≈ line 336 and ≈ line 741)
- Test: `frontend/src/components/DomainCard.test.tsx`

**Interfaces:**
- Consumes: existing `DomainCardProps` (`onToggle: (id: string) => void`, `domain.enabled`).
- Produces: no API change. DOM change: `.switch` input now lives inside `.dc-foot` (still selectable via `.switch input`); `.dc-ip` no longer contains `.switch`.

- [ ] **Step 1: Add a failing test asserting the toggle is in the footer and not in the IP row**

Add this test to `frontend/src/components/DomainCard.test.tsx` inside the `describe('DomainCard', ...)` block:

```tsx
  it('places the toggle in the footer, not the IP row', () => {
    const onToggle = vi.fn();
    const { container } = render(<DomainCard
      domain={{ id: 'a', hostname: 'home.example.com', provider: 'duckdns', record_type: 'AAAA', enabled: true }}
      runtime={{ id: 'a', status: 'synced', ip: '2001:0db8:85a3:0000:0000:8a2e:0370:7334', updated: Date.now() / 1000, message: '' }}
      onSync={vi.fn()} onEdit={vi.fn()} onDelete={vi.fn()} onToggle={onToggle} />);
    expect(container.querySelector('.dc-ip .switch')).toBeNull();
    const footSwitch = container.querySelector('.dc-foot .switch input') as HTMLInputElement;
    expect(footSwitch).toBeTruthy();
    fireEvent.click(footSwitch);
    expect(onToggle).toHaveBeenCalledWith('a');
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/components/DomainCard.test.tsx`
Expected: FAIL — `.dc-ip .switch` still exists (toggle currently in IP row), so `expect(...).toBeNull()` fails.

- [ ] **Step 3: Move the toggle JSX in `DomainCard.tsx`**

Remove the `<label className="switch">…</label>` from the `.dc-ip` block so it becomes:

```tsx
      <div className="dc-ip">
        <div>
          <div className="ip-label">Assigned {domain.record_type === 'AAAA' ? 'IPv6' : 'IPv4'}</div>
          <div className="ip-val">{runtime.ip ?? '—'}</div>
        </div>
      </div>
```

Then add the toggle as the first control in `.dc-actions` in the footer:

```tsx
        <div className="dc-actions">
          <label className="switch">
            <input type="checkbox" checked={domain.enabled} onChange={() => onToggle(domain.id)} />
            <span className="slider" />
          </label>
          <button type="button" className="act-btn" title="Force update now" onClick={() => onSync(domain.id)}>
```

- [ ] **Step 4: Update CSS in `styles.css` (both duplicate blocks)**

In **each** of the two `.dc-ip` rule blocks (≈ line 336 and ≈ line 741), replace:

```css
.dc-ip {
  display: flex; align-items: center; justify-content: space-between;
  background: var(--surface-2); border: 1px solid var(--border);
  border-radius: var(--radius-sm); padding: 12px 14px;
}
.dc-ip .ip-label { font-size: 11px; color: var(--text-3); font-weight: 600; text-transform: uppercase; letter-spacing: .5px; }
.dc-ip .ip-val { font-family: var(--mono); font-size: 15px; font-weight: 650; letter-spacing: -.3px; margin-top: 3px; }
```

with:

```css
.dc-ip {
  background: var(--surface-2); border: 1px solid var(--border);
  border-radius: var(--radius-sm); padding: 12px 14px; min-width: 0;
}
.dc-ip .ip-label { font-size: 11px; color: var(--text-3); font-weight: 600; text-transform: uppercase; letter-spacing: .5px; }
.dc-ip .ip-val { font-family: var(--mono); font-size: 13.5px; font-weight: 650; letter-spacing: -.3px; margin-top: 3px; word-break: break-all; }
```

(Note: the second block spans the `.dc-ip { … }` rule across multiple lines — match its exact formatting when editing. Remove the `display: flex; align-items: center; justify-content: space-between;` since the row no longer shares space with the toggle.)

Also add `min-width: 0` to `.dc-updated` so its text yields gracefully (defensive). In both locations the rule reads:

```css
.dc-updated { font-size: 12.5px; color: var(--text-2); display: flex; align-items: center; gap: 6px; min-width: 0; }
```

Ensure `.dc-actions` keeps `align-items: center` so the toggle aligns with the buttons:

```css
.dc-actions { display: flex; gap: 6px; align-items: center; }
```

- [ ] **Step 5: Run the DomainCard tests to verify they pass**

Run: `cd frontend && npx vitest run src/components/DomainCard.test.tsx`
Expected: PASS — all tests including the new footer-toggle test and the existing `renders a toggle switch wired to onToggle` test (selects `.switch input`, still valid).

- [ ] **Step 6: Run the full frontend test suite**

Run: `cd frontend && npx vitest run`
Expected: PASS — no regressions.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/DomainCard.tsx frontend/src/styles.css frontend/src/components/DomainCard.test.tsx
git commit -m "fix(ui): give IPv6 its own full-width row and move toggle to footer"
```

---

## Self-Review

- **Spec coverage:** IP full-width row + `min-width:0` (Step 4), font reduction to 13.5px + `word-break` (Step 4), toggle relocation to footer Layout B (Step 3), footer safety `min-width:0` on `.dc-updated` (Step 4), both duplicate CSS blocks (Step 4). All spec sections covered.
- **Placeholder scan:** none.
- **Type consistency:** no prop/type changes; toggle still `.switch input` selectable, `onToggle(domain.id)` preserved.
