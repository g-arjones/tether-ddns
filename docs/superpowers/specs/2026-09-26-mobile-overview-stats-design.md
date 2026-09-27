# Mobile Overview stats: readout list

**Date:** 2026-09-26
**Status:** approved, ready for implementation planning

## Problem

On phones (≤620px) the Overview's three `StatCard`s and the `HeartbeatCard` stack into
one column of full-size cards. Each card holds one number and one line of text, but
the block is about 620px tall. It fills the first screen of a 390×844 phone, so none of
the panels below it (Healthchecks, Public IP, Record health, Reachability) are visible
without scrolling.

Desktop (4 columns) and tablet (2×2, ≤1000px) look fine.

## Goals

- At ≤620px, render the four stats as one bordered panel with one compact row each:
  a tinted icon, the label with its detail line under it, and the value right-aligned.
  The block should be about 215px tall.
- Drop the heartbeat host (`hc-ping.com`) from the phone layout, since it barely fits.
  Keep `OK · every 1 min`.
- Every existing state keeps its meaning and colour: warn tint when records need an
  update, red for a failed heartbeat, muted for Off/Skipped, and the spinner while
  pinging.
- Nothing changes above 620px.

## Non-goals

- Tablet (621–1000px) and desktop layouts.
- Merging or renaming stats (e.g. "2 / 2 synced"), or showing which record is pending.
- A container query. The switch is the existing `@media (max-width: 620px)` block.
- Any change to `StatCard`'s props or to `OverviewView`.
- Any backend change.

## Design

The approved mockup is B v2 from the visual companion
(`.superpowers/brainstorm/*/content/mobile-stats-b-v2.html`, local only because
`.superpowers/` is gitignored).

### 1. Markup: `HeartbeatCard` (changed)

`components/HeartbeatCard.tsx`:

- **Host wrapper.** `cadence(u)` currently renders
  `every 1 min · <span class="hb-mono">host</span>`. The separator and host move into
  one wrapper so CSS can hide them together:

  ```tsx
  <>{`every ${formatInterval(interval)}`}<span className="hb-host">{' · '}<span className="hb-mono">{hostOf(u)}</span></span></>
  ```

  The failed branch (`<span className="hb-mono">{status.error}</span>`) is **not**
  wrapped. An error is never hidden.
- **Stable class.** The card always gets `hb`: `className` becomes `'hb'`,
  `'hb hb-muted'` or `'hb hb-err'`. `StatCard` already prefixes `stat `, so the root is
  e.g. `stat hb hb-err`.

`StatCard.tsx` does not change. It stays the only producer of `.stat`.

### 2. CSS: phone layout (changed)

These rules go in the existing `@media (max-width: 620px)` block of `styles.css`,
replacing its current `.stats { grid-template-columns: 1fr; gap: 12px; }` and
`.stat-value { font-size: 26px; }`.

**Panel**

- `.stats`
  - `display: block; margin: 20px 0;`
  - `background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);`
  - `padding: 2px 14px;`

**Rows**

- `.stat`
  - `display: grid; grid-template-columns: 28px minmax(0, 1fr) auto;`
  - `grid-template-areas: "ico label value" "ico sub value";`
  - `column-gap: 11px; align-items: center; padding: 10px 0;`
  - `background: none; border: 0; border-radius: 0; overflow: visible;`
  - `border-top: 1px solid var(--border);`
- `.stat:first-child { border-top: 0; }`
- `.stat:hover { transform: none; box-shadow: none; border-color: var(--border); }`
  (no lift inside a panel, and hovering doesn't recolour the divider).
- `.stat-top { display: contents; }`

**Cells**

- `.stat-ico`
  - `grid-area: ico; width: 28px; height: 28px; border-radius: 8px;`
  - `.stat-ico svg { width: 15px; height: 15px; }`
  - On the heartbeat row this is still the Ping button: 28px, which meets WCAG 2.2's
    24px minimum target size.
- `.stat-label`
  - `grid-area: label; align-self: end;`
  - `font-size: 13px; font-weight: 600; color: var(--text); text-transform: none; letter-spacing: normal;`
  - Labels read "Total Domains", "Synced", "Needs Update", "Heartbeat".
- `.stat-sub`
  - `grid-area: sub; align-self: start; margin-top: 0;`
  - `font-size: 11.5px; color: var(--text-2);`
  - `.stat-sub-text` keeps its ellipsis.
- `.stat-value`
  - `grid-area: value; font-size: 19px; letter-spacing: -.5px; font-variant-numeric: tabular-nums;`
- `.hb .stat-value { font-size: 15px; }`

**Heartbeat states**

- `.hb-host { display: none; }`
- `.hb-err` has no border to colour on phones, so it turns the label red instead:
  `.hb-err .stat-label { color: var(--err); }`.
- `.hb-err .stat-value` and `.hb-err .stat-sub` are already red (desktop rule).
- `.hb-muted .stat-value` is already `--text-3` (desktop rule).

The `stat-ico-btn` hover ring, focus outline, `:disabled` cursor and `.spin` animation
already apply at every width.

### 3. Resulting states (phone)

| State | Icon tint | Detail line | Value |
|---|---|---|---|
| OK | ok, button | `OK · every 1 min` | `35s ago` |
| No data yet | muted, button | `every 1 min` | `—` |
| Pinging | spinner, disabled | as before | as before |
| Skipped | warn, button | `Link offline` | `Skipped` (muted) |
| Failed | err, button | `HTTP 503 …` in mono, red, ellipsis, full text in tooltip | `Failed` (red); label red |
| Off | muted, not a button | `Set a URL in Settings` | `Off` (muted) |

## Testing

### Unit (Vitest, `HeartbeatCard.test.tsx`)

- With a URL set and status OK or null, the host text is inside `.hb-host`, and the
  `.hb-host` element also contains the ` · ` separator.
- In the failed state, the error text is present and is **not** inside `.hb-host`.
- In every branch (Off, null, Skipped, OK, Failed), the root `.stat` has class `hb`.
  Failed also has `hb-err`, and Off and Skipped also have `hb-muted`.

### E2E (Playwright, `e2e/dashboard.spec.ts`)

jsdom cannot evaluate media queries, so the layout needs a real browser.

- **Fixture.** The real backend has no heartbeat URL, so the test follows the
  `stubHealthchecks` pattern:
  - `page.route('**/api/settings')` falls back for non-GET requests. For GET it fetches
    the real response, sets `heartbeat_url: 'https://hc-ping.com/abc'` and
    `heartbeat_interval: 60`, and fulfills with it;
  - `page.routeWebSocket('**/api/ws')` proxies to the server and splices
    `heartbeat: { at: now - 35, ok: true, skipped: false, error: null }` into every
    `state` frame.
- **New test: "on phones the stats render as a compact readout list".**
  - At 390×844 there are 4 `.stat` rows.
  - In every row, `.stat-value`'s left edge is greater than `.stat-label`'s right edge.
  - `.stats` height is < 260px.
  - The heartbeat row contains `every 1 min`, and its `.hb-host` is hidden.
  - After resizing to 1400×900, `.hb-host` is visible and contains `hc-ping.com`.
- **Unchanged:** "all four stat cards share one row geometry" (1400px) and "overview
  shows the heartbeat card as Off by default".

### Gates

- `npm test` (vitest + oxlint)
- `npx tsc --noEmit -p tsconfig.app.json`
- `npm run test:e2e`
