# Healthchecks Overview panel — summary bar + growing chips

**Date:** 2026-09-26
**Status:** approved design (option D, refined), ready for implementation planning
**Mockups:** `.superpowers/brainstorm/1140154-1790458406/content/healthchecks-panel-options.html`
(the five directions) and `healthchecks-d-refined.html` (the approved design at desktop and phone width).

## Problem

The Overview `HealthchecksPanel` looks empty and doesn't stand out, yet its check states are
the most important information in it. Today each project is a `.hc-row` grid: a 120–180px
left column (name + `HcSummary`) and small `.hc-badge` pills on the right. With a few checks
the panel is mostly whitespace. The only way to see a problem is to read each badge. There is
no panel-level signal.

The layout also has to hold up with many checks and several projects. Fixed-size "square"
cards would wrap into ragged, half-empty rows. The layout has to resize with the panel width
and still wrap.

## Goals

- Problems are visible before reading any check name: a panel-level worst-state pill, plus a
  per-project bar coloured by the checks' states.
- Every row of chips is filled edge to edge, whether there are 2 checks or 40.
- It works at phone width (≈340px panel) without squeezing the bar or wrapping the header.
- It follows DESIGN.md: healthy checks stay neutral and only late/down get colour, which
  keeps the Silent-Until-State rule. No resting shadows, and monospace only for the elapsed
  time.
- Stateless data (unknown project, gone check) never reads as green.

## Non-goals

- No backend change. `ProjectRuntime` already has everything needed. There is no "last
  *successful* poll" timestamp, and none is added.
- The Healthchecks view (`ProjectCard`, `ChecksTable`) is unchanged.
- No sorting option. Chips keep their configured (fetched) order.
- No custom tooltip. The native `title` is kept, as everywhere else.
- No change to the existing `HealthBar` component. The new bar has its own markup (one
  segment per check), and `HealthBar` always renders a legend.

## Design

### 1. Panel header

```
Healthchecks  [● 1 down]                                  1 project · 5 checks
```

- `<h4>Healthchecks</h4>`, then the **worst-state pill**, then `.sub`, which is pushed right.
  None of them wrap (`white-space: nowrap`).
- `.sub` = `"{n} project(s)"` followed by `<span class="hcp-n-checks"> · {m} checks</span>`.
  The checks part is hidden in the narrow layout (§5). `m` counts only the checks shown
  (visible checks of projects shown on the Overview).
- The pill is computed over the same set of checks, with this priority:
  1. any `down` → red pill `"{n} down"`
  2. else any `grace` → amber pill `"{n} late"`
  3. else any shown project is unknown (`projectUnknown(runtime)`) → neutral dashed pill `"unknown"`
  4. else, if every check is `up` → green pill `"All up"`
  5. else (some paused / new / gone, none failing) → green pill `"{n} up"`, where `n` is the
     number of `up` checks. This follows principle 1: don't claim "All up" when some checks
     aren't.
- The pill logic is a pure function in `utils.ts` (e.g. `overviewPill(rows) → { status, text }`),
  tested on its own.

### 2. Project block

One `.hcp-proj` per shown project. Blocks after the first get a top border and 14–16px of
spacing, as in the mockup.

**Head row** (`.hcp-head`, flex, `gap: 12px`, vertically centred):

```
Homelab  [███ ▌▌▌▌▌ ▌▌]  4 up · 1 down
```

- Project name (`<strong>`, 13px, `flex: none`).
- **Bar** (`.hcp-bar`, `flex: 1`, `min-width: 60px`, height 8px, radius 4px, `overflow: hidden`,
  `aria-hidden="true"`). The summary text carries the same information for screen readers.
- The existing `HcSummary` component (no `withTotal`). It already renders `"status unknown"` and
  bolds down/late in colour.

**Bar segments:** one `<span>` per shown check, each `flex: 1`, `gap: 2px`, sorted by
severity **down → grace → up → paused → new → gone**. That way red always sits at the left
and the segment boundaries let you count the checks. Colours:

| state | segment |
|---|---|
| up | `--ok` |
| grace | `--warn` |
| down | `--err` |
| paused, new | `--border-strong` |
| gone | dashed: `repeating-linear-gradient(90deg, var(--border-strong) 0 3px, transparent 3px 5px)` |

- **Unknown project:** no per-check segments. The bar gets a class (e.g. `.hcp-bar.hc-unknown`)
  and is drawn as one hatched fill:
  `repeating-linear-gradient(135deg, var(--surface-2) 0 4px, var(--border) 4px 7px)`.
- **Density guard:** over 40 checks in one project, the 2px gaps would eat the bar. The bar
  gets `.dense`, which sets `gap: 0`. Neighbouring segments of the same colour then merge
  into runs, still in severity order.

**Unknown note** (only when `projectUnknown(runtime)`), one line under the head row, 12px:

| condition | text | style |
|---|---|---|
| `runtime?.offline` | `System is offline — polling paused.` | `--text-2` |
| `runtime && !runtime.ok && runtime.error` | `Last poll failed: {error}` | `--err` ink |
| otherwise (no runtime / `polled_at === null`) | `Waiting for first poll.` | `--text-2` |

The first two strings are copied from `ProjectCard`'s banner so both views use the same
words. This replaces the mockup's "last successful poll 12m ago", because that timestamp
doesn't exist.

### 3. Chips

`.hcp-chips` is `display: flex; flex-wrap: wrap; gap: 6px`. Each `.hcp-chip`:

- `flex: 1 0 auto`. Chips never shrink below their content and grow to fill the row, so every
  wrapped row is flush on both edges.
- `max-width: 100%`. The name span gets `min-width: 0; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap`, so a very long check name on a phone truncates instead of pushing the
  chip past the panel.
- Height 34px, padding `0 12px`, radius 9px, `--surface-2` background, 1px `--border` border,
  13px/600 text.
- Contents: status dot (8px), the check name (live upstream name first, then the fetched
  name, as today), the existing visually hidden `.hc-sr` `"{label}: "` prefix, and a trailing
  time label (`margin-left: auto`, mono 11.5px, `--text-3`).
- Time label: `up` / `grace` / `down` → elapsed time since `last_ping` in short form without
  "ago" (`4m`, `1d`, `—` when `last_ping` is null). `paused` / `new` / `gone` / `unknown` show
  the state word instead.
  - Add a small exported helper to `utils.ts` (e.g. `elapsedShort(ts, nowMs)`) and have `ago()`
    reuse it, rather than stripping `" ago"` off a string.
- `title`: `"{label} · last ping {ago(last_ping, nowMs)}"` (unchanged from today's badge).

State styling (modifier class `hc-{display}`, the same vocabulary as pills and dots):

| state | chip |
|---|---|
| up | neutral chip, green dot |
| grace | `--warn-soft` bg, no border, `--warn` ink (text + time), amber dot |
| down | `--err-soft` bg, no border, `--err` ink, red dot |
| paused, new | neutral chip, `--text-3` text, `--text-3` dot |
| gone, unknown | transparent bg, 1px **dashed** `--border-strong`, `--text-3` text, dashed hollow dot |

An unrecognised status class must never render green (same rule as the existing pill/dot
e2e test).

### 4. Class names

New classes use the `hcp-` prefix (Healthchecks Panel). This avoids collisions with global
utilities (see the `.empty` footgun) and with the existing `.hc-ov-toggle`. Status is always
the existing `hc-{display}` modifier.

Removed from `styles.css` along with the markup (they have no other users): `.hc-row`,
`.hc-row-name`, `.hc-badges`, `.hc-badge*`, and the `.hc-row*` rules in the 620px media block.
`.hc-panel` stays on the root (e2e and `.ov-grid > .hc-panel + .panel` rely on it).

### 5. Narrow layout

`.hc-panel` gets `container-type: inline-size`, and the narrow rules sit in
`@container (max-width: 520px)`. A container query is used instead of the 620px media query
because the panel's width, not the viewport's, decides whether the bar fits.

- `.hcp-head` wraps (`row-gap: 8px`). The bar takes `order: 3; flex-basis: 100%`, so it gets
  its own full-width line under `name · summary`. The summary is pushed right and may wrap.
- `.hcp-n-checks` is hidden.
- Chips don't change. `flex: 1 0 auto` already reflows them.

### 6. Accessibility

- The pill's text states the worst state. The bar is `aria-hidden`, and `HcSummary` gives the
  same counts as text.
- Chips keep the `.hc-sr` status prefix, so state isn't conveyed by colour alone. Late/down
  chips also differ in background and ink, and unknown/gone in border style.
- The failed-poll note stays plain text, not `role="alert"`. The Overview re-renders on every
  ws frame, and an alert would re-announce each time.

## Testing

**Vitest (`HealthchecksPanel.test.tsx`, rewritten for the new markup):**
- One `.hcp-proj` per shown project. Chips appear only for visible checks. The panel renders
  nothing when no project has visible checks on the Overview.
- Chip state classes (`hc-up`/`hc-down`/`hc-gone`/…) and time labels (`1m` for a ping 60s
  ago, the state word for paused/new/gone/unknown).
- Bar: segment count equals the number of shown checks, in severity order (the first segment
  is `hc-down` when one exists). An unknown project renders the hatched bar with no segments.
  `.dense` is applied above 40 checks.
- Header: pill text/state for each priority branch, and `.sub` with the check count.
- Unknown note text for offline / failed (`HTTP 503`) / never polled, and no note when the
  poll is fine.
- The live upstream name wins over the fetched name (kept from the current tests).

**Vitest (`utils` tests):** `overviewPill` for all 5 branches. `elapsedShort` boundaries, and
`ago()` output unchanged.

**Playwright (`e2e/healthchecks.spec.ts`):**
- Update the Overview test to use `.hcp-chip` instead of `.hc-badge` (count 3,
  `.hcp-chip.hc-down` contains `SSL (hydrogen)`, `.hcp-chip.hc-gone` contains `Old job`).
  Keep the stats → panel → IP panel geometry check.
- Update the "every status is styled" test: replace the `.hc-badge` probe with a
  `.hcp-chip hc-{status}` probe (dot colour + dashed for gone/unknown, and a bogus class never
  reads as up).
- **New** geometry test at 375×812: the bar is on its own line and ≥ 90% of the project
  block's width. The header pill's height equals one line (no wrap). No chip's right edge
  goes past the panel's content box. jsdom has no layout engine, so only a real browser can
  prove this.
- **New** at 1400px: every chip row is flush. The last chip in each wrapped row ends within
  1px of the chips container's right edge.

**Gates:** `npm test` (vitest + oxlint), `npx tsc --noEmit -p tsconfig.app.json`, and
`npm run test:e2e`.
