# Sticky Modal Title/Footer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The modal header and footer stay fixed while only the body scrolls.

**Architecture:** CSS-only change turning `.modal` into a flex column with the body as the sole scroll region.

**Tech Stack:** CSS, React (no component change), Vitest.

## Global Constraints

- Frontend must pass `npm run lint`, `npm run build`, and `npx vitest run`.
- No markup or component-logic change. Existing modal tests must still pass.

---

### Task 1: Flex-column modal with scrollable body

**Files:**
- Modify: `frontend/src/styles.css`

- [ ] **Step 1: Update `.modal` to a flex column**

In `frontend/src/styles.css`, replace the `.modal` rule:

```css
.modal {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  width: 100%; max-width: 480px;
  max-height: 90vh;
  display: flex; flex-direction: column;
  box-shadow: var(--shadow);
  transform: translateY(12px) scale(.98);
  transition: transform var(--transition);
}
```

(Removed `overflow-y: auto;` from `.modal`; added the flex column.)

- [ ] **Step 2: Pin head/foot and make the body scroll**

Replace the `.modal-head`, `.modal-body`, and `.modal-foot` rules:

```css
.modal-head { flex: none; display: flex; align-items: center; justify-content: space-between; padding: 20px 22px; border-bottom: 1px solid var(--border); }
.modal-head h3 { font-size: 17px; font-weight: 700; }
.modal-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 22px; display: flex; flex-direction: column; gap: 16px; }
.modal-foot { flex: none; padding: 16px 22px; border-top: 1px solid var(--border); display: flex; gap: 10px; justify-content: flex-end; }
```

- [ ] **Step 3: Verify build, lint, and full suite**

Run:
```bash
cd frontend
npm run build
npm run lint
npx vitest run
```
Expected: build passes, no new lint errors, all existing tests pass (no behavior change).

- [ ] **Step 4: Commit**

```bash
git add frontend/src/styles.css
git commit -m "style(modal): sticky header/footer with scrollable body"
```

---

## Final Verification

- [ ] Manual: open the Router Firewall hook modal (long form) — header and footer stay fixed, middle scrolls. Open Add Domain (DuckDNS, short) — no unnecessary scrollbar, looks correct.
