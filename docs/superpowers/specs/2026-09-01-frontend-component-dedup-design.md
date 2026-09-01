# Frontend component de-duplication — shared Modal, icons, and view chrome

**Date:** 2026-09-01
**Status:** approved, ready for implementation planning

## Problem

The SPA has accumulated hand-copied markup. The counts below were measured, not
estimated.

**The modal shell exists three times.** `DomainModal`, `HookModal` and
`IncidentModal` each hand-roll the same structure: overlay `div` with the
`open` class, backdrop-click handler, `.modal`, `.modal-head` with an `h3` and a
close button, and `.modal-body`. Two of them also repeat the `.modal-foot`
Cancel/Save pair.

This is not a cosmetic problem. The `inert` / `aria-hidden` contract that keeps
a closed modal out of the tab order was added to all three components
separately, so a fourth modal starts life with that bug, and a change to the
contract has to be made in three places and cannot be verified in one.

**Icons are copied and have already drifted.** There are 37 `<svg>` elements
containing 63 `d=` path strings, of which only 44 are distinct — 19 redundant.
Every one repeats the same preamble:

```jsx
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
     strokeLinecap="round" strokeLinejoin="round">
```

Worse, the copies no longer agree. The "same" icon is drawn differently in
different files:

| icon | `DomainCard.tsx` | `HooksView.tsx` |
| --- | --- | --- |
| edit | `…L12 15l-4 1 1-4 9.5-9.5z` | `…L12 15l-4 1 1-4z` |
| delete | `M3 6h18M19 6v14a2 2 0…` | `M3 6h18M8 6V4a2 2 0…` |

Hand-copied markup cannot be kept in sync, and this is the proof.

**The same drift affects class contracts.** `.sr-text` is filled with
`<div className="t">` in `DomainModal` and `SchemaForm`, but `<span className="t">`
in `SettingsView` — one CSS rule, two different element contracts.

**Icon-only buttons disagree about accessibility.** `HooksView`'s action buttons
carry both `title` and `aria-label`; `DomainCard`'s carry only `title`, so three
controls have no accessible name. Nothing enforces the rule because there is no
shared component to enforce it in.

**Other repeated structures:** `.section-head` ×4, `.empty` state ×3,
`.act-btn` clusters ×2, and `style={{ width: 34, height: 34 }}` ×3.

**Dead CSS.** Two rules have no `.tsx` reference at all: `.modal-close`
(orphaned when the modals switched to `.icon-btn` plus an inline size) and
`.st-paused` (`STATUS_META` only defines `synced`, `pending`, `error`,
`updating`).

## Goals

1. One definition of the modal shell, owning the `inert` / `aria-hidden`
   contract so it can be specified and tested once.
2. One definition of every icon, ending the drift.
3. An icon-only button that cannot ship without an accessible name.
4. Remove the duplicated section headers and empty states.
5. Delete the dead CSS and the inline sizing styles.
6. No visual or behavioural change anywhere else.

## Non-goals

Decided during brainstorming, explicitly out of scope:

- **Native `<dialog>`.** It would give focus trapping, Esc-to-close and inert
  for free, but it moves content to the top layer with `::backdrop`, which means
  rewriting the fade CSS and breaking the `.modal-overlay.open` selectors the
  e2e suite depends on. That is a behaviour change wearing a refactor's
  clothes; it needs its own spec and its own verification.
- **Focus trapping and Esc-to-close.** Same reason. This change restores dialog
  *semantics* only.
- **`Field` and `SwitchRow` primitives.** `.field` appears 8+ times and
  `.switch-row` 5 times, but both are thin label+control wrappers, and
  `SchemaForm` generates them dynamically from JSON Schema. Extracting them
  risks trading duplication for indirection. Revisit separately.
- **Consolidating the badge/tag CSS family** (`.status-badge`, `.reach-badge`,
  `.evt-tag`, `.inc-tag`, `.rec-type`, `.inc-chip`). These are visually similar
  but semantically distinct; merging them is a design-system decision, not a
  refactor.
- **`SettingsView`'s loading block** (`<div className="empty"><p>Loading…</p></div>`).
  It reuses the `.empty` class but is a loading state, not an empty state. It
  stays as-is rather than being forced through `EmptyState`.
- **Moving `DomainCard`'s local `relTime`.** Noted during the audit as a
  near-duplicate of `utils.relStable`, and it calls `Date.now()` internally
  rather than taking an injectable clock. Real, but it is logic cleanup rather
  than component de-duplication. Separate change.

## Design

### `components/Modal.tsx`

```tsx
export interface ModalProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}
```

Renders the overlay, the `role="dialog"` box, the head with the title and close
button, the body, and `.modal-foot` only when `footer` is supplied
(`IncidentModal` has no footer):

```tsx
const titleId = useId();

<div
  className={`modal-overlay${open ? ' open' : ''}`}
  inert={!open}
  aria-hidden={open ? undefined : true}
  onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
>
  <div className="modal" role="dialog" aria-modal="true" aria-labelledby={titleId}>
    <div className="modal-head">
      <h3 id={titleId}>{title}</h3>
      <IconButton label="Close" onClick={onClose}><IconClose /></IconButton>
    </div>
    <div className="modal-body">{children}</div>
    {footer ? <div className="modal-foot">{footer}</div> : null}
  </div>
</div>
```

`role`/`aria-modal`/`aria-labelledby` are new — the HTML mockup specified them
and the React port dropped them. They go on `.modal`, not the overlay, because
the dialog is the box.

`IncidentModal` is driven by `bucket: DayBucket | null`, so it passes
`open={bucket !== null}` and keeps its own null-guard for the body content.

### `components/icons.tsx`

An internal `Svg` wrapper holds the shared preamble; each icon is a named
export. Icons take **no size prop** — the stylesheet already sizes them by
context (`.icon-btn svg` 18px, `.act-btn svg` 15px, `.btn svg` 16px,
`.empty svg` 46px), so adding sizing props would introduce a second source of
truth. `strokeWidth` stays overridable for the 2.5 (button plus) and 1.5 (empty
state) cases, and a filled variant covers the solid play triangle.

All icons move, not only the duplicated ones: the repeated element is the
37-times-copied preamble, and a half-migrated module invites new copies.

The drifted edit and delete glyphs are reconciled to one canonical path each.
This is a deliberate, visible pixel change to whichever call site loses — it is
called out here so it is not mistaken for a regression during review.

### `components/IconButton.tsx`

```tsx
export interface IconButtonProps {
  label: string;                 // emitted as BOTH aria-label and title
  onClick: () => void;
  children: ReactNode;           // the icon
  variant?: 'icon' | 'act';      // .icon-btn chrome vs .act-btn card actions
  danger?: boolean;              // .act-btn.danger
}
```

Defaults to `variant="icon"`, which is what `Modal` relies on for its close
button. Always emits `type="button"`, matching every call site being replaced
and avoiding accidental form submission.

A single `label` prop emitting both attributes is the point: it makes the
missing-accessible-name bug in `DomainCard` unrepresentable.

### `components/SectionHeader.tsx`

```tsx
export interface SectionHeaderProps {
  title: string;
  count?: { n: number; noun: string };   // "3 records" / "1 hook"
  action?: ReactNode;
}
```

Rendering `.section-head` + `h3` + optional `.count-badge` + `.spacer` +
optional action. The `count` shape also absorbs the duplicated pluralisation
(`count === 1 ? 'record' : 'records'` and its hook twin); both nouns are
regular plurals, so `${n} ${noun}${n === 1 ? '' : 's'}` is sufficient.

### `components/EmptyState.tsx`

```tsx
export interface EmptyStateProps {
  icon: ReactNode;
  title: string;
  children?: ReactNode;
}
```

### CSS changes — `styles.css`

- Delete `.st-paused` (dead).
- Delete `.modal-close` (dead) and replace it with
  `.modal-head .icon-btn { width: 34px; height: 34px; }`, which removes the
  three inline `style={{ width: 34, height: 34 }}` props.

## Constraints

**Every existing class name stays byte-identical.** This refactor moves markup;
it does not rename anything. The e2e suite selects `.modal-overlay.open`,
`.modal`, `.modal-foot` and `.day-strip button`, and the component tests select
`.modal-overlay`, `.inc-track b.future` and similar.

The `will-change: transform` fix on `.modal` and the `inert` contract are
preserved exactly — consolidated, not altered.

## Testing

The strongest evidence of behaviour preservation is that the **existing 160 unit
tests and 12 e2e tests pass unchanged**. Any edit to an existing assertion must
be justified in review, since it would mean behaviour moved.

New tests:

- `Modal` — attribute contract in both states (`inert` and `aria-hidden` when
  closed, absent when open), `role="dialog"` with `aria-labelledby` resolving to
  the title, backdrop click closes but a body click does not, `.modal-foot`
  absent when `footer` is omitted.
- `IconButton` — always exposes an accessible name; `danger` maps to
  `.act-btn.danger`.
- `SectionHeader` — singular/plural boundary at `n === 1`.

Two risks that jsdom cannot cover, per prior incidents in this repo:

- `.empty` is a global utility carrying `padding: 60px 20px`; a component that
  applies it to the wrong element silently inflates layout, and jsdom has no
  layout engine. The existing e2e geometry test is the guard.
- The modal compositing-layer test guards the `will-change` fix.

## Implementation order

Each step lands green before the next begins.

1. `icons.tsx`; migrate all call sites; reconcile the drifted edit/delete paths.
2. `IconButton.tsx`; migrate `.act-btn` clusters in `DomainCard` and `HooksView`.
3. `Modal.tsx`; migrate `DomainModal`, `HookModal`, `IncidentModal`.
4. `SectionHeader.tsx` and `EmptyState.tsx`; migrate `DomainsView`, `HooksView`,
   `SettingsView`'s header.
5. CSS cleanup: delete the two dead rules, add the `.modal-head .icon-btn` size
   rule, remove the inline styles.

## Verification gates

Per repository conventions, `npm test` does **not** type-check, so each step
runs:

```
npm test                                  # vitest + oxlint
npx tsc --noEmit -p tsconfig.app.json
npx playwright test
```
