# Frontend Overhaul — Left-Rail Instrument Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the Tether web UI as a five-view, left-rail instrument panel that faithfully ports `frontend/mockup-left-rail.html`, adds the live Overview reachability instrument, and consumes the new backend telemetry.

**Architecture:** Bottom-up. Extend `types.ts` for the grown snapshot (Task 1), add pure utils (Task 2), port the mockup stylesheet (Task 3), build layout shell `Rail`/`TopBar` (Tasks 4–5), build the Overview panels (Tasks 6–9), build the four remaining views (Tasks 10–13), wire everything in `App.tsx` with local view routing (Task 14), update `DomainCard`/`DomainModal` for deviations (Task 15), then e2e + full verification (Tasks 16–17). TDD; every component gets a render test.

**Tech Stack:** React 19 + TypeScript (strict) + Vite; Vitest + @testing-library/react (jsdom); Playwright e2e; oxlint.

## Global Constraints

- Strict TS; `tsc -b` / `tsc --noEmit` clean; `oxlint` clean (runs as `pretest`).
- All view switching via local `activeView` state — no router, no new dependencies.
- Global CSS classes keyed to the same names the components emit (no CSS modules).
- Provider badge color is a derived hue from the provider key — no hardcoded provider map.
- Record type dropdown offers **A** and **AAAA** only (no combined "A + AAAA").
- Provider config is rendered by the existing `SchemaForm` (no fixed token field).
- ip-sources, providers, hooks, and hook events come from their APIs — never hardcoded.
- Reachability quorum bars render the last `QUORUM_BARS = 24` of the 60-entry history (module constant).
- Vitest: every new component/view has a render test; keep existing coverage thresholds.
- Frontend dir is `frontend/`; run commands from there. Tests: `npm test`; e2e: `npm run test:e2e`; typecheck: `npx tsc --noEmit`.
- Reuse existing components unchanged where they map: `HookModal`, `LogViewer`, `SchemaForm`, `Toasts`.
- This plan assumes the backend plan (`2026-07-12-overview-instrument-backend.md`) is already merged, so the snapshot carries `reachability`, `next_check_at`, `ipv4_changed_at`, `ipv6_changed_at`.

---

## Task 1: Extend snapshot types

**Files:**
- Modify: `frontend/src/types.ts`
- Test: `frontend/src/types.test.ts` (create — a compile-time shape assertion)

**Interfaces:**
- Produces: `ResolverProbe`, `CheckRecord`, `Reachability` interfaces; `StateSnapshot` gains `ipv4_changed_at: number | null`, `ipv6_changed_at: number | null`, `next_check_at: number | null`, `reachability: Reachability`.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/types.test.ts`:

```typescript
import { expectTypeOf, test } from 'vitest';
import type { StateSnapshot, Reachability, ResolverProbe, CheckRecord } from './types';

test('snapshot carries reachability telemetry', () => {
  expectTypeOf<StateSnapshot>().toHaveProperty('reachability');
  expectTypeOf<StateSnapshot>().toHaveProperty('next_check_at');
  expectTypeOf<StateSnapshot>().toHaveProperty('ipv4_changed_at');
  expectTypeOf<Reachability>().toHaveProperty('history');
  expectTypeOf<ResolverProbe>().toHaveProperty('latency_ms');
  expectTypeOf<CheckRecord>().toHaveProperty('successes');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/types.test.ts`
Expected: FAIL — properties missing on `StateSnapshot` / types not exported.

- [ ] **Step 3: Extend `types.ts`**

Add to `frontend/src/types.ts`:

```typescript
export interface ResolverProbe { ip: string; ok: boolean; latency_ms: number | null; }
export interface CheckRecord { ts: number; successes: number; total: number; }
export interface Reachability {
  started_at: number;
  checks: number;
  online: number;
  history: CheckRecord[];
  latest: ResolverProbe[];
}
```

Replace the `StateSnapshot` interface with:

```typescript
export interface StateSnapshot {
  public_ipv4: string | null;
  public_ipv6: string | null;
  ipv4_changed_at: number | null;
  ipv6_changed_at: number | null;
  online: boolean;
  next_check_at: number | null;
  reachability: Reachability;
  domains: DomainState[];
  settings: Settings;
  logs: LogEntry[];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/types.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/types.ts frontend/src/types.test.ts
git commit -m "feat(frontend): extend snapshot types with reachability telemetry"
```

---

## Task 2: Pure display utilities

**Files:**
- Modify: `frontend/src/utils.ts`
- Test: `frontend/src/utils.test.ts` (create)

**Interfaces:**
- Produces:
  - `deriveHue(key: string): number` — deterministic 0–359 hue from a string.
  - `providerColor(key: string): string` — `hsl(<hue> 65% 55%)`.
  - `formatUptime(startedAt: number, now?: number): string` — e.g. `3h 14m`, `12m`, `45s`.
  - `formatCountdown(nextCheckAt: number | null, now?: number): string` — `m:ss`, or `—` when null/past-zero handled by caller.
  - `relStable(changedAt: number | null, now?: number): string` — `2h 14m`, or `—` when null.
  - Keeps existing `formatInterval`.

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/utils.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import {
  deriveHue, providerColor, formatUptime, formatCountdown, relStable,
} from './utils';

describe('deriveHue', () => {
  it('is deterministic and in range', () => {
    const a = deriveHue('cloudflare');
    expect(a).toBe(deriveHue('cloudflare'));
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(360);
  });
  it('differs across keys', () => {
    expect(deriveHue('cloudflare')).not.toBe(deriveHue('duckdns'));
  });
});

describe('providerColor', () => {
  it('wraps the hue in hsl', () => {
    expect(providerColor('duckdns')).toBe(`hsl(${deriveHue('duckdns')} 65% 55%)`);
  });
});

describe('formatUptime', () => {
  it('formats hours and minutes', () => {
    const now = 10_000 + (3 * 3600 + 14 * 60) * 1000;
    expect(formatUptime(10, now)).toBe('3h 14m'); // startedAt in seconds
  });
  it('formats minutes only', () => {
    expect(formatUptime(0, 5 * 60 * 1000)).toBe('5m');
  });
  it('formats seconds only', () => {
    expect(formatUptime(0, 45 * 1000)).toBe('45s');
  });
});

describe('formatCountdown', () => {
  it('returns dash when null', () => {
    expect(formatCountdown(null)).toBe('—');
  });
  it('formats m:ss', () => {
    const now = 0;
    expect(formatCountdown(125, now)).toBe('2:05'); // nextCheckAt in seconds
  });
  it('clamps past zero to 0:00', () => {
    expect(formatCountdown(0, 10_000)).toBe('0:00');
  });
});

describe('relStable', () => {
  it('returns dash when null', () => {
    expect(relStable(null)).toBe('—');
  });
  it('formats elapsed since change', () => {
    const now = (2 * 3600 + 14 * 60) * 1000;
    expect(relStable(0, now)).toBe('2h 14m');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/utils.test.ts`
Expected: FAIL — functions not exported.

- [ ] **Step 3: Implement the utilities**

Append to `frontend/src/utils.ts`:

```typescript
export function deriveHue(key: string): number {
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = (hash * 31 + key.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 360;
}

export function providerColor(key: string): string {
  return `hsl(${deriveHue(key)} 65% 55%)`;
}

function hms(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

export function formatUptime(startedAt: number, now: number = Date.now()): string {
  return hms(now / 1000 - startedAt);
}

export function relStable(changedAt: number | null, now: number = Date.now()): string {
  if (changedAt == null) return '—';
  return hms(now / 1000 - changedAt);
}

export function formatCountdown(nextCheckAt: number | null, now: number = Date.now()): string {
  if (nextCheckAt == null) return '—';
  const remain = Math.max(0, Math.round(nextCheckAt - now / 1000));
  const m = Math.floor(remain / 60);
  const s = remain % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/utils.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/utils.ts frontend/src/utils.test.ts
git commit -m "feat(frontend): add hue/uptime/countdown display utilities"
```

---

## Task 3: Port the mockup stylesheet

**Files:**
- Modify: `frontend/src/styles.css` (replace with the mockup's stylesheet)
- Modify: `frontend/src/App.css`, `frontend/src/index.css` (fold in / prune conflicts as needed)

**Interfaces:**
- Produces: all class selectors the ported components rely on (`.shell`, `.rail`, `.nav-item`, `.topbar`, `.stat`, `.ov-grid`, `.panel`, `.reach-*`, `.quorum`, `.res-*`, `.health-*`, `.domain-card`, `.hook-row`, `.log-*`, `.settings-*`, `.field`, `.modal-*`, `.toast-*`, tokens under `:root` / `[data-theme]`).

- [ ] **Step 1: Copy the stylesheet**

Copy the entire contents of the `<style>` block in `frontend/mockup-left-rail.html` (from `:root {` through the `@media (prefers-reduced-motion)` block) into `frontend/src/styles.css`, replacing its current contents. Keep the existing `main.tsx` import of `./styles.css` (via `App.tsx`).

- [ ] **Step 2: Reconcile the other CSS files**

Ensure `frontend/src/index.css` retains only base resets that don't conflict (the mockup's stylesheet already includes `* { box-sizing… }`, `body`, etc. — remove duplicates from `index.css`/`App.css` to avoid cascade fights). If `App.css` is now empty, delete its import from `App.tsx`.

- [ ] **Step 3: Typecheck + lint + build**

Run: `cd frontend && npx tsc --noEmit && npm run lint && npm run build`
Expected: clean build (CSS is not type-checked, but the build must succeed).

- [ ] **Step 4: Commit**

```bash
git add frontend/src/styles.css frontend/src/index.css frontend/src/App.css
git commit -m "feat(frontend): port mockup stylesheet and tokens"
```

---

## Task 4: `Rail` layout component

**Files:**
- Create: `frontend/src/layout/Rail.tsx`
- Test: `frontend/src/layout/Rail.test.tsx`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
```typescript
export type ViewKey = 'overview' | 'domains' | 'hooks' | 'logs' | 'settings';
export interface RailProps {
  active: ViewKey;
  onSelect: (view: ViewKey) => void;
  domainCount: number;
  hookCount: number;
  online: boolean;
  collapsed: boolean;
  mobileOpen: boolean;
  onCloseMobile: () => void;
}
export function Rail(props: RailProps): JSX.Element;
```

- [ ] **Step 1: Write the failing test**

Create `frontend/src/layout/Rail.test.tsx`:

```tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Rail } from './Rail';

const base = {
  active: 'overview' as const, onSelect: vi.fn(), domainCount: 3, hookCount: 2,
  online: true, collapsed: false, mobileOpen: false, onCloseMobile: vi.fn(),
};

describe('Rail', () => {
  it('renders the five nav items with counts', () => {
    render(<Rail {...base} />);
    expect(screen.getByRole('button', { name: /Overview/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Domains/ })).toHaveTextContent('3');
    expect(screen.getByRole('button', { name: /Hooks/ })).toHaveTextContent('2');
    expect(screen.getByRole('button', { name: /Logs/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Settings/ })).toBeInTheDocument();
  });

  it('marks the active view', () => {
    render(<Rail {...base} active="domains" />);
    expect(screen.getByRole('button', { name: /Domains/ })).toHaveClass('active');
  });

  it('calls onSelect when a nav item is clicked', () => {
    const onSelect = vi.fn();
    render(<Rail {...base} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole('button', { name: /Hooks/ }));
    expect(onSelect).toHaveBeenCalledWith('hooks');
  });

  it('shows offline dot when offline', () => {
    const { container } = render(<Rail {...base} online={false} />);
    expect(container.querySelector('.rail-status .dot.offline')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/layout/Rail.test.tsx`
Expected: FAIL — `Cannot find module './Rail'`.

- [ ] **Step 3: Implement `Rail`**

Create `frontend/src/layout/Rail.tsx`. Port the `<aside class="rail">` markup from the mockup. Define the nav config array, render each as a `<button className={`nav-item${active===key?' active':''}`}>` with the mockup's inline SVG, label, and (for domains/hooks) a `.nav-count` badge. Apply `rail open` class when `mobileOpen`, and the online/offline dot in `.rail-foot`. Convert `class`→`className`, self-close SVG paths, and keep `data-theme` behavior in `App` (not here).

```tsx
import type { JSX } from 'react';

export type ViewKey = 'overview' | 'domains' | 'hooks' | 'logs' | 'settings';

export interface RailProps {
  active: ViewKey;
  onSelect: (view: ViewKey) => void;
  domainCount: number;
  hookCount: number;
  online: boolean;
  collapsed: boolean;
  mobileOpen: boolean;
  onCloseMobile: () => void;
}

interface NavDef { key: ViewKey; label: string; icon: JSX.Element; count?: number; }

export function Rail(props: RailProps): JSX.Element {
  const { active, onSelect, domainCount, hookCount, online, mobileOpen } = props;
  const items: NavDef[] = [
    { key: 'overview', label: 'Overview', icon: (/* mockup overview svg */ <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="9" /><rect x="14" y="3" width="7" height="5" /><rect x="14" y="12" width="7" height="9" /><rect x="3" y="16" width="7" height="5" /></svg>) },
    { key: 'domains', label: 'Domains', count: domainCount, icon: (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><path d="M2 12h20M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20z" /></svg>) },
    { key: 'hooks', label: 'Hooks', count: hookCount, icon: (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 10a10 10 0 0 1 10 10" /><path d="M4 16a4 4 0 0 1 4 4" /><circle cx="5" cy="19" r="1" /><path d="m12 10 4-4a2.83 2.83 0 0 1 4 4l-4 4" /><path d="m14 8 3 3" /><path d="m9 15 3 3" /></svg>) },
    { key: 'logs', label: 'Logs', icon: (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 4h16v16H4z" /><path d="M8 8h8M8 12h8M8 16h5" /></svg>) },
    { key: 'settings', label: 'Settings', icon: (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>) },
  ];
  return (
    <aside className={`rail${mobileOpen ? ' open' : ''}`}>
      <div className="brand">
        <div className="logo">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z" /><path d="M2 12h20" /><path d="M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20z" /></svg>
        </div>
        <div className="brand-text"><h1>Tether</h1><p>Self-hosted DDNS</p></div>
      </div>
      <nav className="nav">
        {items.map((it) => (
          <button
            key={it.key}
            type="button"
            className={`nav-item${active === it.key ? ' active' : ''}`}
            title={it.label}
            onClick={() => onSelect(it.key)}
          >
            {it.icon}
            <span className="nav-label">{it.label}</span>
            {it.count !== undefined && <span className="nav-count">{it.count}</span>}
          </button>
        ))}
      </nav>
      <div className="rail-foot">
        <div className="rail-status">
          <span className={`dot${online ? '' : ' offline'}`} />
          <span>{online ? 'Online' : 'Offline'}</span>
        </div>
      </div>
    </aside>
  );
}
```

(Collapse/resize is applied via a class on `<html>` from `App`; the resizer handle and its drag logic live in `App` per the mockup — Rail only renders the static structure. If you prefer the resizer inside Rail, add it as a non-interactive `<div className="rail-resizer" />` and lift the drag handler via a prop; keep it out of the render test.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/layout/Rail.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/layout/Rail.tsx frontend/src/layout/Rail.test.tsx
git commit -m "feat(frontend): add Rail navigation component"
```

---

## Task 5: `TopBar` layout component

**Files:**
- Create: `frontend/src/layout/TopBar.tsx`
- Test: `frontend/src/layout/TopBar.test.tsx`

**Interfaces:**
- Produces:
```typescript
export interface TopBarProps {
  title: string;
  subtitle: string;
  ipv4: string | null;
  ipv6: string | null;
  online: boolean;
  refreshing: boolean;
  theme: 'dark' | 'light';
  onRefresh: () => void;
  onToggleTheme: () => void;
  onToggleRail: () => void;
}
export function TopBar(props: TopBarProps): JSX.Element;
```

- [ ] **Step 1: Write the failing test**

Create `frontend/src/layout/TopBar.test.tsx`:

```tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TopBar } from './TopBar';

const base = {
  title: 'Overview', subtitle: 'Live status', ipv4: '203.0.113.5', ipv6: null,
  online: true, refreshing: false, theme: 'dark' as const,
  onRefresh: vi.fn(), onToggleTheme: vi.fn(), onToggleRail: vi.fn(),
};

describe('TopBar', () => {
  it('renders title, subtitle and IPv4 value', () => {
    render(<TopBar {...base} />);
    expect(screen.getByText('Overview')).toBeInTheDocument();
    expect(screen.getByText('Live status')).toBeInTheDocument();
    expect(screen.getByText('203.0.113.5')).toBeInTheDocument();
  });
  it('shows a dash for a missing IPv6', () => {
    render(<TopBar {...base} />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });
  it('fires refresh and theme handlers', () => {
    const onRefresh = vi.fn(); const onToggleTheme = vi.fn();
    render(<TopBar {...base} onRefresh={onRefresh} onToggleTheme={onToggleTheme} />);
    fireEvent.click(screen.getByRole('button', { name: /Refresh all/i }));
    fireEvent.click(screen.getByRole('button', { name: /Toggle theme/i }));
    expect(onRefresh).toHaveBeenCalled();
    expect(onToggleTheme).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/layout/TopBar.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `TopBar`**

Create `frontend/src/layout/TopBar.tsx`, porting the mockup `<header class="topbar">`. Render the rail-toggle button (`onToggleRail`), page title/subtitle, spacer, two `.ip-pill`s (IPv4 always, IPv6 with `ip-v6` class; value `?? '—'`; dot `offline` when `!online`), refresh icon button (`spin` class when `refreshing`, `title="Refresh all"`), and theme toggle button (`title="Toggle theme"`, moon/sun svg by `theme`). Convert attributes to JSX.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/layout/TopBar.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/layout/TopBar.tsx frontend/src/layout/TopBar.test.tsx
git commit -m "feat(frontend): add TopBar component"
```

---

## Task 6: `StatCard` component

**Files:**
- Create: `frontend/src/components/StatCard.tsx`
- Test: `frontend/src/components/StatCard.test.tsx`

**Interfaces:**
- Produces:
```typescript
export interface StatCardProps {
  label: string; value: string | number; sub: string;
  tint: 'tint-accent' | 'tint-ok' | 'tint-warn' | 'tint-err';
  icon: JSX.Element;
}
export function StatCard(props: StatCardProps): JSX.Element;
```

- [ ] **Step 1: Write the failing test**

Create `frontend/src/components/StatCard.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StatCard } from './StatCard';

describe('StatCard', () => {
  it('renders label, value, sub and tint', () => {
    const { container } = render(
      <StatCard label="Synced" value={4} sub="Records up to date" tint="tint-ok" icon={<svg />} />,
    );
    expect(screen.getByText('Synced')).toBeInTheDocument();
    expect(screen.getByText('4')).toBeInTheDocument();
    expect(screen.getByText('Records up to date')).toBeInTheDocument();
    expect(container.querySelector('.stat-ico.tint-ok')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/components/StatCard.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `StatCard`**

Create `frontend/src/components/StatCard.tsx` porting the mockup `.stat` markup:

```tsx
import type { JSX } from 'react';

export interface StatCardProps {
  label: string; value: string | number; sub: string;
  tint: 'tint-accent' | 'tint-ok' | 'tint-warn' | 'tint-err';
  icon: JSX.Element;
}

export function StatCard({ label, value, sub, tint, icon }: StatCardProps): JSX.Element {
  return (
    <div className="stat">
      <div className="stat-top">
        <span className="stat-label">{label}</span>
        <span className={`stat-ico ${tint}`}>{icon}</span>
      </div>
      <div className="stat-value">{value}</div>
      <div className="stat-sub">{sub}</div>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/components/StatCard.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/StatCard.tsx frontend/src/components/StatCard.test.tsx
git commit -m "feat(frontend): add StatCard component"
```

---

## Task 7: `IpReadoutPanel` component

**Files:**
- Create: `frontend/src/components/IpReadoutPanel.tsx`
- Test: `frontend/src/components/IpReadoutPanel.test.tsx`

**Interfaces:**
- Consumes: `relStable` from `utils`.
- Produces:
```typescript
export interface IpReadoutPanelProps {
  ipv4: string | null; ipv6: string | null;
  ipv4ChangedAt: number | null; ipv6ChangedAt: number | null;
  ipSource: string;
}
export function IpReadoutPanel(props: IpReadoutPanelProps): JSX.Element;
```

- [ ] **Step 1: Write the failing test**

Create `frontend/src/components/IpReadoutPanel.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { IpReadoutPanel } from './IpReadoutPanel';

describe('IpReadoutPanel', () => {
  it('renders both addresses and the source subtitle', () => {
    render(
      <IpReadoutPanel
        ipv4="203.0.113.5" ipv6="2606:4700::1111"
        ipv4ChangedAt={0} ipv6ChangedAt={null} ipSource="ipify"
      />,
    );
    expect(screen.getByText('203.0.113.5')).toBeInTheDocument();
    expect(screen.getByText('2606:4700::1111')).toBeInTheDocument();
    expect(screen.getByText(/ipify/)).toBeInTheDocument();
  });
  it('shows a dash for a missing address', () => {
    render(
      <IpReadoutPanel ipv4={null} ipv6={null} ipv4ChangedAt={null} ipv6ChangedAt={null} ipSource="ipify" />,
    );
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/components/IpReadoutPanel.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `IpReadoutPanel`**

Create `frontend/src/components/IpReadoutPanel.tsx`. Render the mockup `.panel` with head `Public IP` + sub `dual-stack · {ipSource}`, then two `.ip-row`s (IPv4·A, IPv6·AAAA) showing address `?? '—'` and `stable {relStable(changedAt)}`.

```tsx
import type { JSX } from 'react';
import { relStable } from '../utils';

export interface IpReadoutPanelProps {
  ipv4: string | null; ipv6: string | null;
  ipv4ChangedAt: number | null; ipv6ChangedAt: number | null;
  ipSource: string;
}

export function IpReadoutPanel(p: IpReadoutPanelProps): JSX.Element {
  const rows = [
    { meta: 'IPv4 · A', addr: p.ipv4, since: p.ipv4ChangedAt },
    { meta: 'IPv6 · AAAA', addr: p.ipv6, since: p.ipv6ChangedAt },
  ];
  return (
    <div className="panel">
      <div className="panel-head"><h4>Public IP</h4><span className="sub">dual-stack · {p.ipSource}</span></div>
      <div className="ip-readout">
        {rows.map((r) => (
          <div className="ip-row" key={r.meta}>
            <div><div className="ip-meta">{r.meta}</div><div className="ip-addr">{r.addr ?? '—'}</div></div>
            <div className="ip-since">stable<br />{relStable(r.since)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/components/IpReadoutPanel.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/IpReadoutPanel.tsx frontend/src/components/IpReadoutPanel.test.tsx
git commit -m "feat(frontend): add IpReadoutPanel component"
```

---

## Task 8: `ReachabilityPanel` component

**Files:**
- Create: `frontend/src/components/ReachabilityPanel.tsx`
- Test: `frontend/src/components/ReachabilityPanel.test.tsx`

**Interfaces:**
- Consumes: `Reachability` type; `formatUptime` from utils.
- Produces:
```typescript
export const QUORUM_BARS = 24;
export const QUORUM = 2; // display threshold matching backend default
export interface ReachabilityPanelProps { reachability: Reachability; }
export function ReachabilityPanel(props: ReachabilityPanelProps): JSX.Element;
```

- [ ] **Step 1: Write the failing test**

Create `frontend/src/components/ReachabilityPanel.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ReachabilityPanel } from './ReachabilityPanel';
import type { Reachability } from '../types';

const reach: Reachability = {
  started_at: 0, checks: 100, online: 98,
  history: Array.from({ length: 30 }, (_, i) => ({ ts: i, successes: 3, total: 3 })),
  latest: [
    { ip: '1.1.1.1', ok: true, latency_ms: 11.2 },
    { ip: '8.8.8.8', ok: false, latency_ms: null },
  ],
};

describe('ReachabilityPanel', () => {
  it('renders uptime percentage', () => {
    render(<ReachabilityPanel reachability={reach} />);
    expect(screen.getByText('98.0%')).toBeInTheDocument();
  });
  it('renders resolver rows with latency and timeout', () => {
    render(<ReachabilityPanel reachability={reach} />);
    expect(screen.getByText('1.1.1.1')).toBeInTheDocument();
    expect(screen.getByText('11 ms')).toBeInTheDocument();
    expect(screen.getByText('timeout')).toBeInTheDocument();
  });
  it('caps quorum bars at QUORUM_BARS', () => {
    const { container } = render(<ReachabilityPanel reachability={reach} />);
    expect(container.querySelectorAll('.quorum span').length).toBe(24);
  });
  it('handles zero checks with a dash', () => {
    render(<ReachabilityPanel reachability={{ ...reach, checks: 0, online: 0, history: [], latest: [] }} />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/components/ReachabilityPanel.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `ReachabilityPanel`**

Create `frontend/src/components/ReachabilityPanel.tsx`. Port the mockup's reach-head (uptime value + badge), `.quorum` bars (last `QUORUM_BARS` of history; class `down` when `successes < QUORUM`, `degraded` when `successes < total`, `live` on the last), quorum scale, and `.resolvers` rows (width from `latency_ms` clamped, `slow` over 30ms, `timeout` when `!ok`). Uptime `%` = `online/checks*100` to one decimal, or `—` when `checks===0`. Uptime sub uses `formatUptime(started_at)`.

```tsx
import type { JSX } from 'react';
import type { Reachability } from '../types';
import { formatUptime } from '../utils';

export const QUORUM_BARS = 24;
export const QUORUM = 2;
const MAX_LAT = 45;

export interface ReachabilityPanelProps { reachability: Reachability; }

export function ReachabilityPanel({ reachability: r }: ReachabilityPanelProps): JSX.Element {
  const bars = r.history.slice(-QUORUM_BARS);
  const last = bars.length ? bars[bars.length - 1] : null;
  const online = last ? last.successes >= QUORUM : true;
  const pct = r.checks ? ((r.online / r.checks) * 100).toFixed(1) + '%' : '—';
  return (
    <>
      <div className="reach-head">
        <div className="reach-uptime">
          <span className={`up-val${online ? '' : ' down'}`}>{pct}</span>
          <span className="up-sub">{r.online}/{r.checks} checks · up {formatUptime(r.started_at)}</span>
        </div>
        <span className={`reach-badge ${online ? 'up' : 'down'}`}><span className="rb-dot" />{online ? 'Online' : 'Offline'}</span>
      </div>
      <div className="quorum">
        {Array.from({ length: QUORUM_BARS }, (_, i) => {
          const h = bars[i - (QUORUM_BARS - bars.length)];
          if (!h) return <span key={i} style={{ height: '14%' }} />;
          const cls = h.successes < QUORUM ? 'down' : (h.successes < h.total ? 'degraded' : '');
          const live = i === QUORUM_BARS - 1 ? ' live' : '';
          const height = Math.max(14, Math.round((h.successes / h.total) * 100));
          return <span key={i} className={`${cls}${live}`} style={{ height: `${height}%` }} title={`${h.successes}/${h.total} ok`} />;
        })}
      </div>
      <div className="quorum-scale"><span>{QUORUM_BARS} checks ago</span><span>now</span></div>
      <div className="resolvers">
        {r.latest.map((x) => {
          if (!x.ok || x.latency_ms == null) {
            return (
              <div className="res-row" key={x.ip}>
                <span className="res-ip">{x.ip}</span>
                <div className="res-track"><div className="res-fill" style={{ width: '0%' }} /></div>
                <span className="res-lat timeout">timeout</span>
              </div>
            );
          }
          const w = Math.min(100, (x.latency_ms / MAX_LAT) * 100);
          const slow = x.latency_ms > 30 ? ' slow' : '';
          return (
            <div className="res-row" key={x.ip}>
              <span className="res-ip">{x.ip}</span>
              <div className="res-track"><div className={`res-fill${slow}`} style={{ width: `${w}%` }} /></div>
              <span className="res-lat">{Math.round(x.latency_ms)} ms</span>
            </div>
          );
        })}
      </div>
    </>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/components/ReachabilityPanel.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/ReachabilityPanel.tsx frontend/src/components/ReachabilityPanel.test.tsx
git commit -m "feat(frontend): add ReachabilityPanel instrument"
```

---

## Task 9: `RecordHealthPanel` component (health bar + next-check countdown)

**Files:**
- Create: `frontend/src/components/RecordHealthPanel.tsx`
- Test: `frontend/src/components/RecordHealthPanel.test.tsx`

**Interfaces:**
- Consumes: `DomainState` type; `formatCountdown` from utils.
- Produces:
```typescript
export interface RecordHealthPanelProps {
  domains: DomainState[];
  enabledById: Record<string, boolean>;
  nextCheckAt: number | null;
  checkInterval: number;
}
export function RecordHealthPanel(props: RecordHealthPanelProps): JSX.Element;
```

- [ ] **Step 1: Write the failing test**

Create `frontend/src/components/RecordHealthPanel.test.tsx`:

```tsx
import { render, screen, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RecordHealthPanel } from './RecordHealthPanel';
import type { DomainState } from '../types';

const domains: DomainState[] = [
  { id: 'a', status: 'synced', ip: '1.2.3.4', updated: 1, message: '' },
  { id: 'b', status: 'error', ip: null, updated: 1, message: '' },
];

describe('RecordHealthPanel', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('renders the domain count and legend counts', () => {
    render(<RecordHealthPanel domains={domains} enabledById={{ a: true, b: true }} nextCheckAt={null} checkInterval={300} />);
    expect(screen.getByText('2 domains')).toBeInTheDocument();
  });

  it('shows a dash countdown when nextCheckAt is null', () => {
    render(<RecordHealthPanel domains={domains} enabledById={{}} nextCheckAt={null} checkInterval={300} />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('counts down from nextCheckAt', () => {
    const now = 1_000_000;
    vi.setSystemTime(now);
    render(<RecordHealthPanel domains={domains} enabledById={{}} nextCheckAt={now / 1000 + 65} checkInterval={300} />);
    expect(screen.getByText('1:05')).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(1000); });
    expect(screen.getByText('1:04')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/components/RecordHealthPanel.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `RecordHealthPanel`**

Create `frontend/src/components/RecordHealthPanel.tsx`. Compute status counts (a disabled domain counts as `paused`; `updating`→`pending`), render `.health-bar` segments + `.health-legend`, then the next-check block. Use a local 1s interval + `useState(Date.now())` tick to drive `formatCountdown(nextCheckAt, now)`; fill width = `remain / checkInterval * 100`.

```tsx
import { useEffect, useState, type JSX } from 'react';
import type { DomainState } from '../types';
import { formatCountdown } from '../utils';

export interface RecordHealthPanelProps {
  domains: DomainState[];
  enabledById: Record<string, boolean>;
  nextCheckAt: number | null;
  checkInterval: number;
}

const ORDER: [string, string, string][] = [
  ['synced', 'Synced', 'var(--ok)'],
  ['pending', 'Pending', 'var(--warn)'],
  ['error', 'Error', 'var(--err)'],
  ['paused', 'Paused', 'var(--muted-status)'],
];

export function RecordHealthPanel(p: RecordHealthPanelProps): JSX.Element {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const counts: Record<string, number> = { synced: 0, pending: 0, error: 0, paused: 0 };
  for (const d of p.domains) {
    let s = p.enabledById[d.id] === false ? 'paused' : d.status;
    if (s === 'updating') s = 'pending';
    counts[s in counts ? s : 'pending'] += 1;
  }
  const n = p.domains.length;
  const segs = ORDER.filter(([k]) => counts[k] > 0);
  const remain = p.nextCheckAt == null ? 0 : Math.max(0, p.nextCheckAt - now / 1000);
  const fillPct = p.checkInterval ? Math.min(100, (remain / p.checkInterval) * 100) : 0;

  return (
    <div className="panel">
      <div className="panel-head"><h4>Record health</h4><span className="sub">{n} {n === 1 ? 'domain' : 'domains'}</span></div>
      <div className="health-bar">
        {segs.length ? segs.map(([k, , c]) => (
          <span key={k} style={{ flex: counts[k], background: c }} title={`${counts[k]} ${k}`} />
        )) : <span style={{ flex: 1, background: 'var(--surface-2)' }} />}
      </div>
      <div className="health-legend">
        {ORDER.map(([k, label, c]) => (
          <div className="hl-item" key={k}>
            <span className="hl-dot" style={{ background: c }} />
            <span className="hl-label">{label}</span>
            <span className="hl-count">{counts[k]}</span>
          </div>
        ))}
      </div>
      <div className="panel-divider" />
      <div className="next-check">
        <div className="nc-top"><span className="nc-label">Next check</span><span className="nc-time">{formatCountdown(p.nextCheckAt, now)}</span></div>
        <div className="nc-track"><div className="nc-fill" style={{ width: `${fillPct}%` }} /></div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/components/RecordHealthPanel.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/RecordHealthPanel.tsx frontend/src/components/RecordHealthPanel.test.tsx
git commit -m "feat(frontend): add RecordHealthPanel with next-check countdown"
```

---

## Task 10: `OverviewView`

**Files:**
- Create: `frontend/src/views/OverviewView.tsx`
- Test: `frontend/src/views/OverviewView.test.tsx`

**Interfaces:**
- Consumes: `StateSnapshot`, `Settings`, `DomainConfig`; `StatCard`, `IpReadoutPanel`, `ReachabilityPanel`, `RecordHealthPanel`; `formatInterval`.
- Produces:
```typescript
export interface OverviewViewProps {
  snapshot: StateSnapshot | null;
  domains: DomainConfig[];
  settings: Settings | null;
}
export function OverviewView(props: OverviewViewProps): JSX.Element;
```

- [ ] **Step 1: Write the failing test**

Create `frontend/src/views/OverviewView.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { OverviewView } from './OverviewView';
import type { StateSnapshot } from '../types';

vi.useFakeTimers();

const snapshot: StateSnapshot = {
  public_ipv4: '203.0.113.5', public_ipv6: null,
  ipv4_changed_at: 0, ipv6_changed_at: null,
  online: true, next_check_at: null,
  reachability: { started_at: 0, checks: 10, online: 10, history: [], latest: [] },
  domains: [{ id: 'a', status: 'synced', ip: '203.0.113.5', updated: 1, message: '' }],
  settings: { check_interval: 300, ip_source: 'ipify', update_on_startup: true, retry_on_failure: true, notify: true },
  logs: [],
};

describe('OverviewView', () => {
  it('renders stat cards and both overview panels', () => {
    render(
      <OverviewView
        snapshot={snapshot}
        domains={[{ id: 'a', hostname: 'h', provider: 'duckdns', record_type: 'A', enabled: true }]}
        settings={snapshot.settings}
      />,
    );
    expect(screen.getByText('Total Domains')).toBeInTheDocument();
    expect(screen.getByText('Public IP')).toBeInTheDocument();
    expect(screen.getByText('Record health')).toBeInTheDocument();
  });

  it('renders safely with a null snapshot', () => {
    render(<OverviewView snapshot={null} domains={[]} settings={null} />);
    expect(screen.getByText('Total Domains')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/views/OverviewView.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `OverviewView`**

Create `frontend/src/views/OverviewView.tsx`. Compute stats (total, synced, needs-update, providerCount) from `domains` joined with `snapshot.domains` by id. Render the `.stats` grid of four `StatCard`s (icons ported from the mockup/`App.tsx`), then the `.ov-grid` with a left `.panel` containing `IpReadoutPanel` content + divider + `ReachabilityPanel`, and `RecordHealthPanel` on the right. Guard all `snapshot` reads with null-safe defaults (empty reachability `{started_at:0,checks:0,online:0,history:[],latest:[]}`).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/views/OverviewView.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/views/OverviewView.tsx frontend/src/views/OverviewView.test.tsx
git commit -m "feat(frontend): add OverviewView"
```

---

## Task 11: `DomainsView`

**Files:**
- Create: `frontend/src/views/DomainsView.tsx`
- Test: `frontend/src/views/DomainsView.test.tsx`

**Interfaces:**
- Consumes: `DomainConfig`, `DomainState`; existing `DomainCard`.
- Produces:
```typescript
export interface DomainsViewProps {
  domains: DomainConfig[];
  runtimeById: Map<string, DomainState>;
  onAdd: () => void;
  onSync: (id: string) => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  onToggle: (id: string) => void;
}
export function DomainsView(props: DomainsViewProps): JSX.Element;
```

- [ ] **Step 1: Write the failing test**

Create `frontend/src/views/DomainsView.test.tsx`:

```tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DomainsView } from './DomainsView';

const noop = vi.fn();
const handlers = { onSync: noop, onEdit: noop, onDelete: noop, onToggle: noop };

describe('DomainsView', () => {
  it('shows the empty state with no domains', () => {
    render(<DomainsView domains={[]} runtimeById={new Map()} onAdd={noop} {...handlers} />);
    expect(screen.getByText('No domains yet')).toBeInTheDocument();
  });
  it('renders a card per domain and fires onAdd', () => {
    const onAdd = vi.fn();
    render(
      <DomainsView
        domains={[{ id: 'a', hostname: 'home.example.com', provider: 'duckdns', record_type: 'A', enabled: true }]}
        runtimeById={new Map()}
        onAdd={onAdd}
        {...handlers}
      />,
    );
    expect(screen.getByText('home.example.com')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Add Domain/ }));
    expect(onAdd).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/views/DomainsView.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `DomainsView`**

Create `frontend/src/views/DomainsView.tsx` porting the mockup Domains view: `.section-head` (h3 + count badge + spacer + Add Domain button) and `.domain-grid` mapping `DomainCard` (empty state when none). Pass `runtimeById.get(d.id) ?? { id: d.id, status: 'pending', ip: null, updated: null, message: '' }`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/views/DomainsView.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/views/DomainsView.tsx frontend/src/views/DomainsView.test.tsx
git commit -m "feat(frontend): add DomainsView"
```

---

## Task 12: `HooksView`

**Files:**
- Create: `frontend/src/views/HooksView.tsx`
- Test: `frontend/src/views/HooksView.test.tsx`

**Interfaces:**
- Consumes: `HookConfig`, `HookDef`.
- Produces:
```typescript
export interface HooksViewProps {
  hooks: HookConfig[];
  hookDefs: HookDef[];
  onAdd: () => void;
  onRun: (id: string) => void;
  onEdit: (hook: HookConfig) => void;
  onDelete: (id: string) => void;
}
export function HooksView(props: HooksViewProps): JSX.Element;
```

- [ ] **Step 1: Write the failing test**

Create `frontend/src/views/HooksView.test.tsx`:

```tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { HooksView } from './HooksView';

const noop = vi.fn();

describe('HooksView', () => {
  it('shows the empty state with no hooks', () => {
    render(<HooksView hooks={[]} hookDefs={[]} onAdd={noop} onRun={noop} onEdit={noop} onDelete={noop} />);
    expect(screen.getByText('No hooks configured')).toBeInTheDocument();
  });
  it('renders a hook row with its events and fires run', () => {
    const onRun = vi.fn();
    render(
      <HooksView
        hooks={[{ id: 'h1', hook: 'log', events: ['ip_changed'], config: {} }]}
        hookDefs={[{ key: 'log', display_name: 'Log hook', events: [], schema: {} }]}
        onAdd={noop} onRun={onRun} onEdit={noop} onDelete={noop}
      />,
    );
    expect(screen.getByText('Log hook')).toBeInTheDocument();
    expect(screen.getByText('ip_changed')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Run now/i }));
    expect(onRun).toHaveBeenCalledWith('h1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/views/HooksView.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `HooksView`**

Create `frontend/src/views/HooksView.tsx` porting the mockup Hooks view: `.section-head` + Add Hook button, `.hook-list` of `.hook-row`s (icon, name via `hookDefs` display_name, `.evt-tag` per event, run/edit/delete `.act-btn`s), empty state when none.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/views/HooksView.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/views/HooksView.tsx frontend/src/views/HooksView.test.tsx
git commit -m "feat(frontend): add HooksView"
```

---

## Task 13: `LogsView` and `SettingsView`

**Files:**
- Create: `frontend/src/views/LogsView.tsx`, `frontend/src/views/SettingsView.tsx`
- Test: `frontend/src/views/LogsView.test.tsx`, `frontend/src/views/SettingsView.test.tsx`

**Interfaces:**
- Produces:
```typescript
export interface LogsViewProps { logs: LogEntry[]; }
export function LogsView(props: LogsViewProps): JSX.Element;

export interface SettingsViewProps {
  settings: Settings | null;
  ipSources: { key: string; display_name: string }[];
  onSave: (patch: Partial<Settings>) => void;
}
export function SettingsView(props: SettingsViewProps): JSX.Element;
```

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/views/LogsView.test.tsx`:

```tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LogsView } from './LogsView';
import type { LogEntry } from '../types';

const logs: LogEntry[] = [
  { time: 1, level: 'INFO', logger: 'x', message: 'started up' },
  { time: 2, level: 'ERROR', logger: 'x', message: 'boom failed' },
];

describe('LogsView', () => {
  it('renders all lines then filters by level', () => {
    render(<LogsView logs={logs} />);
    expect(screen.getByText('started up')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Error' }));
    expect(screen.queryByText('started up')).not.toBeInTheDocument();
    expect(screen.getByText('boom failed')).toBeInTheDocument();
  });
  it('filters by search text', () => {
    render(<LogsView logs={logs} />);
    fireEvent.change(screen.getByPlaceholderText(/Filter log messages/i), { target: { value: 'boom' } });
    expect(screen.queryByText('started up')).not.toBeInTheDocument();
    expect(screen.getByText('boom failed')).toBeInTheDocument();
  });
});
```

Create `frontend/src/views/SettingsView.test.tsx`:

```tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SettingsView } from './SettingsView';

const settings = { check_interval: 300, ip_source: 'ipify', update_on_startup: true, retry_on_failure: true, notify: true };

describe('SettingsView', () => {
  it('marks the active interval chip and saves on change', () => {
    const onSave = vi.fn();
    render(<SettingsView settings={settings} ipSources={[{ key: 'ipify', display_name: 'ipify' }]} onSave={onSave} />);
    expect(screen.getByRole('button', { name: '5 min' })).toHaveClass('active');
    fireEvent.click(screen.getByRole('button', { name: '10 min' }));
    expect(onSave).toHaveBeenCalledWith({ check_interval: 600 });
  });
  it('populates ip-source options from props', () => {
    render(<SettingsView settings={settings} ipSources={[{ key: 'ipify', display_name: 'ipify' }, { key: 'icanhazip', display_name: 'icanhazip' }]} onSave={vi.fn()} />);
    expect(screen.getByRole('option', { name: /icanhazip/ })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/views/LogsView.test.tsx src/views/SettingsView.test.tsx`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement both views**

`LogsView.tsx`: port the mockup Logs view — `.log-toolbar` (search input + level filter chips ALL/INFO/WARNING/ERROR) with local `useState` for query + level, filtering `logs`, feeding the filtered list to the existing `LogViewer`. Count badge shows filtered length.

`SettingsView.tsx`: port the mockup Settings view — Scheduling interval chips (`[60,300,600,1800,3600]`, active when equal to `settings.check_interval`, click → `onSave({check_interval})`), Behavior switches (`update_on_startup`, `notify`, `retry_on_failure` → `onSave` with the toggled key), and IP source `<select>` populated from `ipSources` (→ `onSave({ip_source})`). Guard `settings === null` with disabled/placeholder rendering.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/views/LogsView.test.tsx src/views/SettingsView.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/views/LogsView.tsx frontend/src/views/LogsView.test.tsx frontend/src/views/SettingsView.tsx frontend/src/views/SettingsView.test.tsx
git commit -m "feat(frontend): add LogsView and SettingsView"
```

---

## Task 14: Update `DomainCard` and `DomainModal` (deviations #2, #5, #6, #1)

**Files:**
- Modify: `frontend/src/components/DomainCard.tsx`, `frontend/src/components/DomainCard.test.tsx`
- Modify: `frontend/src/components/DomainModal.tsx`, `frontend/src/components/DomainModal.test.tsx`

**Interfaces:**
- Consumes: `providerColor` from utils.
- Produces: `DomainCard` badge uses `providerColor(domain.provider)` and an enable/disable `.switch` in the `.dc-ip` row (wired to `onToggle`); `DomainModal` record-type `<select>` offers `A` / `AAAA` only and uses `SchemaForm` for provider config (already present — confirm no fixed token field).

- [ ] **Step 1: Update the tests**

In `frontend/src/components/DomainCard.test.tsx`, add:

```tsx
it('colors the provider badge from the provider key', () => {
  // render DomainCard with provider 'duckdns'; assert badge style backgroundColor is set
  // (query .provider-badge and check it has an inline background)
});
it('renders a toggle switch wired to onToggle', () => {
  // click the .switch input; expect onToggle called with the domain id
});
```

Fill these in concretely following the existing test's render setup (import `providerColor`, assert `container.querySelector('.provider-badge')?.getAttribute('style')` contains the hue; fire change on the switch checkbox).

In `frontend/src/components/DomainModal.test.tsx`, add/adjust a test asserting the record-type select has exactly the options `A` and `AAAA` (no `A + AAAA`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/components/DomainCard.test.tsx src/components/DomainModal.test.tsx`
Expected: FAIL — badge has no color / toggle absent.

- [ ] **Step 3: Implement the changes**

In `DomainCard.tsx`: import `providerColor`; set `<div className="provider-badge" style={{ background: providerColor(domain.provider) }}>`. Replace the pause/play action button with the mockup's `.switch` inside `.dc-ip` (checkbox `checked={domain.enabled}` `onChange={() => onToggle(domain.id)}`), keeping sync/edit/delete `.act-btn`s in `.dc-foot`.

In `DomainModal.tsx`: ensure the record-type `<select>` renders only `A` and `AAAA` options; confirm provider config is rendered by `SchemaForm` (it already is) — no separate token input.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/components/DomainCard.test.tsx src/components/DomainModal.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/DomainCard.tsx frontend/src/components/DomainCard.test.tsx frontend/src/components/DomainModal.tsx frontend/src/components/DomainModal.test.tsx
git commit -m "feat(frontend): provider-hue badge, toggle switch, A/AAAA-only type"
```

---

## Task 15: Assemble the shell in `App.tsx`

**Files:**
- Modify: `frontend/src/App.tsx`
- Test: `frontend/src/App.test.tsx` (create)

**Interfaces:**
- Consumes: `Rail`, `TopBar`, all five views, existing modals/toasts, `useLiveState`.
- Produces: the `.shell` grid (Rail + content), local `activeView` state, per-view title/subtitle, rail collapse/mobile state, and preserves all existing handlers (save/sync/delete/toggle domain, save/run/delete hook, save settings, refresh, theme).

- [ ] **Step 1: Write the failing test**

Create `frontend/src/App.test.tsx`:

```tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';

beforeEach(() => {
  vi.stubGlobal('WebSocket', class { close() {} } as unknown as typeof WebSocket);
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => [] })) as unknown as typeof fetch);
});
afterEach(() => vi.unstubAllGlobals());

describe('App shell', () => {
  it('starts on Overview and switches views via the rail', async () => {
    render(<App />);
    expect(screen.getByRole('heading', { name: 'Overview', level: 2 })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Domains/ }));
    expect(await screen.findByRole('heading', { name: 'Domains' })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/App.test.tsx`
Expected: FAIL — App still renders the old single-scroll layout (no rail nav / view switch).

- [ ] **Step 3: Rewrite `App.tsx`**

Restructure `App.tsx` to render the `.shell`: `<Rail>` + `.rail-scrim` + `.content` (`<TopBar>` + `<main className="page">` rendering the active view). Keep all existing state and handlers (they already exist — do not delete them). Add:
- `const [activeView, setActiveView] = useState<ViewKey>('overview');`
- rail state: `const [railMobileOpen, setRailMobileOpen] = useState(false);` (collapse/resize optional — if included, mirror the mockup's `<html class="rail-collapsed">` toggle).
- A `TITLES: Record<ViewKey, {title:string; sub:string}>` map for TopBar.
- Compute `runtimeById`, `stats`, and `enabledById` (from `domains`) as needed by the views.
- Render `<OverviewView>` / `<DomainsView>` / `<HooksView>` / `<LogsView>` / `<SettingsView>` by `activeView`, passing the existing handlers. Keep `DomainModal`, `HookModal`, and `Toasts` mounted at the root. Settings is now a view — remove the settings modal usage (or keep `SettingsView` inside the settings view). Replace `window.confirm` deletes with existing handler behavior (retain as-is to limit scope).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/App.test.tsx`
Expected: PASS.

- [ ] **Step 5: Typecheck, lint, full unit run, commit**

Run: `cd frontend && npx tsc --noEmit && npm run lint && npm test`
Expected: clean; all unit tests pass with coverage thresholds met.

```bash
git add frontend/src/App.tsx frontend/src/App.test.tsx
git commit -m "feat(frontend): assemble left-rail shell with five views"
```

---

## Task 16: Update Playwright e2e for the new shell

**Files:**
- Modify: `frontend/e2e/dashboard.spec.ts`

**Interfaces:**
- Consumes: the running app (rail nav, five views).

- [ ] **Step 1: Rewrite the e2e specs**

Update `frontend/e2e/dashboard.spec.ts` for the new navigation:
- The "add a domain" flow now starts by clicking the rail **Domains** nav item, then the Add Domain button in the Domains view; keep the modal fill/submit steps.
- The "log viewer" test navigates to the **Logs** view first, then asserts `getByTestId('log-viewer')` is visible.
- Add a test: rail navigation cycles Overview → Domains → Hooks → Logs → Settings and each view's heading appears.
- Add a test: Overview shows the reachability panel (`text=Record health` and `text=Public IP` visible).

```typescript
import { test, expect } from '@playwright/test';

test('rail navigates across all five views', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Overview', level: 2 })).toBeVisible();
  for (const [nav, heading] of [['Domains', 'Domains'], ['Hooks', 'Hooks'], ['Logs', 'Logs'], ['Settings', 'Settings']] as const) {
    await page.getByRole('button', { name: new RegExp(nav) }).click();
    await expect(page.getByRole('heading', { name: heading })).toBeVisible();
  }
});

test('overview shows the instrument panels', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Public IP')).toBeVisible();
  await expect(page.getByText('Record health')).toBeVisible();
});

test('add a domain from the Domains view', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Domains/ }).click();
  await page.getByRole('button', { name: 'Add Domain' }).click();
  const modal = page.locator('.modal');
  await expect(modal.getByRole('heading', { name: 'Add Domain' })).toBeVisible();
  await modal.getByLabel('Hostname / FQDN').fill('home.example.com');
  await modal.getByLabel('DNS Provider').selectOption({ label: 'DuckDNS' });
  await modal.getByLabel('Token', { exact: true }).fill('secret-token');
  await modal.getByLabel('Domain', { exact: true }).fill('home');
  await modal.locator('.modal-foot').getByRole('button', { name: 'Add Domain' }).click();
  await expect(page.locator('.name').filter({ hasText: 'home.example.com' })).toBeVisible();
});

test('log viewer is visible on the Logs view', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Logs/ }).click();
  await expect(page.getByTestId('log-viewer')).toBeVisible();
});
```

Adjust label/name selectors if the ported markup differs (e.g. the domain modal's hostname label). The e2e run needs the backend serving `frontend` — follow `frontend/e2e/README.md`.

- [ ] **Step 2: Run e2e**

Run: `cd frontend && npm run test:e2e`
Expected: PASS (start the backend/preview per `frontend/e2e/README.md` and `playwright.config.ts`).

- [ ] **Step 3: Commit**

```bash
git add frontend/e2e/dashboard.spec.ts
git commit -m "test(e2e): cover rail navigation and overview instrument"
```

---

## Task 17: Full verification & build

**Files:** entire `frontend/`.

- [ ] **Step 1: Typecheck, lint, unit + coverage, build**

Run: `cd frontend && npx tsc --noEmit && npm run lint && npm test && npm run build`
Expected: all clean; coverage thresholds met; production build succeeds.

- [ ] **Step 2: Manual smoke in the browser (optional but recommended)**

Run the dev server, open each of the five views, confirm the Overview instrument renders live (reachability bars, resolver latency, countdown), theme toggles, and the mobile rail drawer works at ≤860px.

- [ ] **Step 3: Commit any final fixups**

```bash
git add -A
git commit -m "chore(frontend): final overhaul verification fixups"
```

---

## Self-Review Notes

- **Spec coverage:** §1 arch → Task 15; §2 file structure → Tasks 4–15; §3 instrument → Tasks 6–10; §4 deviations → Tasks 1 (types), 13 (ip-source/settings), 14 (badge/toggle/type/schema), 8/9 (resolvers/countdown); §5 edge states → null-guards in Tasks 8/9/10/15; §6 testing → every task + Task 16/17. All covered.
- **Type consistency:** `ViewKey`, `Reachability`/`ResolverProbe`/`CheckRecord`, `providerColor`/`deriveHue`, `formatUptime`/`formatCountdown`/`relStable`, `QUORUM_BARS`, panel prop names are used identically across tasks.
- **Reused unchanged:** `HookModal`, `LogViewer`, `SchemaForm`, `Toasts`.
- **Implementer note:** exact JSX/label text of ported markup may require selector tweaks in Task 16 e2e; the plan flags this.
