# Frontend Component De-duplication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the three hand-copied modal shells, 36 inline `<svg>` elements and duplicated view chrome with five shared components, without changing any rendered class name or behaviour.

**Architecture:** Five new files under `frontend/src/components/`: `icons.tsx` (an internal `Svg` wrapper plus 23 named icon exports), `IconButton.tsx`, `Modal.tsx`, `SectionHeader.tsx`, `EmptyState.tsx`. Existing components become call sites. Every existing CSS class name is preserved byte-for-byte, so the current 160 unit tests and 12 e2e tests act as the behaviour-preservation proof.

**Tech Stack:** React 19.2, TypeScript 6.0, Vite 8, Vitest 4 + @testing-library/react 16, Playwright 1.61, oxlint.

**Spec:** `docs/superpowers/specs/2026-09-01-frontend-component-dedup-design.md`

## Global Constraints

- **No CSS class name may be added, renamed or removed** except the three deletions in Task 7. The e2e suite selects `.modal-overlay.open`, `.modal`, `.modal-foot`, `.day-strip button`, `.quorum span`, `.ov-grid > *`; component tests select `.modal-overlay`, `.inc-track b.future`, `.chip`, `.act-btn`.
- **Type-check gate.** `npm test` runs Vitest + oxlint and **neither type-checks**. Every task that changes a prop, signature or exported type MUST also run `npx tsc --noEmit -p tsconfig.app.json` from `frontend/`, exiting 0. A prop break otherwise passes every gate until `npm run build`.
- **Frontend coverage thresholds** (`vite.config.ts`): lines 70, statements 70, functions 50, branches 60. `src/App.tsx` and `src/main.tsx` are excluded; all new components are **not**.
- Generic CSS class names collide with global utilities in `styles.css` — `.empty` carries `padding: 60px 20px`, and jsdom has no layout engine so it cannot detect the damage. Do not invent new class names.
- The `will-change: transform` rule on `.modal` and the `inert` / `aria-hidden` pair on `.modal-overlay` are load-bearing fixes with dedicated tests. Preserve exactly.
- Icons carry **no size props**. Sizing lives in CSS: `.icon-btn svg` 18px, `.act-btn svg` 15px, `.btn svg` 16px, `.empty svg` 46px, `.t-ico svg`, `.stat-ico svg`.
- `Svg` must emit exactly `viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={n} strokeLinecap="round" strokeLinejoin="round"` — the same attributes present today. Do **not** add `aria-hidden` or `focusable` to icons in this plan; that is a separate behavioural change.
- All commits use Conventional Commits, matching repo history (`feat(modals):`, `refactor(icons):`, `test(modal):`).

---

### Task 1: Icon module

**Files:**
- Create: `frontend/src/components/icons.tsx`
- Create: `frontend/src/components/icons.test.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces: `export interface IconProps { strokeWidth?: number }` and 23 components, each `(props: IconProps) => JSX.Element`: `IconClose`, `IconRefresh`, `IconInfo`, `IconGlobe`, `IconHook`, `IconPlus`, `IconEdit`, `IconTrash`, `IconChevronDown`, `IconCheck`, `IconSuccess`, `IconError`, `IconDashboard`, `IconLogs`, `IconSettings`, `IconMoon`, `IconSun`, `IconMenu`, `IconPlay`, `IconSearch`, `IconCheckCircle`, `IconAlertTriangle`, `IconClock`.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/components/icons.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { IconClose, IconPlus, IconPlay, IconGlobe } from './icons';

describe('icons', () => {
  it('emits the shared svg preamble', () => {
    const { container } = render(<IconClose />);
    const svg = container.querySelector('svg');
    expect(svg).toHaveAttribute('viewBox', '0 0 24 24');
    expect(svg).toHaveAttribute('fill', 'none');
    expect(svg).toHaveAttribute('stroke', 'currentColor');
    expect(svg).toHaveAttribute('stroke-width', '2');
    expect(svg).toHaveAttribute('stroke-linecap', 'round');
    expect(svg).toHaveAttribute('stroke-linejoin', 'round');
  });

  it('honours a stroke width override', () => {
    const { container } = render(<IconPlus strokeWidth={2.5} />);
    expect(container.querySelector('svg')).toHaveAttribute('stroke-width', '2.5');
  });

  it('renders the solid play glyph filled rather than stroked', () => {
    const { container } = render(<IconPlay />);
    const svg = container.querySelector('svg');
    expect(svg).toHaveAttribute('fill', 'currentColor');
    expect(svg).toHaveAttribute('stroke', 'none');
  });

  it('draws the globe as a circle plus meridians', () => {
    const { container } = render(<IconGlobe />);
    expect(container.querySelector('circle')).toHaveAttribute('r', '10');
    expect(container.querySelectorAll('path')).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run from `frontend/`: `npx vitest run src/components/icons.test.tsx`
Expected: FAIL — `Failed to resolve import "./icons"`.

- [ ] **Step 3: Write the implementation**

Create `frontend/src/components/icons.tsx`. Paths are copied verbatim from the current call sites; the three drift reconciliations are marked and are resolved in Task 2.

```tsx
import type { JSX, ReactNode } from 'react';

export interface IconProps {
  strokeWidth?: number;
}

function Svg({ strokeWidth = 2, children }: IconProps & { children: ReactNode }): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

export function IconClose(p: IconProps): JSX.Element {
  return <Svg {...p}><path d="M18 6 6 18M6 6l12 12" /></Svg>;
}

export function IconRefresh(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M23 4v6h-6M1 20v-6h6" />
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
    </Svg>
  );
}

export function IconInfo(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4M12 8h.01" />
    </Svg>
  );
}

// Canonical globe. Rail's brand logo previously drew the same circle as a path
// (`M12 2a10 10 0 1 0 0 20…`); it adopts this encoding in Task 3.
export function IconGlobe(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="10" />
      <path d="M2 12h20M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20z" />
    </Svg>
  );
}

// Canonical hook: the six-element drawing. HooksView's row icon previously
// omitted `M4 16…` and the anchor circle; it adopts this drawing in Task 2.
export function IconHook(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M4 10a10 10 0 0 1 10 10" />
      <path d="M4 16a4 4 0 0 1 4 4" />
      <circle cx="5" cy="19" r="1" />
      <path d="m12 10 4-4a2.83 2.83 0 0 1 4 4l-4 4" />
      <path d="m14 8 3 3" />
      <path d="m9 15 3 3" />
    </Svg>
  );
}

export function IconPlus(p: IconProps): JSX.Element {
  return <Svg {...p}><path d="M12 5v14M5 12h14" /></Svg>;
}

// Canonical edit (Lucide `square-pen`). DomainCard previously appended an extra
// `9.5-9.5z` segment; it adopts this path in Task 2.
export function IconEdit(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z" />
    </Svg>
  );
}

// Canonical trash (Lucide `trash-2`). HooksView previously used a differently
// ordered path; it adopts this one in Task 2.
export function IconTrash(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </Svg>
  );
}

export function IconChevronDown(p: IconProps): JSX.Element {
  return <Svg {...p}><path d="m6 9 6 6 6-6" /></Svg>;
}

export function IconCheck(p: IconProps): JSX.Element {
  return <Svg {...p}><path d="m5 12 5 5L20 7" /></Svg>;
}

export function IconSuccess(p: IconProps): JSX.Element {
  return <Svg {...p}><path d="M20 6 9 17l-5-5" /></Svg>;
}

export function IconError(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="10" />
      <path d="M15 9l-6 6M9 9l6 6" />
    </Svg>
  );
}

export function IconDashboard(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <rect x="3" y="3" width="7" height="9" />
      <rect x="14" y="3" width="7" height="5" />
      <rect x="14" y="12" width="7" height="9" />
      <rect x="3" y="16" width="7" height="5" />
    </Svg>
  );
}

export function IconLogs(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M4 4h16v16H4z" />
      <path d="M8 8h8M8 12h8M8 16h5" />
    </Svg>
  );
}

export function IconSettings(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </Svg>
  );
}

export function IconMoon(p: IconProps): JSX.Element {
  return <Svg {...p}><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" /></Svg>;
}

export function IconSun(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="5" />
      <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
    </Svg>
  );
}

export function IconMenu(p: IconProps): JSX.Element {
  return <Svg {...p}><path d="M3 12h18M3 6h18M3 18h18" /></Svg>;
}

// Solid glyph: overrides the stroked preamble rather than using Svg.
export function IconPlay(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" stroke="none">
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

export function IconSearch(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </Svg>
  );
}

export function IconCheckCircle(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
      <path d="M22 4 12 14.01l-3-3" />
    </Svg>
  );
}

export function IconAlertTriangle(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <path d="M12 9v4M12 17h.01" />
    </Svg>
  );
}

export function IconClock(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v6l4 2" />
    </Svg>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/icons.test.tsx`
Expected: PASS, 4 tests.

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit -p tsconfig.app.json`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/icons.tsx frontend/src/components/icons.test.tsx
git commit -m "refactor(icons): add shared icon module"
```

---

### Task 2: Migrate the drifted icon call sites

Reconciles the three glyph pairs that have diverged. This is the only task with an intended visual change.

**Files:**
- Modify: `frontend/src/components/DomainCard.tsx:64-73`
- Modify: `frontend/src/views/HooksView.tsx:29-32`, `:36-44`, `:58-61`, `:67-75`, `:95-118`
- Modify: `frontend/src/views/DomainsView.tsx:33-36`, `:41-45`

**Interfaces:**
- Consumes: `IconRefresh`, `IconEdit`, `IconTrash`, `IconPlus`, `IconHook`, `IconGlobe`, `IconPlay` from `./icons` / `../components/icons`.
- Produces: no API change. `DomainCard` and `HooksView` keep identical props.

- [ ] **Step 1: Confirm the current tests pass before touching anything**

Run: `npx vitest run src/components/DomainCard.test.tsx src/views/HooksView.test.tsx src/views/DomainsView.test.tsx`
Expected: PASS. Record the counts; they must not change.

- [ ] **Step 2: Replace the icons in `DomainCard.tsx`**

Add to the imports:

```tsx
import { IconEdit, IconRefresh, IconTrash } from './icons';
```

Replace the three `<svg>` children inside `.dc-actions` (lines 64–73) so the buttons read:

```tsx
          <button type="button" className="act-btn" title="Force update now" onClick={() => onSync(domain.id)}>
            <IconRefresh />
          </button>
          <button type="button" className="act-btn" title="Edit" onClick={() => onEdit(domain.id)}>
            <IconEdit />
          </button>
          <button type="button" className="act-btn danger" title="Delete" onClick={() => onDelete(domain.id)}>
            <IconTrash />
          </button>
```

The edit glyph loses its extra `9.5-9.5z` segment — intended, per Task 1.

- [ ] **Step 3: Replace the icons in `HooksView.tsx`**

Add to the imports:

```tsx
import { IconEdit, IconHook, IconPlay, IconPlus, IconTrash } from '../components/icons';
```

Then substitute, keeping all surrounding markup and class names untouched:

| Line | Replace the `<svg>` with |
| --- | --- |
| 30 | `<IconPlus strokeWidth={2.5} />` |
| 37 | `<IconHook strokeWidth={1.5} />` |
| 58 | `<IconPlus strokeWidth={2.5} />` |
| 68 | `<IconHook />` |
| 96 | `<IconPlay />` |
| 106 | `<IconEdit />` |
| 117 | `<IconTrash />` |

Line 68's hook glyph gains the two missing elements and line 117's trash path is reordered — both intended, per Task 1.

- [ ] **Step 4: Replace the icons in `DomainsView.tsx`**

Add to the imports:

```tsx
import { IconGlobe, IconPlus } from '../components/icons';
```

Line 34 becomes `<IconPlus strokeWidth={2.5} />`; line 42 becomes `<IconGlobe strokeWidth={1.5} />`.

- [ ] **Step 5: Run the affected tests and the type-check**

Run: `npx vitest run src/components/DomainCard.test.tsx src/views/HooksView.test.tsx src/views/DomainsView.test.tsx && npx tsc --noEmit -p tsconfig.app.json`
Expected: PASS with the same counts as Step 1, and tsc exit 0. If any assertion needed changing, stop — that means behaviour moved.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/DomainCard.tsx frontend/src/views/HooksView.tsx frontend/src/views/DomainsView.tsx
git commit -m "refactor(icons): reconcile drifted edit, trash and hook glyphs"
```

---

### Task 3: Migrate the remaining icon call sites

**Files:**
- Modify: `frontend/src/layout/Rail.tsx:51-63`
- Modify: `frontend/src/layout/TopBar.tsx:19-40`, `:56-61`
- Modify: `frontend/src/components/Toasts.tsx:19-27`
- Modify: `frontend/src/components/Select.tsx:64`, `:77`
- Modify: `frontend/src/views/LogsView.tsx:36`
- Modify: `frontend/src/views/OverviewView.tsx:51-78`
- Modify: `frontend/src/components/DomainModal.tsx:61`, `HookModal.tsx:57`, `IncidentModal.tsx:52`

**Interfaces:**
- Consumes: all 23 exports from Task 1.
- Produces: no API change anywhere.

- [ ] **Step 1: Substitute every remaining inline `<svg>`**

Keep all wrapping elements, class names and props exactly as they are; replace only the `<svg>…</svg>` node.

| File:line | Replacement |
| --- | --- |
| `Rail.tsx:52` (overview) | `<IconDashboard />` |
| `Rail.tsx:53` (domains) | `<IconGlobe />` |
| `Rail.tsx:54` (hooks) | `<IconHook />` |
| `Rail.tsx:55` (logs) | `<IconLogs />` |
| `Rail.tsx:56` (settings) | `<IconSettings />` |
| `Rail.tsx:57` (about) | `<IconInfo />` |
| `Rail.tsx:63` (brand logo) | `<IconGlobe />` |
| `TopBar.tsx:20` (`moonSvg`) | `<IconMoon />` |
| `TopBar.tsx:26` (`sunSvg`) | `<IconSun />` |
| `TopBar.tsx:36` (rail toggle) | `<IconMenu />` |
| `TopBar.tsx:57` (refresh) | `<IconRefresh />` |
| `Toasts.tsx:21` (success) | `<IconSuccess strokeWidth={2.5} />` |
| `Toasts.tsx:24` (error) | `<IconError strokeWidth={2.5} />` |
| `Toasts.tsx:26` (info) | `<IconInfo strokeWidth={2.5} />` |
| `Select.tsx:64` (caret) | `<IconChevronDown />` |
| `Select.tsx:77` (tick) | `<IconCheck strokeWidth={2.5} />` |
| `LogsView.tsx:36` (search) | `<IconSearch />` |
| `OverviewView.tsx:52` (`globeIcon`) | `<IconGlobe />` |
| `OverviewView.tsx:59` (`checkIcon`) | `<IconCheckCircle />` |
| `OverviewView.tsx:66` (`warnIcon`) | `<IconAlertTriangle />` |
| `OverviewView.tsx:73` (`clockIcon`) | `<IconClock />` |
| `DomainModal.tsx:61` | `<IconClose />` |
| `HookModal.tsx:57` | `<IconClose />` |
| `IncidentModal.tsx:52` | `<IconClose />` |

In `TopBar.tsx` and `OverviewView.tsx` the icons are held in local `const` bindings (`moonSvg`, `sunSvg`, `globeIcon`, `checkIcon`, `warnIcon`, `clockIcon`). Replace each binding's value with the component element, e.g. `const moonSvg = <IconMoon />;`, leaving the usage sites alone.

`Rail.tsx:63` swaps the path-drawn circle for the canonical `IconGlobe` — visually identical, intended.

- [ ] **Step 2: Verify no raw icon markup survives outside the module**

Run from `frontend/src`:

```bash
grep -rn '<svg' --include=*.tsx . | grep -v 'components/icons'
```

Expected: no output.

- [ ] **Step 3: Run the full unit suite and the type-check**

Run from `frontend/`: `npm test && npx tsc --noEmit -p tsconfig.app.json`
Expected: 31 files / 164 tests pass (160 existing + 4 from Task 1); tsc exit 0.

- [ ] **Step 4: Run the e2e suite**

Run: `npx playwright test`
Expected: 12 passed.

- [ ] **Step 5: Commit**

```bash
git add frontend/src
git commit -m "refactor(icons): move all remaining inline svg markup into the icon module"
```

---

### Task 4: `IconButton`

**Files:**
- Create: `frontend/src/components/IconButton.tsx`
- Create: `frontend/src/components/IconButton.test.tsx`
- Modify: `frontend/src/components/DomainCard.tsx:64-73`
- Modify: `frontend/src/views/HooksView.tsx:95-118`
- Modify: `frontend/src/layout/TopBar.tsx:35-40`, `:56-61`, `:62-64`

**Interfaces:**
- Consumes: icon components from Task 1.
- Produces: `export interface IconButtonProps { label: string; onClick: () => void; children: ReactNode; variant?: 'icon' | 'act'; danger?: boolean; className?: string }` and `export function IconButton(props: IconButtonProps): JSX.Element`.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/components/IconButton.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { IconButton } from './IconButton';
import { IconTrash } from './icons';

describe('IconButton', () => {
  it('always exposes an accessible name and a tooltip from one label', () => {
    render(<IconButton label="Delete" onClick={vi.fn()}><IconTrash /></IconButton>);
    const button = screen.getByRole('button', { name: 'Delete' });
    expect(button).toHaveAttribute('title', 'Delete');
    expect(button).toHaveAttribute('type', 'button');
  });

  it('defaults to the icon-btn chrome variant', () => {
    render(<IconButton label="Close" onClick={vi.fn()}><IconTrash /></IconButton>);
    expect(screen.getByRole('button', { name: 'Close' })).toHaveClass('icon-btn');
  });

  it('renders the act variant with an optional danger modifier', () => {
    render(
      <IconButton label="Delete" variant="act" danger onClick={vi.fn()}><IconTrash /></IconButton>,
    );
    const button = screen.getByRole('button', { name: 'Delete' });
    expect(button).toHaveClass('act-btn');
    expect(button).toHaveClass('danger');
    expect(button).not.toHaveClass('icon-btn');
  });

  it('appends an extra className without dropping the variant', () => {
    render(
      <IconButton label="Refresh" className="spin" onClick={vi.fn()}><IconTrash /></IconButton>,
    );
    const button = screen.getByRole('button', { name: 'Refresh' });
    expect(button).toHaveClass('icon-btn');
    expect(button).toHaveClass('spin');
  });

  it('calls onClick', () => {
    const onClick = vi.fn();
    render(<IconButton label="Edit" onClick={onClick}><IconTrash /></IconButton>);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/IconButton.test.tsx`
Expected: FAIL — `Failed to resolve import "./IconButton"`.

- [ ] **Step 3: Write the implementation**

Create `frontend/src/components/IconButton.tsx`:

```tsx
import type { JSX, ReactNode } from 'react';

export interface IconButtonProps {
  label: string;
  onClick: () => void;
  children: ReactNode;
  variant?: 'icon' | 'act';
  danger?: boolean;
  className?: string;
}

// One `label` drives both the accessible name and the tooltip, so an icon-only
// button cannot ship without a name.
export function IconButton({
  label,
  onClick,
  children,
  variant = 'icon',
  danger = false,
  className,
}: IconButtonProps): JSX.Element {
  const classes = [variant === 'icon' ? 'icon-btn' : 'act-btn'];
  if (danger) classes.push('danger');
  if (className) classes.push(className);
  return (
    <button
      type="button"
      className={classes.join(' ')}
      title={label}
      aria-label={label}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/IconButton.test.tsx`
Expected: PASS, 5 tests.

- [ ] **Step 5: Migrate `DomainCard.tsx`**

Add `import { IconButton } from './IconButton';` and replace the three buttons in `.dc-actions`:

```tsx
          <IconButton label="Force update now" onClick={() => onSync(domain.id)} variant="act">
            <IconRefresh />
          </IconButton>
          <IconButton label="Edit" onClick={() => onEdit(domain.id)} variant="act">
            <IconEdit />
          </IconButton>
          <IconButton label="Delete" onClick={() => onDelete(domain.id)} variant="act" danger>
            <IconTrash />
          </IconButton>
```

These three gain the `aria-label` they were missing.

- [ ] **Step 6: Migrate `HooksView.tsx`**

Add `import { IconButton } from '../components/IconButton';` and replace the three `.act-btn` buttons:

```tsx
              <IconButton label="Run now" onClick={() => onRun(hook.id)} variant="act">
                <IconPlay />
              </IconButton>
              <IconButton label="Edit" onClick={() => onEdit(hook)} variant="act">
                <IconEdit />
              </IconButton>
              <IconButton label="Delete" onClick={() => onDelete(hook.id)} variant="act" danger>
                <IconTrash />
              </IconButton>
```

- [ ] **Step 7: Migrate `TopBar.tsx`**

Add `import { IconButton } from '../components/IconButton';` and replace the three `.icon-btn` buttons. Note the rail toggle keeps its distinct label and extra class, and the refresh button keeps its conditional `spin`:

```tsx
        <IconButton label="Toggle navigation" className="rail-toggle" onClick={onToggleRail}>
          <IconMenu />
        </IconButton>
```
```tsx
        <IconButton label="Refresh all" className={refreshing ? 'spin' : undefined} onClick={onRefresh}>
          <IconRefresh />
        </IconButton>
        <IconButton label="Toggle theme" onClick={onToggleTheme}>
          {theme === 'dark' ? moonSvg : sunSvg}
        </IconButton>
```

The rail toggle's `title` changes from `Menu` to `Toggle navigation` so one label drives both attributes. Check `TopBar.test.tsx` for an assertion on `title="Menu"`; if present, update it and note the change in the commit body.

- [ ] **Step 8: Run the full suite, the type-check and e2e**

Run: `npm test && npx tsc --noEmit -p tsconfig.app.json && npx playwright test`
Expected: unit 169 tests pass, tsc exit 0, e2e 12 passed.

- [ ] **Step 9: Commit**

```bash
git add frontend/src
git commit -m "refactor(buttons): add IconButton and give every icon-only control a name"
```

---

### Task 5: `Modal`

**Files:**
- Create: `frontend/src/components/Modal.tsx`
- Create: `frontend/src/components/Modal.test.tsx`
- Modify: `frontend/src/components/DomainModal.tsx:51-58`, `:113-121`
- Modify: `frontend/src/components/HookModal.tsx:47-54`, `:89-97`
- Modify: `frontend/src/components/IncidentModal.tsx:42-56`, and its closing tags

**Interfaces:**
- Consumes: `IconClose` (Task 1), `IconButton` (Task 4).
- Produces: `export interface ModalProps { open: boolean; title: string; onClose: () => void; children: ReactNode; footer?: ReactNode }` and `export function Modal(props: ModalProps): JSX.Element`.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/components/Modal.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Modal } from './Modal';

describe('Modal', () => {
  it('withdraws the closed dialog from the tab order and the a11y tree', () => {
    const { container, rerender } = render(
      <Modal open={false} title="Add Domain" onClose={vi.fn()}><p>body</p></Modal>,
    );
    const overlay = container.querySelector('.modal-overlay');
    expect(overlay).toHaveAttribute('inert');
    expect(overlay).toHaveAttribute('aria-hidden', 'true');
    expect(overlay).not.toHaveClass('open');

    rerender(<Modal open title="Add Domain" onClose={vi.fn()}><p>body</p></Modal>);
    expect(overlay).not.toHaveAttribute('inert');
    expect(overlay).not.toHaveAttribute('aria-hidden');
    expect(overlay).toHaveClass('open');
  });

  it('labels the dialog with its own title', () => {
    render(<Modal open title="Add Hook" onClose={vi.fn()}><p>body</p></Modal>);
    const dialog = screen.getByRole('dialog', { name: 'Add Hook' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
  });

  it('closes on a backdrop click but not on a body click', () => {
    const onClose = vi.fn();
    const { container } = render(
      <Modal open title="Add Domain" onClose={onClose}><p>body</p></Modal>,
    );
    fireEvent.click(screen.getByText('body'));
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(container.querySelector('.modal-overlay')!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes from the close button', () => {
    const onClose = vi.fn();
    render(<Modal open title="Add Domain" onClose={onClose}><p>body</p></Modal>);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('omits the footer element entirely when no footer is given', () => {
    const { container, rerender } = render(
      <Modal open title="Day" onClose={vi.fn()}><p>body</p></Modal>,
    );
    expect(container.querySelector('.modal-foot')).toBeNull();

    rerender(
      <Modal open title="Day" onClose={vi.fn()} footer={<button>Save</button>}><p>body</p></Modal>,
    );
    expect(container.querySelector('.modal-foot')).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/Modal.test.tsx`
Expected: FAIL — `Failed to resolve import "./Modal"`.

- [ ] **Step 3: Write the implementation**

Create `frontend/src/components/Modal.tsx`:

```tsx
import { useId, type JSX, type ReactNode } from 'react';
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
  return (
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
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/Modal.test.tsx`
Expected: PASS, 5 tests.

- [ ] **Step 5: Migrate `DomainModal.tsx`**

Replace the overlay/head/body wrapper and the footer with `Modal`, keeping every field inside untouched:

```tsx
  return (
    <Modal
      open={open}
      title={editing ? 'Edit Domain' : 'Add Domain'}
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={() => onSave(form)}>
            {editing ? 'Save Changes' : 'Add Domain'}
          </button>
        </>
      )}
    >
      {/* lines 62-112 unchanged: the hostname field, provider/record-type row,
          SchemaForm and the enable-auto-update switch row */}
    </Modal>
  );
```

Delete the now-unused `IconClose` import; the close button now lives in `Modal`.

- [ ] **Step 6: Migrate `HookModal.tsx`**

Same treatment. Replace the wrapper at lines 47–54 and the `.modal-foot` at lines 89–97, leaving the `.field`, `.modal-blurb`, `.chips` and `SchemaForm` markup between them exactly as it is:

```tsx
  return (
    <Modal
      open={open}
      title={editing ? 'Edit Hook' : 'Add Hook'}
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={() => onSave(form)}>
            {editing ? 'Save Changes' : 'Add Hook'}
          </button>
        </>
      )}
    >
      {/* lines 58-88 unchanged: the Hook select, blurb, event chips and SchemaForm */}
    </Modal>
  );
```

- [ ] **Step 7: Migrate `IncidentModal.tsx`**

This modal is driven by a nullable bucket and has no footer:

```tsx
  return (
    <Modal open={bucket !== null} title={heading} onClose={onClose}>
      {bucket && (
        <>
          {/* lines 57-104 unchanged: .inc-summary, the day timeline .inc-track
              with its .inc-ticks, and the incident list or empty message */}
        </>
      )}
    </Modal>
  );
```

Do not clamp or otherwise adjust `bucket.end` while moving this markup: `.inc-ticks`
labels are hardcoded `00 06 12 18 24`, so rescaling the track puts bars under the
wrong hour.

`heading` already resolves to `''` when `bucket` is null; leave that logic as is.

- [ ] **Step 8: Run the full suite, the type-check and e2e**

Run: `npm test && npx tsc --noEmit -p tsconfig.app.json && npx playwright test`
Expected: unit 174 tests pass — including the three existing `withdraws the closed … from the tab order` tests, which still pass because `Modal` reproduces the same attributes — tsc exit 0, e2e 12 passed.

- [ ] **Step 9: Commit**

```bash
git add frontend/src
git commit -m "refactor(modals): extract shared Modal shell with dialog semantics"
```

---

### Task 6: `SectionHeader` and `EmptyState`

**Files:**
- Create: `frontend/src/components/SectionHeader.tsx`
- Create: `frontend/src/components/SectionHeader.test.tsx`
- Create: `frontend/src/components/EmptyState.tsx`
- Create: `frontend/src/components/EmptyState.test.tsx`
- Modify: `frontend/src/views/DomainsView.tsx`, `frontend/src/views/HooksView.tsx`, `frontend/src/views/SettingsView.tsx:21-23`

**Interfaces:**
- Consumes: icon components from Task 1.
- Produces: `export interface SectionHeaderProps { title: string; count?: { n: number; noun: string }; action?: ReactNode }`, `export function SectionHeader(props: SectionHeaderProps): JSX.Element`, `export interface EmptyStateProps { icon: ReactNode; title: string; children?: ReactNode }`, `export function EmptyState(props: EmptyStateProps): JSX.Element`.

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/components/SectionHeader.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SectionHeader } from './SectionHeader';

describe('SectionHeader', () => {
  it('renders just a title when nothing else is given', () => {
    const { container } = render(<SectionHeader title="Settings" />);
    expect(screen.getByRole('heading', { name: 'Settings', level: 3 })).toBeInTheDocument();
    expect(container.querySelector('.count-badge')).toBeNull();
    expect(container.querySelector('.spacer')).toBeNull();
  });

  it('pluralises the count noun, keeping the singular at one', () => {
    const { rerender } = render(<SectionHeader title="Domains" count={{ n: 1, noun: 'record' }} />);
    expect(screen.getByText('1 record')).toBeInTheDocument();

    rerender(<SectionHeader title="Domains" count={{ n: 3, noun: 'record' }} />);
    expect(screen.getByText('3 records')).toBeInTheDocument();

    rerender(<SectionHeader title="Hooks" count={{ n: 0, noun: 'hook' }} />);
    expect(screen.getByText('0 hooks')).toBeInTheDocument();
  });

  it('renders the action behind a spacer', () => {
    const { container } = render(
      <SectionHeader title="Domains" action={<button>Add Domain</button>} />,
    );
    expect(container.querySelector('.spacer')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Add Domain' })).toBeInTheDocument();
  });
});
```

Create `frontend/src/components/EmptyState.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EmptyState } from './EmptyState';
import { IconGlobe } from './icons';

describe('EmptyState', () => {
  it('renders the icon, heading and body inside the empty block', () => {
    const { container } = render(
      <EmptyState icon={<IconGlobe strokeWidth={1.5} />} title="No domains yet">
        Add your first domain to get started.
      </EmptyState>,
    );
    const block = container.querySelector('.empty');
    expect(block).not.toBeNull();
    expect(block!.querySelector('svg')).not.toBeNull();
    expect(screen.getByRole('heading', { name: 'No domains yet', level: 3 })).toBeInTheDocument();
    expect(screen.getByText('Add your first domain to get started.')).toBeInTheDocument();
  });

  it('omits the paragraph when there is no body', () => {
    const { container } = render(<EmptyState icon={<IconGlobe />} title="No hooks configured" />);
    expect(container.querySelector('.empty p')).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/components/SectionHeader.test.tsx src/components/EmptyState.test.tsx`
Expected: FAIL — both imports unresolved.

- [ ] **Step 3: Write the implementations**

Create `frontend/src/components/SectionHeader.tsx`:

```tsx
import type { JSX, ReactNode } from 'react';

export interface SectionHeaderProps {
  title: string;
  count?: { n: number; noun: string };
  action?: ReactNode;
}

export function SectionHeader({ title, count, action }: SectionHeaderProps): JSX.Element {
  return (
    <div className="section-head">
      <h3>{title}</h3>
      {count ? (
        <span className="count-badge">{count.n} {count.noun}{count.n === 1 ? '' : 's'}</span>
      ) : null}
      {action ? <div className="spacer"></div> : null}
      {action}
    </div>
  );
}
```

Create `frontend/src/components/EmptyState.tsx`:

```tsx
import type { JSX, ReactNode } from 'react';

export interface EmptyStateProps {
  icon: ReactNode;
  title: string;
  children?: ReactNode;
}

export function EmptyState({ icon, title, children }: EmptyStateProps): JSX.Element {
  return (
    <div className="empty">
      {icon}
      <h3>{title}</h3>
      {children ? <p>{children}</p> : null}
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/components/SectionHeader.test.tsx src/components/EmptyState.test.tsx`
Expected: PASS, 5 tests.

- [ ] **Step 5: Migrate the views**

In `DomainsView.tsx`, replace the header and empty block. Delete the now-unused local `recordLabel` binding:

```tsx
      <SectionHeader
        title="Domains"
        count={{ n: count, noun: 'record' }}
        action={(
          <button className="btn btn-primary" onClick={onAdd}>
            <IconPlus strokeWidth={2.5} />
            Add Domain
          </button>
        )}
      />
      {domains.length === 0 ? (
        <EmptyState icon={<IconGlobe strokeWidth={1.5} />} title="No domains yet">
          Add your first domain to get started.
        </EmptyState>
      ) : (
```

In `HooksView.tsx`, both branches use the same header, so hoist it:

```tsx
  const header = (
    <SectionHeader
      title="Hooks"
      count={{ n: hooks.length, noun: 'hook' }}
      action={(
        <button className="btn btn-primary" onClick={onAdd}>
          <IconPlus strokeWidth={2.5} />
          Add Hook
        </button>
      )}
    />
  );
```

The empty branch becomes `<>{header}<EmptyState icon={<IconHook strokeWidth={1.5} />} title="No hooks configured" /></>` and the populated branch opens with `{header}`. This also removes the duplicated inline pluralisation.

In `SettingsView.tsx:21-23`, replace the header with `<SectionHeader title="Settings" />`. Leave the `<div className="empty"><p>Loading settings…</p></div>` loading block alone — per the spec it is a loading state, not an empty state.

- [ ] **Step 6: Run the full suite, the type-check and e2e**

Run: `npm test && npx tsc --noEmit -p tsconfig.app.json && npx playwright test`
Expected: unit 179 tests pass, tsc exit 0, e2e 12 passed — including `the live strip stays inside its box`, which is the guard against `.empty` layout damage.

- [ ] **Step 7: Commit**

```bash
git add frontend/src
git commit -m "refactor(views): extract SectionHeader and EmptyState"
```

---

### Task 7: CSS cleanup

**Files:**
- Modify: `frontend/src/styles.css:385`, `:547-549`, and the `.modal-head` rule
- Modify: `frontend/e2e/dashboard.spec.ts`

**Interfaces:**
- Consumes: `Modal` from Task 5.
- Produces: no API change.

- [ ] **Step 1: Confirm both rules really are dead**

Run from `frontend/src`:

```bash
grep -rn 'modal-close\|st-paused' --include=*.tsx .
```

Expected: no output. `STATUS_META` in `DomainCard.tsx` defines only `synced`, `pending`, `error`, `updating`, so `.st-paused` is unreachable.

- [ ] **Step 2: Delete the dead rules**

Remove line 385 in `styles.css`:

```css
.st-paused { background: var(--muted-soft); color: var(--muted-status); } .st-paused .s-dot { background: var(--muted-status); }
```

Remove lines 547–549:

```css
.modal-close { width: 32px; height: 32px; border-radius: 8px; display: grid; place-items: center; color: var(--text-3); transition: var(--transition); }
.modal-close:hover { color: var(--text); background: var(--surface-2); }
.modal-close svg { width: 18px; height: 18px; }
```

- [ ] **Step 3: Replace the inline sizing with a rule**

Immediately after the `.modal-head` rule in `styles.css`, add:

```css
.modal-head .icon-btn { width: 34px; height: 34px; }
```

- [ ] **Step 4: Confirm the inline sizing is already gone**

The three `style={{ width: 34, height: 34 }}` props disappeared in Task 5 when the
modals adopted `Modal`, whose close button is an `IconButton` with no inline style.
This step only verifies it — no edit is expected:

```bash
grep -rn 'width: 34' --include=*.tsx frontend/src
```

Expected: no output. If anything matches, remove it before continuing.

- [ ] **Step 5: Verify the modal close button still measures 34px**

The stylesheet is not loaded by jsdom, so assert this in the browser. Add to `frontend/e2e/dashboard.spec.ts`:

```ts
test('the modal close button keeps its 34px hit target', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Domains/ }).click();
  await page.getByRole('main').getByRole('button', { name: 'Add Domain' }).click();

  const box = await page.locator('.modal-overlay.open .modal-head button').boundingBox();
  expect(box?.width).toBeCloseTo(34, 0);
  expect(box?.height).toBeCloseTo(34, 0);
});
```

- [ ] **Step 6: Run everything**

Run: `npm test && npx tsc --noEmit -p tsconfig.app.json && npx playwright test`
Expected: unit 179 tests pass, tsc exit 0, e2e 13 passed.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/styles.css frontend/e2e/dashboard.spec.ts
git commit -m "refactor(css): drop dead modal-close and st-paused rules"
```

---

## Done when

- `grep -rn '<svg' --include=*.tsx frontend/src | grep -v components/icons` returns nothing.
- No `.modal-overlay`, `.modal-head` or `.modal-foot` markup exists outside `Modal.tsx`.
- Every `.act-btn` and `.icon-btn` is rendered by `IconButton`.
- `npm test`, `npx tsc --noEmit -p tsconfig.app.json` and `npx playwright test` are all green.
- No existing test assertion was weakened or deleted, except the `TopBar` title change noted in Task 4 Step 7.
