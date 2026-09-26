# Delete Confirmation Modal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `window.confirm` (domain, project) and the unguarded hook delete with one styled `ConfirmModal`, and give every `Modal` Escape-to-close plus focus management.

**Architecture:** `Modal` gains an overlay `onKeyDown` (Escape) and a `useEffect` keyed on `open` that focuses `[data-autofocus]` (or the dialog) and restores focus to the opener. A new `ConfirmModal` composes `Modal` with a Cancel/danger footer. Dialog copy is built by pure functions in `src/deleteCopy.tsx`. `App.tsx` holds `pendingDelete` + `confirmOpen` + `deleting` and one `runPendingDelete()`.

**Tech Stack:** React 19, TypeScript, Vite, Vitest + Testing Library (jsdom), Playwright, oxlint.

**Spec:** `docs/superpowers/specs/2026-09-26-delete-confirmation-modal-design.md`

## Global Constraints

- All work is in `frontend/`. Run every command from `frontend/`.
- Gates after EVERY task: `npm test` (runs oxlint as `pretest`, then Vitest) AND `npx tsc --noEmit -p tsconfig.app.json`. `npm test` does NOT type-check.
- Wording is "Delete" throughout (matches the trash button `aria-label="Delete"`). Toasts: `Domain deleted` / `Hook deleted` / `Project deleted` (kind `info`); `Failed to delete domain` / `hook` / `project` (kind `error`).
- Every modal (including `ConfirmModal`) stays a **sibling of `.shell`** in `App.tsx`, never nested inside it.
- Use `aria-hidden={open ? undefined : true}` — never `{!open}` (React renders `"false"`).
- Monospace (`<code>`, `var(--mono)`) only for literal values (hook event keys).
- Comments: one short line, only for what the code cannot show.
- Do not use the global `.empty` CSS class.

---

### Task 1: `Modal` — Escape and focus management

**Files:**
- Modify: `frontend/src/components/Modal.tsx`
- Modify: `frontend/src/styles.css` (after the `.modal-overlay.open .modal` rule, ~line 567)
- Test: `frontend/src/components/Modal.test.tsx`

**Interfaces:**
- Consumes: nothing new.
- Produces: `Modal` props are UNCHANGED (`{open, title, onClose, children, footer?}`). New behavior: Escape on the overlay calls `onClose`; on open, focuses the first `[data-autofocus]` inside `.modal`, else `.modal` itself (`tabIndex={-1}`); on close/unmount, re-focuses the previously focused element if `isConnected`.

- [ ] **Step 1: Write the failing tests**

Append inside the existing `describe('Modal', …)` block in `frontend/src/components/Modal.test.tsx`:

```tsx
  it('closes on Escape', () => {
    const onClose = vi.fn();
    render(<Modal open title="Add Domain" onClose={onClose}><p>body</p></Modal>);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('ignores other keys', () => {
    const onClose = vi.fn();
    render(<Modal open title="Add Domain" onClose={onClose}><p>body</p></Modal>);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Enter' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('focuses the [data-autofocus] element on open', () => {
    const { rerender } = render(
      <Modal open={false} title="Confirm" onClose={vi.fn()}><button data-autofocus>Cancel</button></Modal>,
    );
    rerender(<Modal open title="Confirm" onClose={vi.fn()}><button data-autofocus>Cancel</button></Modal>);
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
  });

  it('focuses the dialog itself when nothing asks for autofocus', () => {
    const { rerender } = render(<Modal open={false} title="Day" onClose={vi.fn()}><p>body</p></Modal>);
    rerender(<Modal open title="Day" onClose={vi.fn()}><p>body</p></Modal>);
    expect(screen.getByRole('dialog')).toHaveFocus();
  });

  it('returns focus to the opener on close', () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    const { rerender } = render(<Modal open title="Day" onClose={vi.fn()}><p>body</p></Modal>);
    expect(opener).not.toHaveFocus();

    rerender(<Modal open={false} title="Day" onClose={vi.fn()}><p>body</p></Modal>);
    expect(opener).toHaveFocus();
    opener.remove();
  });

  it('does not throw when the opener is gone by the time it closes', () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    const { rerender } = render(<Modal open title="Day" onClose={vi.fn()}><p>body</p></Modal>);
    opener.remove();

    expect(() => rerender(<Modal open={false} title="Day" onClose={vi.fn()}><p>body</p></Modal>)).not.toThrow();
    expect(opener).not.toHaveFocus();
  });
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run src/components/Modal.test.tsx`
Expected: 4 tests FAIL (`closes on Escape`, both autofocus tests, `returns focus to the opener on close`). `ignores other keys` and `does not throw…` already pass.

- [ ] **Step 3: Implement**

Replace `frontend/src/components/Modal.tsx` with:

```tsx
import { useEffect, useId, useRef, type JSX, type ReactNode } from 'react';
import { IconButton } from './IconButton';
import { IconClose } from './icons';

export interface ModalProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}

// The overlay stays mounted while closed so the fade has something to animate;
// `inert` + `aria-hidden` are what keep the closed form out of the tab order.
export function Modal({ open, title, onClose, children, footer }: ModalProps): JSX.Element {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    (dialog?.querySelector<HTMLElement>('[data-autofocus]') ?? dialog)?.focus();
    return () => {
      if (opener?.isConnected) opener.focus();
    };
  }, [open]);

  return (
    <div
      className={`modal-overlay${open ? ' open' : ''}`}
      inert={!open}
      aria-hidden={open ? undefined : true}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        e.stopPropagation();
        onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className="modal-head">
          <h3 id={titleId}>{title}</h3>
          <IconButton label="Close" onClick={onClose}><IconClose /></IconButton>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>
  );
}
```

In `frontend/src/styles.css`, directly after the line `.modal-overlay.open .modal { transform: none; }` add:

```css
/* The dialog is focused programmatically on open; it is not an interactive control. */
.modal:focus { outline: none; }
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run src/components/Modal.test.tsx`
Expected: all Modal tests PASS.

- [ ] **Step 5: Run the gates**

Run: `npm test && npx tsc --noEmit -p tsconfig.app.json`
Expected: oxlint clean, all Vitest suites PASS (DomainModal/HookModal/ProjectModal/IncidentModal suites must be unaffected), tsc exits 0.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/Modal.tsx frontend/src/components/Modal.test.tsx frontend/src/styles.css
git commit -m "feat(modal): close on Escape, focus on open, restore focus on close"
```

---

### Task 2: `ConfirmModal` and delete copy

**Files:**
- Create: `frontend/src/components/ConfirmModal.tsx`
- Create: `frontend/src/components/ConfirmModal.test.tsx`
- Create: `frontend/src/deleteCopy.tsx`
- Create: `frontend/src/deleteCopy.test.tsx`
- Modify: `frontend/src/styles.css` (after the `.modal-blurb` rule, ~line 572)

**Interfaces:**
- Consumes (Task 1): `Modal` from `./Modal` with props `{open, title, onClose, children, footer?}`; `Modal` focuses `[data-autofocus]` on open.
- Consumes (existing): `hostOf(url: string): string` from `frontend/src/utils.ts`; types `DomainConfig`, `HookConfig`, `HookDef`, `Provider`, `HealthchecksProject` from `frontend/src/types.ts`.
- Produces:
  - `export interface ConfirmModalProps { open: boolean; title: string; confirmLabel: string; busy?: boolean; onConfirm: () => void; onCancel: () => void; children: ReactNode; }`
  - `export function ConfirmModal(props: ConfirmModalProps): JSX.Element` — wraps `children` in `<p className="confirm-msg">`.
  - `export interface DeleteCopy { title: string; confirmLabel: string; body: ReactNode; }`
  - `export function domainDeleteCopy(domain: DomainConfig, providers: Provider[]): DeleteCopy`
  - `export function hookDeleteCopy(hook: HookConfig, hookDefs: HookDef[]): DeleteCopy`
  - `export function projectDeleteCopy(project: HealthchecksProject): DeleteCopy`

- [ ] **Step 1: Write the failing `ConfirmModal` tests**

Create `frontend/src/components/ConfirmModal.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ConfirmModal } from './ConfirmModal';

function setup(busy = false) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  const { rerender } = render(
    <ConfirmModal open={false} title="Delete hook" confirmLabel="Delete hook"
      onConfirm={onConfirm} onCancel={onCancel}>body text</ConfirmModal>,
  );
  rerender(
    <ConfirmModal open title="Delete hook" confirmLabel="Delete hook" busy={busy}
      onConfirm={onConfirm} onCancel={onCancel}>body text</ConfirmModal>,
  );
  return { onConfirm, onCancel };
}

describe('ConfirmModal', () => {
  it('renders the title, message and confirm label, and focuses Cancel', () => {
    setup();
    expect(screen.getByRole('dialog', { name: 'Delete hook' })).toBeInTheDocument();
    expect(screen.getByText('body text')).toHaveClass('confirm-msg');
    expect(screen.getByRole('button', { name: 'Delete hook' })).toHaveClass('btn-danger');
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
  });

  it('wires Cancel and Confirm to their callbacks', () => {
    const { onConfirm, onCancel } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Delete hook' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('cancels on Escape', () => {
    const { onCancel } = setup();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('locks both buttons and ignores Escape and Close while busy', () => {
    const { onCancel } = setup(true);
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Delete hook' })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onCancel).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Write the failing `deleteCopy` tests**

Create `frontend/src/deleteCopy.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { domainDeleteCopy, hookDeleteCopy, projectDeleteCopy } from './deleteCopy';
import type { DomainConfig, HealthchecksProject, HookConfig } from './types';

const text = (body: ReactNode) => render(<p>{body}</p>).container.textContent;

const domain: DomainConfig = {
  id: 'd1', hostname: 'home.example.com', provider: 'cloudflare', record_type: 'A', enabled: true,
};
const hook: HookConfig = { id: 'h1', hook: 'log', events: ['ip_changed', 'update_failed'] };
const project: HealthchecksProject = {
  id: 'p1', name: 'Homelab', base_url: 'https://hc.example.net/', api_key: '****',
  poll_interval: 60, show_on_overview: true, fetched_at: null, checks: [],
};

describe('domainDeleteCopy', () => {
  it('names the hostname and the provider it leaves untouched', () => {
    const copy = domainDeleteCopy(domain, [{ key: 'cloudflare', display_name: 'Cloudflare', schema: {} }]);
    expect(copy.title).toBe('Delete domain');
    expect(copy.confirmLabel).toBe('Delete domain');
    expect(text(copy.body)).toBe(
      'home.example.com will stop being updated. Its settings, including credentials, are ' +
      'removed and must be re-entered to add it again. The DNS record at Cloudflare is not changed.',
    );
  });

  it('falls back to the raw provider key', () => {
    expect(text(domainDeleteCopy(domain, []).body)).toContain('The DNS record at cloudflare is not changed.');
  });
});

describe('hookDeleteCopy', () => {
  it('names the hook and lists its events as code', () => {
    const copy = hookDeleteCopy(hook, [{ key: 'log', display_name: 'Log Event', events: [], schema: {} }]);
    expect(copy.title).toBe('Delete hook');
    expect(copy.confirmLabel).toBe('Delete hook');
    expect(text(copy.body)).toBe(
      'Log Event (ip_changed, update_failed) will no longer run. Its settings, including any ' +
      'secrets, are removed and must be re-entered to add it again.',
    );
    const { container } = render(<p>{copy.body}</p>);
    expect([...container.querySelectorAll('code')].map((c) => c.textContent)).toEqual(['ip_changed', 'update_failed']);
  });

  it('falls back to the raw hook key and says when there are no events', () => {
    expect(text(hookDeleteCopy({ ...hook, events: [] }, []).body)).toMatch(/^log \(no events\) will no longer run\./);
  });
});

describe('projectDeleteCopy', () => {
  it('names the project and the host whose checks it leaves untouched', () => {
    const copy = projectDeleteCopy(project);
    expect(copy.title).toBe('Delete project');
    expect(copy.confirmLabel).toBe('Delete project');
    expect(text(copy.body)).toBe(
      'Homelab will no longer be polled or shown. Its API key is removed and must be re-entered ' +
      'to add it again. Checks on hc.example.net are not changed.',
    );
  });
});
```

- [ ] **Step 3: Run the tests and confirm they fail**

Run: `npx vitest run src/components/ConfirmModal.test.tsx src/deleteCopy.test.tsx`
Expected: FAIL — cannot resolve `./ConfirmModal` / `./deleteCopy`.

- [ ] **Step 4: Implement `ConfirmModal`**

Create `frontend/src/components/ConfirmModal.tsx`:

```tsx
import type { JSX, ReactNode } from 'react';
import { Modal } from './Modal';

export interface ConfirmModalProps {
  open: boolean;
  title: string;
  confirmLabel: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  children: ReactNode;
}

export function ConfirmModal({
  open, title, confirmLabel, busy = false, onConfirm, onCancel, children,
}: ConfirmModalProps): JSX.Element {
  const footer = (
    <>
      <button type="button" className="btn btn-ghost" data-autofocus disabled={busy} onClick={onCancel}>
        Cancel
      </button>
      <button type="button" className="btn btn-danger" disabled={busy} onClick={onConfirm}>
        {confirmLabel}
      </button>
    </>
  );
  // A delete in flight cannot be abandoned halfway.
  const close = busy ? () => undefined : onCancel;
  return (
    <Modal open={open} title={title} onClose={close} footer={footer}>
      <p className="confirm-msg">{children}</p>
    </Modal>
  );
}
```

- [ ] **Step 5: Implement `deleteCopy`**

Create `frontend/src/deleteCopy.tsx`. Note: JSX joins text split across lines with ONE space, so only the `{' '}` before an element on the next line is needed.

```tsx
import { Fragment, type ReactNode } from 'react';
import type { DomainConfig, HealthchecksProject, HookConfig, HookDef, Provider } from './types';
import { hostOf } from './utils';

export interface DeleteCopy {
  title: string;
  confirmLabel: string;
  body: ReactNode;
}

export function domainDeleteCopy(domain: DomainConfig, providers: Provider[]): DeleteCopy {
  const provider = providers.find((p) => p.key === domain.provider)?.display_name ?? domain.provider;
  return {
    title: 'Delete domain',
    confirmLabel: 'Delete domain',
    body: (
      <>
        <strong>{domain.hostname}</strong> will stop being updated. Its settings, including
        credentials, are removed and must be re-entered to add it again. The DNS record at{' '}
        <strong>{provider}</strong> is not changed.
      </>
    ),
  };
}

export function hookDeleteCopy(hook: HookConfig, hookDefs: HookDef[]): DeleteCopy {
  const name = hookDefs.find((d) => d.key === hook.hook)?.display_name ?? hook.hook;
  const events = hook.events.length === 0
    ? 'no events'
    : hook.events.map((e, i) => (
      <Fragment key={e}>{i > 0 ? ', ' : ''}<code>{e}</code></Fragment>
    ));
  return {
    title: 'Delete hook',
    confirmLabel: 'Delete hook',
    body: (
      <>
        <strong>{name}</strong> ({events}) will no longer run. Its settings, including any
        secrets, are removed and must be re-entered to add it again.
      </>
    ),
  };
}

export function projectDeleteCopy(project: HealthchecksProject): DeleteCopy {
  return {
    title: 'Delete project',
    confirmLabel: 'Delete project',
    body: (
      <>
        <strong>{project.name}</strong> will no longer be polled or shown. Its API key is removed
        and must be re-entered to add it again. Checks on{' '}
        <strong>{hostOf(project.base_url)}</strong> are not changed.
      </>
    ),
  };
}
```

`hostOf` (`frontend/src/utils.ts:230`) returns `new URL(url).host`, so `https://hc.example.net/` → `hc.example.net`.

- [ ] **Step 6: Add the message styles**

In `frontend/src/styles.css`, directly after the `.modal-blurb { … }` line add:

```css
.confirm-msg { font-size: 14px; line-height: 1.55; color: var(--text-2); }
.confirm-msg strong { color: var(--text); font-weight: 600; }
.confirm-msg code { font-family: var(--mono); font-size: 12.5px; color: var(--text); }
```

- [ ] **Step 7: Run the tests and confirm they pass**

Run: `npx vitest run src/components/ConfirmModal.test.tsx src/deleteCopy.test.tsx`
Expected: all PASS.

- [ ] **Step 8: Run the gates**

Run: `npm test && npx tsc --noEmit -p tsconfig.app.json`
Expected: oxlint clean, all suites PASS, tsc exits 0.

- [ ] **Step 9: Commit**

```bash
git add frontend/src/components/ConfirmModal.tsx frontend/src/components/ConfirmModal.test.tsx \
  frontend/src/deleteCopy.tsx frontend/src/deleteCopy.test.tsx frontend/src/styles.css
git commit -m "feat(ui): add ConfirmModal and delete confirmation copy"
```

---

### Task 3: Wire the confirmation into App

**Files:**
- Modify: `frontend/src/App.tsx`
- Test (create): `frontend/src/App.delete.test.tsx`

**Interfaces:**
- Consumes (Task 2): `ConfirmModal` from `./components/ConfirmModal`; `DeleteCopy`, `domainDeleteCopy`, `hookDeleteCopy`, `projectDeleteCopy` from `./deleteCopy`.
- Consumes (existing): `api.deleteDomain(id)`, `api.deleteHook(id)`, `api.deleteHealthchecks(id)` — each `(id: string) => Promise<unknown>`.
- Produces: no exports. Behavior: each trash button opens `ConfirmModal`; confirm runs the delete; `window.confirm` is gone.

- [ ] **Step 1: Write the failing App tests**

Create `frontend/src/App.delete.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import App from './App';
import * as api from './api';

vi.mock('./api');
vi.mock('./useLiveState', () => ({
  useLiveState: () => ({
    snapshot: { public_ipv4: '1.2.3.4', public_ipv6: null, online: true, domains: [] },
    logs: [],
    status: 'open',
    generation: 0,
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getDomains).mockResolvedValue([
    { id: 'd1', hostname: 'home.example.com', provider: 'duckdns', record_type: 'A', enabled: true },
  ] as never);
  vi.mocked(api.getHooksConfig).mockResolvedValue([
    { id: 'h1', hook: 'log', events: ['ip_changed'], config: {} },
  ] as never);
  vi.mocked(api.getHealthchecks).mockResolvedValue([
    {
      id: 'p1', name: 'Homelab', base_url: 'https://healthchecks.io', api_key: '****',
      poll_interval: 60, show_on_overview: true, fetched_at: null, checks: [],
    },
  ] as never);
  vi.mocked(api.getSettings).mockResolvedValue({
    check_interval: 300, ip_source: 'ipify', update_on_startup: true,
    retry_on_failure: true, notify: true,
  } as never);
  vi.mocked(api.getProviders).mockResolvedValue([
    { key: 'duckdns', display_name: 'DuckDNS', schema: {} },
  ] as never);
  vi.mocked(api.getHooks).mockResolvedValue([
    { key: 'log', display_name: 'Log Event', events: [], schema: {} },
  ] as never);
  vi.mocked(api.getIpSources).mockResolvedValue([] as never);
  vi.mocked(api.getIncidents).mockResolvedValue({
    monitoring_since: 0, rev: 0, incidents: [], ongoing: null,
  } as never);
  vi.mocked(api.deleteDomain).mockResolvedValue({ ok: true } as never);
  vi.mocked(api.deleteHook).mockResolvedValue({ ok: true } as never);
  vi.mocked(api.deleteHealthchecks).mockResolvedValue({ ok: true } as never);
});

const cases = [
  { nav: /Domains/, kind: 'domain', noun: 'Domain', name: 'home.example.com', remove: () => api.deleteDomain, id: 'd1' },
  { nav: /Hooks/, kind: 'hook', noun: 'Hook', name: 'Log Event', remove: () => api.deleteHook, id: 'h1' },
  { nav: /Healthchecks/, kind: 'project', noun: 'Project', name: 'Homelab', remove: () => api.deleteHealthchecks, id: 'p1' },
] as const;

async function openConfirm(nav: RegExp, kind: string) {
  render(<App />);
  // Scoped to the rail: Overview panels may carry buttons that also match the regex.
  fireEvent.click(within(screen.getByRole('navigation')).getByRole('button', { name: nav }));
  fireEvent.click(await within(screen.getByRole('main')).findByRole('button', { name: 'Delete' }));
  return screen.getByRole('dialog', { name: `Delete ${kind}` });
}

describe('App delete confirmation', () => {
  for (const c of cases) {
    it(`asks before deleting a ${c.kind} and deletes on confirm`, async () => {
      const dialog = await openConfirm(c.nav, c.kind);
      expect(within(dialog).getByText(c.name)).toBeInTheDocument();
      expect(document.querySelector('.shell')).toHaveAttribute('inert');
      expect(c.remove()).not.toHaveBeenCalled();

      fireEvent.click(within(dialog).getByRole('button', { name: `Delete ${c.kind}` }));
      await waitFor(() => expect(c.remove()).toHaveBeenCalledWith(c.id));
      await screen.findByText(`${c.noun} deleted`);
      expect(screen.queryByRole('dialog', { name: `Delete ${c.kind}` })).toBeNull();
    });

    it(`does not delete a ${c.kind} when cancelled`, async () => {
      const dialog = await openConfirm(c.nav, c.kind);
      fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByRole('dialog', { name: `Delete ${c.kind}` })).toBeNull();
      expect(document.querySelector('.shell')).not.toHaveAttribute('inert');
      expect(c.remove()).not.toHaveBeenCalled();
    });
  }

  it('reports a failed hook delete', async () => {
    vi.mocked(api.deleteHook).mockRejectedValue(new Error('boom'));
    const dialog = await openConfirm(/Hooks/, 'hook');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete hook' }));
    await screen.findByText('Failed to delete hook');
  });

  it('names the provider in the domain dialog', async () => {
    const dialog = await openConfirm(/Domains/, 'domain');
    expect(within(dialog).getByText('DuckDNS')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run src/App.delete.test.tsx`
Expected: FAIL — no dialog named `Delete domain` / `Delete hook` / `Delete project` (domain/project currently call `window.confirm`, which jsdom does not implement; hook deletes immediately).

- [ ] **Step 3: Update imports in `App.tsx`**

Add after the `IncidentModal` import line:

```tsx
import { ConfirmModal } from './components/ConfirmModal';
```

Add after the `import { bucketByDay } from './utils';` line:

```tsx
import { domainDeleteCopy, hookDeleteCopy, projectDeleteCopy, type DeleteCopy } from './deleteCopy';
```

- [ ] **Step 4: Add the types and state**

After `type Theme = 'dark' | 'light';` add:

```tsx
type DeleteKind = 'domain' | 'hook' | 'project';
interface PendingDelete extends DeleteCopy {
  kind: DeleteKind;
  id: string;
}
```

After the line `const [selectedDayStart, setSelectedDayStart] = useState<number | null>(null);` add:

```tsx
  // Kept apart from `confirmOpen` so the text survives the close fade.
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
```

Change the `anyModalOpen` line to:

```tsx
  const anyModalOpen =
    domainModalOpen || hookModalOpen || projectModalOpen || confirmOpen || selectedDay !== null;
```

- [ ] **Step 5: Replace the delete handlers**

Replace the whole existing `handleDelete` `useCallback` (the one containing `window.confirm(\`Remove "${d.hostname}"?\`)`) with:

```tsx
  const askDelete = useCallback((kind: DeleteKind, id: string, copy: DeleteCopy) => {
    setPendingDelete({ kind, id, ...copy });
    setConfirmOpen(true);
  }, []);

  const handleDelete = useCallback(
    (id: string) => {
      const d = domains.find((x) => x.id === id);
      if (d) askDelete('domain', id, domainDeleteCopy(d, providers));
    },
    [domains, providers, askDelete],
  );

  const handleDeleteHook = useCallback(
    (id: string) => {
      const h = hooks.find((x) => x.id === id);
      if (h) askDelete('hook', id, hookDeleteCopy(h, hookDefs));
    },
    [hooks, hookDefs, askDelete],
  );
```

Replace the whole existing `handleDeleteProject` `useCallback` (the one containing `window.confirm(\`Remove "${p.name}"?\`)`) with:

```tsx
  const handleDeleteProject = useCallback(
    (id: string) => {
      const p = projects.find((x) => x.id === id);
      if (p) askDelete('project', id, projectDeleteCopy(p));
    },
    [projects, askDelete],
  );

  const runPendingDelete = useCallback(async () => {
    if (!pendingDelete) return;
    const { kind, id } = pendingDelete;
    const remove = { domain: api.deleteDomain, hook: api.deleteHook, project: api.deleteHealthchecks }[kind];
    setDeleting(true);
    try {
      await remove(id);
      setConfirmOpen(false);
      pushToast(`${kind.charAt(0).toUpperCase()}${kind.slice(1)} deleted`, 'info');
      await loadConfig();
    } catch {
      setConfirmOpen(false);
      pushToast(`Failed to delete ${kind}`, 'error');
    } finally {
      setDeleting(false);
    }
  }, [pendingDelete, loadConfig, pushToast]);
```

- [ ] **Step 6: Wire the hook view and render the dialog**

In the `<HooksView … />` JSX, replace:

```tsx
                onDelete={async (id) => {
                  await api.deleteHook(id);
                  await loadConfig();
                }}
```

with:

```tsx
                onDelete={handleDeleteHook}
```

Directly after the `<IncidentModal … />` element (and before `<Toasts … />`), add:

```tsx
      <ConfirmModal
        open={confirmOpen}
        title={pendingDelete?.title ?? ''}
        confirmLabel={pendingDelete?.confirmLabel ?? ''}
        busy={deleting}
        onConfirm={() => { void runPendingDelete(); }}
        onCancel={() => setConfirmOpen(false)}
      >
        {pendingDelete?.body}
      </ConfirmModal>
```

- [ ] **Step 7: Confirm `window.confirm` is gone**

Run: `grep -rn "window.confirm" src/`
Expected: no output.

- [ ] **Step 8: Run the tests and confirm they pass**

Run: `npx vitest run src/App.delete.test.tsx`
Expected: all 8 tests PASS.

- [ ] **Step 9: Run the gates**

Run: `npm test && npx tsc --noEmit -p tsconfig.app.json`
Expected: oxlint clean, all suites PASS (including `App.test.tsx` "makes the shell inert while a modal is open…" and `App.runhook.test.tsx`), tsc exits 0.

- [ ] **Step 10: Commit**

```bash
git add frontend/src/App.tsx frontend/src/App.delete.test.tsx
git commit -m "feat(ui): confirm domain, hook and project deletes in a modal"
```

---

### Task 4: E2E — keyboard and real-browser delete flow

**Files:**
- Modify: `frontend/e2e/dashboard.spec.ts` (append after the test "the keyboard cannot escape an open modal into the rail or topbar")

**Interfaces:**
- Consumes (Tasks 1–3): the Hooks view trash button (`aria-label="Delete"` inside `.hook-row`), dialog `role="dialog"` named `Delete hook`, footer buttons `Cancel` and `Delete hook`.
- Consumes (backend): `POST /api/hooks-config` with `{ hook: 'log', events: ['ip_changed'], config: {} }`.
- Produces: nothing.

Background: e2e runs one backend per run (`workers: 1`), so earlier tests may leave hooks behind. The test therefore works on the LAST `.hook-row` (a newly created hook is appended) and asserts on the row COUNT, never an absolute number.

- [ ] **Step 1: Write the test**

Append to `frontend/e2e/dashboard.spec.ts`:

```ts
// jsdom has no real focus or `inert`, so only a browser can prove the dialog takes focus
// on its safe button and that Escape backs out without deleting.
test('deleting a hook asks for confirmation first', async ({ page }) => {
  const created = await page.request.post('/api/hooks-config', {
    data: { hook: 'log', events: ['ip_changed'], config: {} },
  });
  expect(created.ok()).toBeTruthy();

  await page.goto('/');
  await page.getByRole('button', { name: /Hooks/ }).click();
  const rows = page.locator('.hook-row');
  await expect(rows.last()).toBeVisible();
  const before = await rows.count();

  const dialog = page.getByRole('dialog', { name: 'Delete hook' });
  await rows.last().getByRole('button', { name: 'Delete' }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(rows).toHaveCount(before);

  await rows.last().getByRole('button', { name: 'Delete' }).click();
  await dialog.getByRole('button', { name: 'Delete hook' }).click();
  await expect(rows).toHaveCount(before - 1);
  await expect(dialog).toBeHidden();
});
```

- [ ] **Step 2: Run the e2e suite**

Port 8123 must be free (`ss -ltn | grep 8123` prints nothing). Then run: `npm run test:e2e`
Expected: all e2e tests PASS, including the new one and the existing "the keyboard cannot reach a closed modal" (which now also covers the always-mounted `ConfirmModal` overlay).

If the new test fails, run it alone with `npx playwright test -g "deleting a hook"` and read the trace; do not weaken assertions.

- [ ] **Step 3: Run the unit gates once more**

Run: `npm test && npx tsc --noEmit -p tsconfig.app.json`
Expected: all PASS, tsc exits 0.

- [ ] **Step 4: Commit**

```bash
git add frontend/e2e/dashboard.spec.ts
git commit -m "test(e2e): hook delete confirmation focus, Escape and confirm"
```
