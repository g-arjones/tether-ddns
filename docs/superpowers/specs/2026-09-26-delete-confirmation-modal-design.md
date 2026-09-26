# Delete confirmation modal

**Date:** 2026-09-26
**Status:** approved, ready for implementation planning

## Problem

The UI deletes three kinds of configuration: domains, hooks, and Healthchecks projects.
None of them can be undone. Secrets (provider tokens, hook secrets, Healthchecks API
keys) are masked in every API response, so the operator must paste them again after a
delete.

Today:

- Domain and project deletes are guarded by `window.confirm`. It is unstyled, cannot say
  what is lost, and does not match the app.
- Hook delete has **no guard at all**. The inline `onDelete` in `App.tsx` also has no
  `try/catch` and no toast, so a failed delete fails silently.
- `Modal` has no Escape handling and no focus management.

## Goals

- One styled confirmation dialog, used for all three deletes, that replaces
  `window.confirm`.
- The dialog says what is removed and what is left alone.
- Hook delete reports failure like the other two.
- Every `Modal` closes on Escape, moves focus into the dialog on open, and returns focus
  to the opener on close.

## Non-goals

- Guarding any other action. Run hook, force sync, the enable/disable toggle, check
  visibility, "show on overview", and settings changes can all be undone in one click.
- A guard against discarding unsaved changes in the Domain, Hook, or Project form.
- Undo, or soft delete.
- Any backend change.

## Design

### 1. `Modal` (changed)

`components/Modal.tsx` gains three behaviors. Its props do not change.

- **Escape.** An `onKeyDown` handler on the overlay calls `onClose()` when `Escape` is
  pressed, and stops propagation. Only one modal can be open at a time, because `.shell`
  is `inert` while any modal is open and the delete buttons live inside `.shell`, so
  stacking does not need handling.
- **Initial focus.** When `open` changes from `false` to `true`, an effect focuses the
  first `[data-autofocus]` element inside `.modal`. If there is none, it focuses the
  `.modal` element itself, which gets `tabIndex={-1}`. The form modals set no
  `data-autofocus`, so they focus the dialog container. That is enough for Escape to
  work and for screen readers to announce the title.
- **Focus return.** On open, the effect stores `document.activeElement`. On close, it
  focuses that element again, but only if it is still `isConnected`. After a confirmed
  delete, the row's trash button is gone, so nothing is focused.

No manual Tab trap is added. The inert `.shell` and the inert closed overlays already
keep Tab inside the open dialog, and `e2e/dashboard.spec.ts` ("the keyboard cannot
escape an open modal…") proves this.

The overlay uses `opacity` and `pointer-events` (not `visibility` or `display`), and
`inert` is removed in the same commit that sets `open`. The element is therefore
focusable when the effect runs.

### 2. `ConfirmModal` (new)

`components/ConfirmModal.tsx`:

```ts
export interface ConfirmModalProps {
  open: boolean;
  title: string;
  confirmLabel: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  children: ReactNode;
}
```

- It is built on `Modal`. `children` is the message and goes in `.modal-body`.
- The footer has **Cancel** (`btn btn-ghost`, `data-autofocus`) followed by the confirm
  button (`btn btn-danger`, text = `confirmLabel`).
- While `busy` is true, both buttons are `disabled`. The `onClose` passed to `Modal`
  (used by Escape, ✕, and backdrop clicks) does nothing, so a delete in flight cannot be
  abandoned halfway.

### 3. Wiring in App

New state:

```ts
type DeleteKind = 'domain' | 'hook' | 'project';
interface PendingDelete {
  kind: DeleteKind;
  id: string;
  title: string;        // "Delete domain"
  confirmLabel: string; // same as title
  body: ReactNode;
}
const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
const [confirmOpen, setConfirmOpen] = useState(false);
const [deleting, setDeleting] = useState(false);
```

- `pendingDelete` and `confirmOpen` are separate on purpose. Closing sets only
  `confirmOpen = false`, so the dialog keeps its text during the 200 ms fade-out instead
  of going blank. The next delete overwrites `pendingDelete`.
- The text is captured when the trash button is clicked. It is display text, not live
  data, so it is not looked up again on each render.
- `handleDelete` (domain), `handleDeleteProject`, and the hook `onDelete` each look up
  the row, build a `PendingDelete`, and set `confirmOpen = true`. If the row is not
  found, they do nothing.
- One `runPendingDelete()`:
  1. `setDeleting(true)`
  2. calls `api.deleteDomain`, `api.deleteHook`, or `api.deleteHealthchecks`, chosen by
     `kind`
  3. on success: `setConfirmOpen(false)`, info toast (`Domain deleted`, `Hook deleted`,
     `Project deleted`), `await loadConfig()`
  4. on failure: `setConfirmOpen(false)`, error toast (`Failed to delete domain` /
     `hook` / `project`)
  5. `finally`: `setDeleting(false)`
- `anyModalOpen` also includes `confirmOpen`.
- `<ConfirmModal>` is rendered as a **sibling of `.shell`**, next to the other modals.
  It must never be nested inside `.shell`, which is inert while a modal is open.
- Both `window.confirm` calls are removed.

If the row is deleted somewhere else while the dialog is open, the request returns a
404 and shows the error toast.

### 4. Dialog text

The wording is "Delete" throughout, to match the trash button's `aria-label`. Names
are shown in `<strong>`. Hook event names are literal values, so they use `<code>`
(monospace, per DESIGN.md).

| Kind | Title / confirm label | Body |
|---|---|---|
| Domain | Delete domain | **{hostname}** will stop being updated. Its settings, including credentials, are removed and must be re-entered to add it again. The DNS record at **{provider display name}** is not changed. |
| Hook | Delete hook | **{hook display name}** ({events as `code`, comma-separated, or "no events"}) will no longer run. Its settings, including any secrets, are removed and must be re-entered to add it again. |
| Project | Delete project | **{name}** will no longer be polled or shown. Its API key is removed and must be re-entered to add it again. Checks on **{hostOf(base_url)}** are not changed. |

- The provider display name comes from `providers` (`key` → `display_name`). If the
  provider is not found, it falls back to the raw key.
- The hook display name comes from `hookDefs`. If it is not found, it falls back to the
  raw `hook` key, the same way `HooksView` does.
- The project host uses the existing `hostOf()` from `utils.ts`, so self-hosted
  Healthchecks instances are named correctly.
- The text is built by pure functions in `src/deleteCopy.tsx` (`domainDeleteCopy`,
  `hookDeleteCopy`, `projectDeleteCopy`), each returning `{ title, confirmLabel, body }`.
  This keeps `App.tsx` lean and puts the text under coverage (`App.tsx` is excluded).
  `ConfirmModal` wraps `children` in `<p className="confirm-msg">`, so bodies are inline
  fragments.

## Testing

Unit (Vitest):

- `Modal.test.tsx`
  - Escape on an open modal calls `onClose`.
  - On open, focus moves to `[data-autofocus]`. Without one, focus moves to the
    `.modal` dialog.
  - On close, focus returns to the element that was focused before opening. If that
    element was removed, nothing throws and focus is not forced anywhere.
- `ConfirmModal.test.tsx`
  - Renders the title, body, and confirm label. Cancel gets focus on open.
  - Cancel calls `onCancel`. Confirm calls `onConfirm`.
  - When `busy` is set, both buttons are disabled, and Escape does not call `onCancel`.
- App tests (`App.test.tsx` or a new `App.delete.test.tsx`)
  - For each of domain, hook, and project: the trash button opens the dialog with the
    right title. Cancel makes no API call. Confirm calls the matching `api.delete*` and
    shows the "… deleted" toast.
  - A rejected `api.deleteHook` shows `Failed to delete hook`.
  - Remove any `window.confirm` stubs from existing tests.

E2E (Playwright, `e2e/dashboard.spec.ts`), because jsdom has no `inert` or real focus:

- Create a hook through the API (`page.request.post('/api/hooks-config', …)`), open the
  Hooks view, and click its trash icon: the dialog opens with **Cancel** focused. Escape
  closes it and the hook is still listed. Opening it again and clicking **Delete hook**
  removes the row.
- The existing test "the keyboard cannot reach a closed modal" must still pass with the
  fourth always-mounted overlay.

Gates: `npm test` (Vitest + oxlint), `npx tsc --noEmit -p tsconfig.app.json`, and
`npm run test:e2e`.
