# Mobile Overview Stats Readout List Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** At ≤620px, render the Overview's four stat cards as one compact readout panel (about 215px tall instead of about 620px), and hide the heartbeat host there.

**Architecture:** CSS only, in the existing `@media (max-width: 620px)` block. `.stats` becomes a bordered panel, and each `.stat` becomes a 3-column grid row. `.stat-top { display: contents }` lets the label and icon join that grid without any change to `StatCard`'s markup. `HeartbeatCard` gets two markup hooks: a `.hb-host` wrapper around ` · host`, and a stable `hb` root class.

**Tech Stack:** React 19 + Vite, plain CSS (`frontend/src/styles.css`), Vitest + Testing Library, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-26-mobile-overview-stats-design.md`

## Global Constraints

- Breakpoint: only the existing `@media (max-width: 620px)` block. Nothing changes above 620px.
- `StatCard.tsx` and `OverviewView.tsx` do not change. `StatCard` stays the only producer of `.stat`.
- The failed-heartbeat error (`<span className="hb-mono">{status.error}</span>`) is never wrapped in `.hb-host` and is never hidden.
- Heartbeat root classes are exactly `stat hb`, `stat hb hb-muted` or `stat hb hb-err`.
- Monospace (`.hb-mono`) is only for the host and the error text (DESIGN.md Machine-Truth Rule).
- Every frontend command runs from `frontend/`. `npm test` runs oxlint + vitest and does **not** type-check, so always also run `npx tsc --noEmit -p tsconfig.app.json`.
- e2e binds port 8123. `playwright.config.ts` builds the frontend and starts the backend itself (`reuseExistingServer` locally), so port 8123 must be free or already running this branch's build.

---

### Task 1: `HeartbeatCard` markup hooks

**Files:**
- Modify: `frontend/src/components/HeartbeatCard.tsx` (the `className` declaration, the `cadence` helper, and the `hb-muted`/`hb-err` assignments)
- Test: `frontend/src/components/HeartbeatCard.test.tsx`

**Interfaces:**
- Consumes: nothing new.
- Produces (DOM contract that Task 2's CSS and e2e rely on):
  - The root `.stat` always has class `hb`. Its full class string is `stat hb`, `stat hb hb-muted` or `stat hb hb-err`.
  - When a URL is set and the status is null or OK, `.stat-sub-text` contains `…every N min<span class="hb-host"> · <span class="hb-mono">host</span></span>`.
  - No `.hb-host` exists in the Off, Skipped or Failed states.

- [ ] **Step 1: Write the failing tests**

In `frontend/src/components/HeartbeatCard.test.tsx`, add the type import below the existing imports:

```tsx
import type { HeartbeatStatus } from '../types';
```

Then add these tests inside the `describe('HeartbeatCard', ...)` block, after the last existing `it(...)`:

```tsx
  it('wraps the separator and host so the phone layout can hide them together', () => {
    const status = { at: at(42), ok: true, skipped: false, error: null };
    const { container } = render(<HeartbeatCard status={status} url={URL} interval={300} onPing={vi.fn()} />);
    expect(container.querySelector('.stat-sub-text')?.textContent).toBe('OK · every 5 min · hc-ping.com');
    expect(container.querySelector('.hb-host')?.textContent).toBe(' · hc-ping.com');
    expect(container.querySelector('.hb-host .hb-mono')?.textContent).toBe('hc-ping.com');
  });

  it('never puts the failure error inside the hideable host wrapper', () => {
    const status = { at: at(12), ok: false, skipped: false, error: 'HTTP 503' };
    const { container } = render(<HeartbeatCard status={status} url={URL} interval={300} onPing={vi.fn()} />);
    expect(container.querySelector('.hb-host')).toBeNull();
    expect(container.querySelector('.stat-sub-text .hb-mono')?.textContent).toBe('HTTP 503');
  });

  const classCases: [string, HeartbeatStatus | null, string | null, string][] = [
    ['Off', null, null, 'stat hb hb-muted'],
    ['No data yet', null, URL, 'stat hb'],
    ['Skipped', { at: at(5), ok: false, skipped: true, error: null }, URL, 'stat hb hb-muted'],
    ['OK', { at: at(42), ok: true, skipped: false, error: null }, URL, 'stat hb'],
    ['Failed', { at: at(12), ok: false, skipped: false, error: 'boom' }, URL, 'stat hb hb-err'],
  ];
  it.each(classCases)('marks the %s card with the stable hb class', (_name, status, url, expected) => {
    const { container } = render(<HeartbeatCard status={status} url={url} interval={300} onPing={vi.fn()} />);
    expect(container.querySelector('.stat')?.className).toBe(expected);
  });
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `cd frontend && npx vitest run src/components/HeartbeatCard.test.tsx`

Expected: FAIL.
- "wraps the separator…": `.hb-host` is null, so `textContent` is `undefined`.
- "marks the … card": the classes read `stat hb-muted`, `stat`, `stat hb-err`.
- "never puts the failure error…" already passes (no `.hb-host` exists yet). That's expected: it guards against regressions.

- [ ] **Step 3: Implement**

In `frontend/src/components/HeartbeatCard.tsx`:

Replace

```tsx
  let className: string | undefined;
```

with

```tsx
  let className = 'hb';
```

Replace the `cadence` helper

```tsx
  const cadence = (u: string) => (
    <>{`every ${formatInterval(interval)} · `}<span className="hb-mono">{hostOf(u)}</span></>
  );
```

with

```tsx
  const cadence = (u: string) => (
    <>{`every ${formatInterval(interval)}`}<span className="hb-host">{' · '}<span className="hb-mono">{hostOf(u)}</span></span></>
  );
```

Replace the three state class assignments:
- `className = 'hb-muted';` in the `url === null` branch becomes `className = 'hb hb-muted';`
- `className = 'hb-muted';` in the `status.skipped` branch becomes `className = 'hb hb-muted';`
- `className = 'hb-err';` in the failed branch becomes `className = 'hb hb-err';`

The `<StatCard ... className={className} />` call stays as it is.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `cd frontend && npx vitest run src/components/HeartbeatCard.test.tsx`
Expected: PASS, all tests. This includes the existing "shows a dash and the cadence…" test, whose `getByText('hc-ping.com')` and `getByText(/every 5 min/)` still match.

- [ ] **Step 5: Full frontend gates**

Run: `cd frontend && npm test && npx tsc --noEmit -p tsconfig.app.json`
Expected: oxlint clean, all vitest files pass, tsc prints nothing and exits 0.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/HeartbeatCard.tsx frontend/src/components/HeartbeatCard.test.tsx
git commit -m "feat(heartbeat): add hb root class and hideable host wrapper"
```

---

### Task 2: Phone readout-list CSS + e2e proof

**Files:**
- Modify: `frontend/src/styles.css`, the `@media (max-width: 620px)` block under `/* ---------- Responsive ---------- */` (currently the lines `.stats { grid-template-columns: 1fr; gap: 12px; }` and `.stat-value { font-size: 26px; }`)
- Test: `frontend/e2e/dashboard.spec.ts` (append a new test at the end of the file)

**Interfaces:**
- Consumes (from Task 1): the root `.stat.hb` (plus `.hb-muted`/`.hb-err`), and `.hb-host` wrapping ` · <span class="hb-mono">host</span>`.
- Consumes (existing `StatCard` DOM, unchanged): `.stat > .stat-top > (.stat-label, .stat-ico)`, `.stat > .stat-value`, `.stat > .stat-sub > .stat-sub-text`.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Write the failing e2e test**

Append to the end of `frontend/e2e/dashboard.spec.ts`:

```ts
// jsdom cannot evaluate media queries; only a real browser can prove the phone layout.
test('on phones the stats render as a compact readout list', async ({ page }) => {
  // The real backend has no heartbeat URL, so settings and live status are stubbed.
  await page.route('**/api/settings', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    const response = await route.fetch();
    const json = { ...(await response.json()), heartbeat_url: 'https://hc-ping.com/abc', heartbeat_interval: 60 };
    await route.fulfill({ response, json });
  });
  await page.routeWebSocket('**/api/ws', (ws) => {
    const server = ws.connectToServer();
    server.onMessage((message) => {
      const frame = JSON.parse(String(message)) as { kind: string; payload: Record<string, unknown> };
      if (frame.kind === 'state') {
        frame.payload.heartbeat = { at: Date.now() / 1000 - 35, ok: true, skipped: false, error: null };
      }
      ws.send(JSON.stringify(frame));
    });
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const rows = page.locator('.stats .stat');
  await expect(rows).toHaveCount(4);
  const heartbeat = rows.filter({ hasText: 'Heartbeat' });
  await expect(heartbeat).toContainText('every 1 min');
  await expect(heartbeat).toContainText('OK');
  const host = heartbeat.locator('.hb-host');
  await expect(host).toBeHidden();

  const cells = await rows.evaluateAll((els) => els.map((el) => ({
    labelRight: el.querySelector('.stat-label')!.getBoundingClientRect().right,
    valueLeft: el.querySelector('.stat-value')!.getBoundingClientRect().left,
  })));
  expect(cells).toHaveLength(4);
  for (const cell of cells) {
    expect(cell.valueLeft).toBeGreaterThan(cell.labelRight);
  }
  const stats = await page.locator('.stats').boundingBox();
  expect(stats?.height).toBeLessThan(260);

  await page.setViewportSize({ width: 1400, height: 900 });
  await expect(host).toBeVisible();
  await expect(host).toContainText('hc-ping.com');
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd frontend && npx playwright test e2e/dashboard.spec.ts -g "compact readout list"`

Expected: FAIL at `await expect(host).toBeHidden()`. `.hb-host` exists after Task 1 but is still visible, because no phone CSS hides it yet. If that line is temporarily skipped, the geometry assertions also fail: the stacked cards put each value *below* its label (valueLeft < labelRight), and `.stats` is about 620px tall.

- [ ] **Step 3: Implement the phone CSS**

In `frontend/src/styles.css`, inside the `@media (max-width: 620px)` block under `/* ---------- Responsive ---------- */`, replace exactly these two lines:

```css
  .stats { grid-template-columns: 1fr; gap: 12px; }
  .stat-value { font-size: 26px; }
```

with:

```css
  /* one readout panel, one row per stat; .stat-top dissolves so label + icon join the row grid */
  .stats {
    display: block; margin: 20px 0; padding: 2px 14px;
    background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
  }
  .stat {
    display: grid; grid-template-columns: 28px minmax(0, 1fr) auto;
    grid-template-areas: "ico label value" "ico sub value";
    column-gap: 11px; align-items: center; padding: 10px 0; overflow: visible;
    background: none; border: 0; border-top: 1px solid var(--border); border-radius: 0;
  }
  .stat:first-child { border-top: 0; }
  .stat:hover { transform: none; box-shadow: none; border-color: var(--border); }
  .stat-top { display: contents; }
  .stat-ico { grid-area: ico; width: 28px; height: 28px; border-radius: 8px; }
  .stat-ico svg { width: 15px; height: 15px; }
  .stat-label {
    grid-area: label; align-self: end;
    font-size: 13px; color: var(--text); text-transform: none; letter-spacing: normal;
  }
  .stat-sub { grid-area: sub; align-self: start; min-width: 0; margin-top: 0; font-size: 11.5px; color: var(--text-3); }
  .stat-value { grid-area: value; font-size: 19px; letter-spacing: -.5px; font-variant-numeric: tabular-nums; }
  .hb .stat-value { font-size: 15px; }
  .hb-host { display: none; }
  .hb-err { border-color: var(--border); }
  .hb-err .stat-label { color: var(--err); }
```

Why this cascade works (don't "fix" it):
- `.hb-err .stat-value` and `.hb-err .stat-sub` (desktop rules, specificity 0,2,0) still beat the phone `.stat-sub`/`.stat-value` colours (0,1,0), so failed stays red.
- `.hb-muted .stat-value` (0,2,0) still makes Off/Skipped muted.
- The phone `.hb-err { border-color }` comes after the phone `.stat` rule at equal specificity, so it replaces the desktop red border with the neutral divider.
- `.stat-ico-btn` hover ring, focus outline, `:disabled` and `.spin` are width-independent and keep working.

- [ ] **Step 4: Run the new test and confirm it passes**

Run: `cd frontend && npx playwright test e2e/dashboard.spec.ts -g "compact readout list"`
Expected: PASS.

- [ ] **Step 5: Visual check at 390px**

Playwright's webServer stops when the test run ends, so start a throwaway server yourself. Run it in a background terminal, from the repo root:

```bash
(cd frontend && npm run build) && TETHER_DDNS_HOME_PATH=$(mktemp -d) TETHER_DDNS_PORT=8123 .venv/bin/python -m tether_ddns
```

Then, from `frontend/`:

```bash
node -e "
const {chromium}=require('playwright');(async()=>{const b=await chromium.launch();
const p=await b.newPage({viewport:{width:390,height:844}});await p.goto('http://127.0.0.1:8123/');
await p.waitForSelector('.stats .stat');await p.screenshot({path:'/tmp/overview-390.png'});await b.close();})()"
```

Stop the throwaway server afterwards. It uses port 8123, which Step 6's e2e run needs.

Open `/tmp/overview-390.png`. Expected:
- one bordered panel with 4 rows and dividers between them;
- icons on the left, labels in normal case with the detail line underneath, values right-aligned;
- the Healthchecks/Public IP panels are visible below the panel in the first screen.

If anything differs from the spec's layout, fix the CSS before continuing.

- [ ] **Step 6: Full gates**

Run: `cd frontend && npm test && npx tsc --noEmit -p tsconfig.app.json && npm run test:e2e`

Expected: all pass. In particular, "all four stat cards share one row geometry" (1400px) and "overview shows the heartbeat card as Off by default" must still pass unchanged.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/styles.css frontend/e2e/dashboard.spec.ts
git commit -m "feat(overview): compact readout list for stats on phones"
```
