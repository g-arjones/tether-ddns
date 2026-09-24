# Reachability Health Bar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the Record health bar into a reusable `HealthBar` component and use it to add a Healthy / Degraded / Outage bar and legend to the Reachability panel. The panel subtitle becomes the observed span only.

**Architecture:** `HealthBar` is purely presentational. It takes pre-built segments (`value` for flex weight, `title` for the native tooltip, a `legend` node) and renders the existing `.health-bar` + `.health-legend` markup. `RecordHealthPanel` switches to it with identical output. `ReachabilityPanel` builds three segments from the `uptimeStats()` it already computes. On mobile, CSS hides the duration part of the legend.

**Tech Stack:** React 19 + TypeScript, Vitest + React Testing Library (jsdom), Playwright, plain CSS (`frontend/src/styles.css`).

**Spec:** `docs/superpowers/specs/2026-09-24-reachability-health-bar-design.md`

## Global Constraints

- Run all commands from `frontend/` unless stated otherwise.
- Gates for every task: `npm test` (oxlint + vitest with coverage) AND `npx tsc --noEmit -p tsconfig.app.json`. `npm test` does NOT type-check.
- Colors: Healthy `var(--ok)`, Degraded `var(--warn)`, Outage `var(--err)`. These are the same tokens Record health uses.
- Tooltips use the native `title` attribute only. No custom tooltip component.
- Percent format: `toFixed(1)` + `%`, except `0 < p < 0.1` → `<0.1%` and `99.9 < p < 100` → `>99.9%`.
- Durations in the Reachability legend and tooltips use `humanTime()` from `src/utils.ts`.
- Mobile breakpoint is the existing `@media (max-width: 620px)` block. Do not add a new breakpoint.
- Use namespaced class names only (`hl-dur`, `hl-pct`). Global utility classes such as `.empty` collide.
- Component tests freeze time with `vi.useFakeTimers({ toFake: ['Date'] })` at a fixed LOCAL noon. `ReachabilityPanel.test.tsx` already does this, so reuse its `NOW_MS`.
- Use `import type` for type-only imports (see existing components).
- Comments: one short line, only for what the code cannot say itself.

## File Structure

| File | Change | Responsibility |
| --- | --- | --- |
| `frontend/src/components/HealthBar.tsx` | Create | Renders `.health-bar` segments + `.health-legend` items from `HealthSegment[]`. |
| `frontend/src/components/HealthBar.test.tsx` | Create | Unit tests for HealthBar. |
| `frontend/src/components/RecordHealthPanel.tsx` | Modify | Build segments from counts; render `<HealthBar>`. |
| `frontend/src/components/RecordHealthPanel.test.tsx` | Modify (add one test) | Characterisation test for bar/legend output. |
| `frontend/src/components/ReachabilityPanel.tsx` | Modify | Severity segments, `formatPct`, subtitle simplification. |
| `frontend/src/components/ReachabilityPanel.test.tsx` | Modify | New behaviour tests; scope the existing `100.0%` assertion. |
| `frontend/src/styles.css` | Modify | `.hl-dur + .hl-pct` desktop styling; mobile override. |
| `frontend/e2e/dashboard.spec.ts` | Modify | Responsive legend geometry test. |

---

### Task 1: `HealthBar` component and `RecordHealthPanel` refactor

**Files:**
- Create: `frontend/src/components/HealthBar.tsx`
- Create: `frontend/src/components/HealthBar.test.tsx`
- Modify: `frontend/src/components/RecordHealthPanel.tsx` (the `.health-bar` / `.health-legend` block, currently lines 40-52)
- Modify: `frontend/src/components/RecordHealthPanel.test.tsx` (add one test)

**Interfaces:**
- Consumes: nothing new.
- Produces (used by Task 2):
  ```ts
  export interface HealthSegment {
    key: string;
    label: string;
    color: string;
    value: number;
    title: string;
    legend: ReactNode;
  }
  export interface HealthBarProps { segments: HealthSegment[] }
  export function HealthBar({ segments }: HealthBarProps): JSX.Element
  ```

- [ ] **Step 1: Add a characterisation test to `RecordHealthPanel.test.tsx`**

This locks down the current bar and legend output before the refactor. It must PASS against the unmodified code. Append inside the existing `describe('RecordHealthPanel', ...)` block:

```tsx
  it('renders one bar segment per non-empty status and every legend entry', () => {
    const { container } = render(
      <RecordHealthPanel domains={domains} enabledById={{ a: true, b: true }} nextCheckAt={null} checkInterval={300} />,
    );
    const bar = [...container.querySelectorAll<HTMLElement>('.health-bar span')];
    expect(bar.map((s) => s.title)).toEqual(['1 synced', '1 error']);
    expect(bar.map((s) => s.style.background)).toEqual(['var(--ok)', 'var(--err)']);
    const legend = [...container.querySelectorAll('.hl-item')].map((el) => [
      el.querySelector('.hl-label')?.textContent,
      el.querySelector('.hl-count')?.textContent,
    ]);
    expect(legend).toEqual([['Synced', '1'], ['Pending', '0'], ['Error', '1'], ['Paused', '0']]);
  });
```

- [ ] **Step 2: Run it and confirm it passes on the current code**

Run: `npx vitest run src/components/RecordHealthPanel.test.tsx`
Expected: 4 tests PASS.

- [ ] **Step 3: Write the failing HealthBar tests**

Create `frontend/src/components/HealthBar.test.tsx`:

```tsx
import { render } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { HealthBar, type HealthSegment } from './HealthBar';

const segments: HealthSegment[] = [
  { key: 'a', label: 'Alpha', color: 'red', value: 3, title: '3 alpha', legend: 3 },
  { key: 'b', label: 'Beta', color: 'blue', value: 0, title: '0 beta', legend: 0 },
  { key: 'c', label: 'Gamma', color: 'green', value: 1, title: '1 gamma', legend: 'one' },
];

function barSpans(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('.health-bar span')];
}

describe('HealthBar', () => {
  test('draws only non-empty segments, weighted by value', () => {
    const { container } = render(<HealthBar segments={segments} />);
    const bar = barSpans(container);
    expect(bar.map((s) => s.style.flexGrow)).toEqual(['3', '1']);
    expect(bar.map((s) => s.style.background)).toEqual(['red', 'green']);
  });

  test('gives every drawn segment its tooltip', () => {
    const { container } = render(<HealthBar segments={segments} />);
    expect(barSpans(container).map((s) => s.title)).toEqual(['3 alpha', '1 gamma']);
  });

  test('lists every segment in the legend, including empty ones, in order', () => {
    const { container } = render(<HealthBar segments={segments} />);
    const legend = [...container.querySelectorAll('.hl-item')].map((el) => [
      el.querySelector('.hl-label')?.textContent,
      el.querySelector('.hl-count')?.textContent,
      (el.querySelector('.hl-dot') as HTMLElement).style.background,
    ]);
    expect(legend).toEqual([
      ['Alpha', '3', 'red'],
      ['Beta', '0', 'blue'],
      ['Gamma', 'one', 'green'],
    ]);
  });

  test('draws an empty track when nothing has a value', () => {
    const empty = segments.map((s) => ({ ...s, value: 0 }));
    const { container } = render(<HealthBar segments={empty} />);
    const bar = barSpans(container);
    expect(bar).toHaveLength(1);
    expect(bar[0].style.background).toBe('var(--surface-2)');
    expect(bar[0].hasAttribute('title')).toBe(false);
  });
});
```

- [ ] **Step 4: Run it and confirm it fails**

Run: `npx vitest run src/components/HealthBar.test.tsx`
Expected: FAIL. The import of `./HealthBar` cannot be resolved.

- [ ] **Step 5: Implement `HealthBar`**

Create `frontend/src/components/HealthBar.tsx`:

```tsx
import type { JSX, ReactNode } from 'react';

export interface HealthSegment {
  key: string;
  label: string;
  color: string;
  value: number;
  title: string;
  legend: ReactNode;
}

export interface HealthBarProps {
  segments: HealthSegment[];
}

export function HealthBar({ segments }: HealthBarProps): JSX.Element {
  const drawn = segments.filter((s) => s.value > 0);
  return (
    <>
      <div className="health-bar">
        {drawn.length ? drawn.map((s) => (
          <span key={s.key} style={{ flex: s.value, background: s.color }} title={s.title} />
        )) : <span style={{ flex: 1, background: 'var(--surface-2)' }} />}
      </div>
      <div className="health-legend">
        {segments.map((s) => (
          <div className="hl-item" key={s.key}>
            <span className="hl-dot" style={{ background: s.color }} />
            <span className="hl-label">{s.label}</span>
            <span className="hl-count">{s.legend}</span>
          </div>
        ))}
      </div>
    </>
  );
}
```

- [ ] **Step 6: Run the HealthBar tests and confirm they pass**

Run: `npx vitest run src/components/HealthBar.test.tsx`
Expected: 4 tests PASS.

- [ ] **Step 7: Refactor `RecordHealthPanel` onto `HealthBar`**

In `frontend/src/components/RecordHealthPanel.tsx`:

1. Add the import below the existing imports:
   ```tsx
   import { HealthBar } from './HealthBar';
   ```
2. Replace the line `const segs = ORDER.filter(([k]) => counts[k] > 0);` with:
   ```tsx
   const segments = ORDER.map(([k, label, color]) => ({
     key: k, label, color, value: counts[k], title: `${counts[k]} ${k}`, legend: counts[k],
   }));
   ```
3. Replace the whole `<div className="health-bar">…</div>` and `<div className="health-legend">…</div>` block with:
   ```tsx
   <HealthBar segments={segments} />
   ```

- [ ] **Step 8: Run the RecordHealthPanel and HealthBar tests**

Run: `npx vitest run src/components/RecordHealthPanel.test.tsx src/components/HealthBar.test.tsx`
Expected: 8 tests PASS. The Step 1 characterisation test must still pass without edits.

- [ ] **Step 9: Run the gates**

Run: `npm test && npx tsc --noEmit -p tsconfig.app.json`
Expected: oxlint clean, all vitest tests pass, coverage thresholds met, and tsc exits 0 with no output.

- [ ] **Step 10: Commit**

```bash
git add frontend/src/components/HealthBar.tsx frontend/src/components/HealthBar.test.tsx \
  frontend/src/components/RecordHealthPanel.tsx frontend/src/components/RecordHealthPanel.test.tsx
git commit -m "refactor(RecordHealthPanel): extract reusable HealthBar component"
```

---

### Task 2: Reachability health bar and subtitle

**Files:**
- Modify: `frontend/src/components/ReachabilityPanel.tsx`
- Modify: `frontend/src/components/ReachabilityPanel.test.tsx`

**Interfaces:**
- Consumes: `HealthBar`, `HealthSegment` from `./HealthBar` (Task 1); `humanTime`, `uptimeStats` from `../utils`.
- Produces: DOM consumed by Task 3's CSS and e2e test. Each Reachability legend `.hl-count` contains exactly `<span class="hl-dur">…</span><span class="hl-pct">…</span>`.

Fixture arithmetic (the test file's `emptyWindow` has `monitoring_since = NOW - 10d`, so `observedSeconds = 864000`):
- A 10‑minute outage is 600 s = 0.069 % → `<0.1%`, `humanTime(600)` = `10m`. Healthy is 863400 s = 99.93 % → `>99.9%`, `humanTime` = `9d 23h`.
- Adding a 1‑day degraded incident: degraded 86400 s = `1d`, `10.0%`. Healthy is 777000 s = 89.93 % → `89.9%`, `humanTime` = `8d 23h`.

- [ ] **Step 1: Write the failing tests**

In `frontend/src/components/ReachabilityPanel.test.tsx`:

1. Change the import line `import type { IncidentWindow, Reachability } from '../types';` to:
   ```tsx
   import type { Incident, IncidentWindow, Reachability } from '../types';
   ```
2. Add these fixtures and a helper directly below `const emptyWindow …;`:
   ```tsx
   const tenMinuteOutage: Incident = {
     start: NOW - 3600, end: NOW - 3000, severity: 'outage',
     min_successes: 0, total: 3, failed: ['1.1.1.1', '8.8.8.8', '9.9.9.9'],
   };
   const oneDayDegraded: Incident = {
     start: NOW - 3 * 86400, end: NOW - 2 * 86400, severity: 'degraded',
     min_successes: 1, total: 3, failed: ['8.8.8.8', '9.9.9.9'],
   };

   function legend(container: HTMLElement): Record<string, [string, string]> {
     const out: Record<string, [string, string]> = {};
     for (const item of container.querySelectorAll('.hl-item')) {
       out[item.querySelector('.hl-label')?.textContent ?? ''] = [
         item.querySelector('.hl-dur')?.textContent ?? '',
         item.querySelector('.hl-pct')?.textContent ?? '',
       ];
     }
     return out;
   }
   ```
3. Replace the existing test `renders the clamped uptime percentage` with this scoped version. The legend now also renders `100.0%`, so `getByText` would find two matches:
   ```tsx
   test('renders the clamped uptime percentage', () => {
     const { container } = renderPanel(emptyWindow);
     expect(container.querySelector('.up-val')?.textContent).toBe('100.0%');
   });
   ```
4. Append these tests inside the `describe` block:
   ```tsx
   test('breaks the observed window into healthy, degraded and outage time', () => {
     const { container } = renderPanel({ ...emptyWindow, incidents: [oneDayDegraded, tenMinuteOutage] });
     expect(legend(container)).toEqual({
       Healthy: ['8d 23h', '89.9%'],
       Degraded: ['1d', '10.0%'],
       Outage: ['10m', '<0.1%'],
     });
   });

   test('never rounds a tiny outage away from the healthy share', () => {
     const { container } = renderPanel({ ...emptyWindow, incidents: [tenMinuteOutage] });
     expect(legend(container).Healthy).toEqual(['9d 23h', '>99.9%']);
   });

   test('shows an all-healthy window with empty degraded and outage entries', () => {
     const { container } = renderPanel(emptyWindow);
     expect(legend(container)).toEqual({
       Healthy: ['10d', '100.0%'],
       Degraded: ['0s', '0.0%'],
       Outage: ['0s', '0.0%'],
     });
   });

   test('gives each drawn health segment a human-readable tooltip', () => {
     const { container } = renderPanel({ ...emptyWindow, incidents: [tenMinuteOutage] });
     const titles = [...container.querySelectorAll<HTMLElement>('.health-bar span')].map((s) => s.title);
     expect(titles).toEqual(['Healthy · 9d 23h (>99.9%)', 'Outage · 10m (<0.1%)']);
   });

   test('keeps the subtitle to the observed span only', () => {
     const { container } = renderPanel({ ...emptyWindow, incidents: [oneDayDegraded] });
     expect(container.querySelector('.up-sub')?.textContent).toBe('10d observed');
   });

   test('labels a full window as thirty days observed', () => {
     const { container } = renderPanel({ ...emptyWindow, monitoring_since: NOW - 40 * 86400 });
     expect(container.querySelector('.up-sub')?.textContent).toBe('30d observed');
   });
   ```

- [ ] **Step 2: Run the tests and confirm the new ones fail**

Run: `npx vitest run src/components/ReachabilityPanel.test.tsx`
Expected: the 6 new tests FAIL. There is no `.hl-item` yet, and the subtitle still contains ` · 1d degraded · up 1h` / `30 days`. The pre-existing tests (including the rescoped `100.0%` one) PASS.

- [ ] **Step 3: Implement the Reachability changes**

In `frontend/src/components/ReachabilityPanel.tsx`:

1. Replace the imports at the top with:
   ```tsx
   import type { JSX } from 'react';
   import type { IncidentWindow, Reachability } from '../types';
   import {
     formatDuration, humanTime, uptimeStats, type DayBucket,
   } from '../utils';
   import { HealthBar, type HealthSegment } from './HealthBar';
   ```
   (`formatUptime` is removed. `formatDuration` stays because `dayLabel` uses it.)
2. Add below `const THIRTY_DAYS = DAY_BARS * 86400;`:
   ```tsx
   const SEVERITIES = [
     ['healthy', 'Healthy', 'var(--ok)'],
     ['degraded', 'Degraded', 'var(--warn)'],
     ['outage', 'Outage', 'var(--err)'],
   ] as const;

   // Never let a non-zero share round to 0.0% or a non-full share round to 100.0%.
   function formatPct(p: number): string {
     if (p > 0 && p < 0.1) return '<0.1%';
     if (p > 99.9 && p < 100) return '>99.9%';
     return `${p.toFixed(1)}%`;
   }
   ```
3. Inside `ReachabilityPanel`, directly after `const partial = …;`, add:
   ```tsx
   const seconds = {
     healthy: Math.max(0, stats.observedSeconds - stats.offlineSeconds - stats.degradedSeconds),
     degraded: stats.degradedSeconds,
     outage: stats.offlineSeconds,
   };
   const segments: HealthSegment[] = SEVERITIES.map(([key, label, color]) => {
     const s = seconds[key];
     const pct = formatPct(stats.observedSeconds > 0 ? (s / stats.observedSeconds) * 100 : 0);
     const dur = humanTime(s);
     return {
       key, label, color, value: s,
       title: `${label} · ${dur} (${pct})`,
       legend: <><span className="hl-dur">{dur}</span><span className="hl-pct">{pct}</span></>,
     };
   });
   ```
4. Replace the whole `<span className="up-sub">…</span>` element with:
   ```tsx
   <span className="up-sub">
     {partial ? `${humanTime(stats.observedSeconds)} observed` : `${DAY_BARS}d observed`}
   </span>
   ```
5. Directly after the closing `</div>` of `.reach-head` and before `<div className="reach-label">Live · …`, insert:
   ```tsx
   <HealthBar segments={segments} />

   <div className="panel-divider" />

   ```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run src/components/ReachabilityPanel.test.tsx`
Expected: all tests PASS (8 pre-existing + 6 new = 14).

- [ ] **Step 5: Check the tests hold in UTC**

Run: `TZ=UTC npx vitest run src/components/ReachabilityPanel.test.tsx`
Expected: all 14 PASS. CI runs in UTC, and the fixtures are pinned to local noon.

- [ ] **Step 6: Run the gates**

Run: `npm test && npx tsc --noEmit -p tsconfig.app.json`
Expected: oxlint clean, all vitest tests pass including `OverviewView.test.tsx` and `App*.test.tsx`, coverage thresholds met, tsc exits 0.

If any `App*.test.tsx`/`OverviewView.test.tsx` assertion used `getByText` on a string that now also appears in the legend (for example `100.0%`), scope it to its intended element the same way as Step 1.3. Do not change the component to satisfy it.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/ReachabilityPanel.tsx frontend/src/components/ReachabilityPanel.test.tsx
git commit -m "feat(ReachabilityPanel): add healthy/degraded/outage health bar; subtitle shows observed span only"
```

---

### Task 3: Responsive legend styling

**Files:**
- Modify: `frontend/src/styles.css` (after the `.hl-count` rule, currently line 327; inside the `@media (max-width: 620px)` block, currently lines 584-597)
- Modify: `frontend/e2e/dashboard.spec.ts` (append)

**Interfaces:**
- Consumes: the `.hl-dur` / `.hl-pct` markup from Task 2 (only Reachability legend items have them).
- Produces: nothing.

- [ ] **Step 1: Write the failing e2e test**

Append to `frontend/e2e/dashboard.spec.ts`:

```ts
// jsdom cannot evaluate media queries; only a real browser can prove the mobile legend.
test('the reachability legend drops durations on mobile but keeps percentages', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  const dur = page.locator('.ov-wide .hl-dur').first();
  const pct = page.locator('.ov-wide .hl-pct').first();
  await expect(dur).toBeVisible();
  await expect(pct).toBeVisible();
  await expect(pct).toHaveCSS('margin-left', '6px');

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(dur).toBeHidden();
  await expect(pct).toBeVisible();
  await expect(pct).toHaveCSS('margin-left', '0px');
});
```

- [ ] **Step 2: Run it and confirm it fails**

Make sure nothing is listening on port 8123 first (`ss -ltn 'sport = :8123'` should print only the header). `reuseExistingServer` would otherwise serve a stale build.

Run: `npx playwright test e2e/dashboard.spec.ts -g "reachability legend"`
Expected: FAIL at `toHaveCSS('margin-left', '6px')` (received `0px`), because no styling exists yet.

- [ ] **Step 3: Add the CSS**

In `frontend/src/styles.css`, directly after the `.hl-count { … }` rule, add:

```css
.hl-dur + .hl-pct { margin-left: 6px; color: var(--text-3); font-weight: 500; }
```

Inside the existing `@media (max-width: 620px) { … }` block, add as its last two rules (before its closing `}`):

```css
  .hl-dur { display: none; }
  .hl-dur + .hl-pct { margin-left: 0; color: var(--text); font-weight: 700; }
```

- [ ] **Step 4: Run the e2e test and confirm it passes**

Run: `npx playwright test e2e/dashboard.spec.ts -g "reachability legend"`
Expected: PASS.

- [ ] **Step 5: Run the full e2e suite and the unit gates**

Run: `npx playwright test && npm test && npx tsc --noEmit -p tsconfig.app.json`
Expected: all e2e tests pass, including `the live strip stays inside its box and does not starve the layout` (the new bar must not starve the Record health column). All vitest tests pass and tsc exits 0.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/styles.css frontend/e2e/dashboard.spec.ts
git commit -m "style(HealthBar): mute legend percentage on desktop, show it alone on mobile"
```
