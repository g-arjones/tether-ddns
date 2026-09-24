# Reachability health bar — shared `HealthBar` for Record health and Reachability

**Date:** 2026-09-24
**Status:** approved, ready for implementation planning

## Problem

The Reachability panel reports its 30-day breakdown as a run-on subtitle:
`10d observed · 12m degraded · up 3h`. The healthy/degraded/outage split is only
partly visible (the outage time appears nowhere), and it cannot be taken in at a
glance the way the Record health bar can.

The Record health bar (`RecordHealthPanel.tsx`) is hand-rolled markup
(`.health-bar` segments + `.health-legend` items). Adding a second copy to
Reachability would duplicate it, so the bar is extracted first and both panels
use it.

## Goals

- A reusable `HealthBar` component that produces the `.health-bar` +
  `.health-legend` markup for both panels.
- `RecordHealthPanel` output is unchanged by the refactor.
- The Reachability panel shows a Healthy / Degraded / Outage bar (green / yellow /
  red, the same tokens Record health uses) with a legend, placed directly under
  the uptime header.
- Every bar segment has a native `title` tooltip that gives the time in human-readable form.
- The subtitle is reduced to the observed time only.

## Non-goals

- A custom styled tooltip. Native `title` is used everywhere else (quorum bars,
  day strip, Record health) and is kept for consistency.
- Changing the headline uptime percentage or how it is computed.
- Any backend change. `uptimeStats()` already returns everything needed.

## Design

### 1. `components/HealthBar.tsx`

```tsx
export interface HealthSegment {
  key: string;
  label: string;
  color: string;      // CSS color, e.g. 'var(--ok)'
  value: number;      // flex weight (a count, or seconds)
  title: string;      // native tooltip text
  legend: ReactNode;  // rendered inside .hl-count
}

export function HealthBar({ segments }: { segments: HealthSegment[] }): JSX.Element
```

Behaviour (the same as today's `RecordHealthPanel`):

- Returns a fragment of `.health-bar` followed by `.health-legend`, so the
  existing CSS applies unchanged.
- Bar: one `<span>` per segment with `value > 0`, with
  `style={{ flex: value, background: color }}` and `title={title}`, keyed by `key`.
- If no segment has `value > 0`, it renders the single fallback
  `<span style={{ flex: 1, background: 'var(--surface-2)' }} />`.
- Legend: one `.hl-item` per segment, **always including zero-value segments**,
  in input order: `.hl-dot` (background `color`), `.hl-label` (`label`),
  `.hl-count` (`legend`).

The component does not format anything. Each panel builds its own segments.

### 2. `RecordHealthPanel` refactor

The panel keeps its counting logic and `ORDER` table. It maps each entry to
`{ key, label, color, value: counts[k], title: `${counts[k]} ${k}`, legend: counts[k] }`
and renders `<HealthBar segments={...} />` in place of the hand-rolled markup.
The rendered DOM does not change, and the existing `RecordHealthPanel.test.tsx`
must pass unmodified.

### 3. Reachability integration

Segments are derived from the existing `stats = uptimeStats(...)`:

| key | label | color | seconds |
| --- | --- | --- | --- |
| `healthy` | Healthy | `var(--ok)` | `max(0, observedSeconds − offlineSeconds − degradedSeconds)` |
| `degraded` | Degraded | `var(--warn)` | `degradedSeconds` |
| `outage` | Outage | `var(--err)` | `offlineSeconds` |

- `value` = seconds.
- Percentage = `seconds / observedSeconds * 100`, or `0` when
  `observedSeconds === 0` (then every value is 0 and the empty track renders).
- `legend` = `<><span className="hl-dur">{humanTime(seconds)}</span><span className="hl-pct">{pct}</span></>`.
- `title` = `` `${label} · ${humanTime(seconds)} (${pct})` ``, e.g. `Degraded · 12m (0.1%)`.

**Percentage formatting** (a local `formatPct` in `ReachabilityPanel.tsx`):

- `p === 0` → `0.0%`; `p === 100` → `100.0%`.
- `0 < p < 0.1` → `<0.1%` (a short outage never reads as `0.0%`).
- `99.9 < p < 100` → `>99.9%` (healthy never reads as `100.0%` while an
  incident exists).
- Otherwise `p.toFixed(1) + '%'`, matching the headline's precision.

**Placement:** `.reach-head` → `<HealthBar />` → `.panel-divider` → Live section.
This follows the Record health bar-then-divider layout.

**Subtitle:** only the observed span.

- Partial window (`observedSeconds < THIRTY_DAYS - 1`): `` `${humanTime(observedSeconds)} observed` ``,
  e.g. `10d observed`.
- Full window: `` `${DAY_BARS}d observed` `` (`30d observed`). `humanTime` would
  render a full window as `1mo`.
- The degraded fragment and the `up/down {formatUptime(r.since)}` fragment are
  removed, along with the now-unused `formatUptime` import. The Online/Offline
  badge is unchanged.

### 4. CSS (`styles.css`)

- `.hl-dur + .hl-pct { margin-left: 6px; color: var(--text-3); font-weight: 500; }`:
  on desktop the duration is primary and the percentage secondary.
- In the existing `@media (max-width: 620px)` block:
  - `.hl-dur { display: none; }`
  - `.hl-dur + .hl-pct { margin-left: 0; color: var(--text); font-weight: 700; }`
    (on mobile the percentage alone is shown, styled as primary).

Record health legends have no `.hl-dur`/`.hl-pct`, so they are unaffected.

## Testing

- **`HealthBar.test.tsx`** (new):
  - zero-value segments are omitted from the bar but present in the legend;
  - all-zero input renders one fallback span;
  - `flex` and `background` match each segment's `value` and `color`;
  - `title` is set per segment;
  - legend order follows input order.
- **`RecordHealthPanel.test.tsx`**: unchanged; must pass (proves the refactor
  preserves behaviour).
- **`ReachabilityPanel.test.tsx`**:
  - the legend shows the duration and percentage for each severity;
  - with a 10-minute outage over the 10-day fixture window, the outage tooltip
    reads `Outage · 10m (<0.1%)` and the healthy legend shows `>99.9%`;
  - the subtitle contains `observed` and neither `degraded` nor `up `;
  - the full-window subtitle reads `30d observed`;
  - the existing `'100.0%'` assertion is scoped to `.up-val`, because the legend
    can now also render `100.0%`.
- **Playwright** (`e2e/dashboard.spec.ts`): at a 390px viewport `.hl-dur` is
  hidden and `.hl-pct` is visible. At desktop width both are visible. jsdom
  cannot evaluate media queries.
- **Gates:** `npm test` (vitest + oxlint), and `npx tsc --noEmit -p tsconfig.app.json`,
  because `npm test` does not type-check.
