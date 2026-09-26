# Healthchecks Overview Panel Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Overview Healthchecks panel's left-column + small-badge layout with a worst-state header pill, a per-project segmented bar, and full-width growing chips (approved "option D, refined").

**Architecture:** Two pure helpers (`elapsedShort`, `overviewPill`) go in `utils.ts`. `HealthchecksPanel.tsx` is rewritten to render them with `hcp-*` markup. The header pill reuses the existing `.hc-pill hc-{status}` classes, so all its states are already styled. New CSS replaces the `.hc-row`/`.hc-badge` rules. A container query on `.hc-panel` gives the bar its own line on narrow panels. No backend change.

**Tech Stack:** React 19 + TypeScript, Vitest + Testing Library (jsdom), Playwright, plain CSS (`frontend/src/styles.css`).

**Spec:** `docs/superpowers/specs/2026-09-26-healthchecks-overview-panel-design.md`
**Approved mockup:** `.superpowers/brainstorm/1140154-1790458406/content/healthchecks-d-refined.html`

## Global Constraints

- All commands run from `frontend/` unless stated otherwise.
- New class names use the `hcp-` prefix. Status is always the existing `hc-{display}` modifier (`hc-up`, `hc-grace`, `hc-down`, `hc-paused`, `hc-new`, `hc-gone`, `hc-unknown`). Never use generic class names: global utilities such as `.empty` exist in `styles.css` and collide.
- `.hc-panel` must stay on the panel root. e2e relies on `.hc-panel` and `.ov-grid > .hc-panel + .panel`.
- Colours only from existing tokens: `--ok`, `--warn`, `--err`, `--ok-soft`, `--warn-soft`, `--err-soft`, `--surface-2`, `--border`, `--border-strong`, `--text`, `--text-2`, `--text-3`, `--mono`. No new tokens.
- Bar severity order: `down → grace → up → paused → new → gone`.
- Dense bar threshold: more than **40** checks in one project → `.dense` (`gap: 0`).
- Narrow breakpoint: `@container (max-width: 520px)` on `.hc-panel` (`container-type: inline-size`).
- Unknown-note copy (verbatim): `System is offline — polling paused.` / `Last poll failed: {error}` / `Waiting for first poll.`
- Pill copy: `{n} down`, `{n} late`, `unknown`, `All up`, `{n} up`. **Plan clarification of spec §1.5:** if *no* shown check is up (all paused/new/gone), the pill is `{ status: 'paused', text: '0 up' }` (neutral grey). A green "0 up" would say healthy when nothing is up.
- Only one short line per code comment, and only for what the code can't show.
- Gates: `npm test` (runs oxlint first, then vitest with coverage) does **not** type-check, so also run `npx tsc --noEmit -p tsconfig.app.json`. e2e: `npm run test:e2e`.
- e2e reuses any server already listening on **:8123** (`reuseExistingServer`), which would serve a stale bundle. Make sure nothing is on 8123 before running e2e: `ss -ltn | grep -q ':8123 ' && echo BUSY`.
- Commit only the files each task lists: `git add <paths>` then `git commit -m ...`, never `git add -A`.

---

### Task 1: Pure helpers `elapsedShort` and `overviewPill`

**Files:**
- Modify: `frontend/src/utils.ts` (the `ago` block near line 216 and the healthchecks helpers near lines 161–195)
- Test: `frontend/src/utils.healthchecks.test.ts`

**Interfaces:**
- Consumes: existing `CheckDisplay`, `checkDisplayStatus(runtime, key)`, `HealthcheckRef`, `ProjectRuntime`, `AGO_UNITS`, `plural` (all already in `utils.ts` / `types.ts`).
- Produces (exported from `src/utils.ts`):
  - `elapsedShort(ts: number | null, nowMs: number): string` returns `'4m'`, `'11h'`, `'4mo'`, `'0s'`, or `'—'` for null.
  - `interface OverviewRow { refs: HealthcheckRef[]; runtime: ProjectRuntime | undefined }`
  - `interface OverviewPill { status: CheckDisplay; text: string }`
  - `overviewPill(rows: OverviewRow[]): OverviewPill`
  - `ago()` keeps its exact output.

- [ ] **Step 1: Write the failing tests**

In `frontend/src/utils.healthchecks.test.ts`, change the import line to:

```ts
import { ago, checkDisplayStatus, elapsedShort, hostOf, humanDuration, overviewPill, projectSummary } from './utils';
```

Append these blocks at the end of the file:

```ts
describe('elapsedShort', () => {
  const at = (secondsAgo: number) => NOW_MS / 1000 - secondsAgo;
  it('renders the largest unit without the "ago" suffix', () => {
    expect(elapsedShort(at(0), NOW_MS)).toBe('0s');
    expect(elapsedShort(at(14), NOW_MS)).toBe('14s');
    expect(elapsedShort(at(60), NOW_MS)).toBe('1m');
    expect(elapsedShort(at(11 * 3600), NOW_MS)).toBe('11h');
    expect(elapsedShort(at(130 * 86400), NOW_MS)).toBe('4mo');
  });
  it('renders a dash for never', () => {
    expect(elapsedShort(null, NOW_MS)).toBe('—');
  });
});

describe('overviewPill', () => {
  const row = (checks: Record<string, CheckStatus>, over: Partial<ProjectRuntime> = {}) => ({
    refs: Object.keys(checks).map(ref),
    runtime: rt({ checks, ...over }),
  });
  it('headlines the down count across every project', () => {
    expect(overviewPill([
      row({ a: status('up'), b: status('down') }),
      row({ c: status('down'), d: status('grace') }),
    ])).toEqual({ status: 'down', text: '2 down' });
  });
  it('headlines late checks when nothing is down', () => {
    expect(overviewPill([row({ a: status('up'), b: status('grace') })])).toEqual({ status: 'grace', text: '1 late' });
  });
  it('reports unknown when a project cannot be polled and nothing is failing', () => {
    expect(overviewPill([
      row({ a: status('up') }),
      row({ b: status('up') }, { offline: true }),
    ])).toEqual({ status: 'unknown', text: 'unknown' });
  });
  it('lets a real failure outrank an unknown project', () => {
    expect(overviewPill([
      row({ a: status('down') }),
      { refs: [ref('z')], runtime: undefined },
    ])).toEqual({ status: 'down', text: '1 down' });
  });
  it('says All up only when every shown check is up', () => {
    expect(overviewPill([row({ a: status('up'), b: status('up') })])).toEqual({ status: 'up', text: 'All up' });
  });
  it('counts up checks when some are paused, new or gone', () => {
    const r = row({ a: status('up'), b: status('paused') });
    expect(overviewPill([{ ...r, refs: [...r.refs, ref('gone-key')] }])).toEqual({ status: 'up', text: '1 up' });
  });
  it('stays neutral when no shown check is up', () => {
    expect(overviewPill([row({ a: status('paused'), b: status('new') })])).toEqual({ status: 'paused', text: '0 up' });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/utils.healthchecks.test.ts`
Expected: FAIL. `elapsedShort` / `overviewPill` are not exported (a TypeError "is not a function", or a module export error).

- [ ] **Step 3: Implement**

In `frontend/src/utils.ts`, replace the existing `ago` function (keep `AGO_UNITS` above it unchanged) with:

```ts
function elapsedUnit(ts: number, nowMs: number): [number, string, string] {
  const elapsed = Math.max(0, Math.floor(nowMs / 1000 - ts));
  const [size, unit, abbr] = AGO_UNITS.find(([s]) => elapsed >= s) ?? AGO_UNITS[AGO_UNITS.length - 1];
  return [Math.floor(elapsed / size), unit, abbr];
}

export function elapsedShort(ts: number | null, nowMs: number): string {
  if (ts === null) return '—';
  const [n, , abbr] = elapsedUnit(ts, nowMs);
  return `${n}${abbr}`;
}

export function ago(ts: number | null, nowMs: number, short = false): string {
  if (ts === null) return '—';
  if (short) return `${elapsedShort(ts, nowMs)} ago`;
  const [n, unit] = elapsedUnit(ts, nowMs);
  return `${plural(n, unit)} ago`;
}
```

Directly after the existing `projectSummary` function, add:

```ts
export interface OverviewRow { refs: HealthcheckRef[]; runtime: ProjectRuntime | undefined; }
export interface OverviewPill { status: CheckDisplay; text: string; }

export function overviewPill(rows: OverviewRow[]): OverviewPill {
  const counts = new Map<CheckDisplay, number>();
  let total = 0;
  for (const { refs, runtime } of rows) {
    for (const ref of refs) {
      const display = checkDisplayStatus(runtime, ref.key);
      counts.set(display, (counts.get(display) ?? 0) + 1);
      total += 1;
    }
  }
  const n = (s: CheckDisplay) => counts.get(s) ?? 0;
  if (n('down') > 0) return { status: 'down', text: `${n('down')} down` };
  if (n('grace') > 0) return { status: 'grace', text: `${n('grace')} late` };
  if (n('unknown') > 0) return { status: 'unknown', text: 'unknown' };
  if (n('up') === 0) return { status: 'paused', text: '0 up' };
  if (n('up') === total) return { status: 'up', text: 'All up' };
  return { status: 'up', text: `${n('up')} up` };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/utils.healthchecks.test.ts`
Expected: PASS, including the unchanged `ago` tests.

Run: `npx tsc --noEmit -p tsconfig.app.json`
Expected: no output (exit 0).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/utils.ts frontend/src/utils.healthchecks.test.ts
git commit -m "feat(frontend): add elapsedShort and overviewPill helpers"
```

---

### Task 2: Rewrite `HealthchecksPanel` + CSS

**Files:**
- Modify: `frontend/src/components/HealthchecksPanel.tsx` (full rewrite)
- Modify: `frontend/src/styles.css` (Healthchecks section, lines ~625–663)
- Test: `frontend/src/components/HealthchecksPanel.test.tsx` (full rewrite)

**Interfaces:**
- Consumes from Task 1: `elapsedShort(ts, nowMs)`, `overviewPill(rows)`. Existing: `ago`, `checkDisplayStatus`, `projectUnknown`, `DISPLAY_LABEL`, `CheckDisplay` from `../utils`; `HcSummary` from `./HcSummary` (renders `<span class="hc-sum">`, and `status unknown` when the project is unknown).
- Produces: the same `HealthchecksPanel({ projects, runtime, nowMs })` props as today (the `OverviewView.tsx` call site does not change). DOM contract used by Task 3:
  - root `.panel.ov-wide.hc-panel`; header `.panel-head` > `h4`, `.hc-pill.hc-{status}`, `.sub` (containing `.hcp-n-checks`)
  - per project `.hcp-proj` > `.hcp-head` (> `strong`, `.hcp-bar[aria-hidden]` with `span.hc-{display}` children, `.hc-sum`), optional `.hcp-note[.hcp-note-err]`, `.hcp-chips` > `.hcp-chip.hc-{display}` (> `i`, `.hcp-name`, `.hcp-time`)

- [ ] **Step 1: Write the failing tests**

Replace the whole of `frontend/src/components/HealthchecksPanel.test.tsx` with:

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { CheckStatus, HealthcheckRef, HealthchecksProject, ProjectRuntime } from '../types';
import { HealthchecksPanel } from './HealthchecksPanel';

const NOW_MS = new Date(2026, 8, 25, 12, 0, 0).getTime();
const st = (name: string, s: CheckStatus['status']): CheckStatus => ({
  name, slug: name, status: s, last_ping: NOW_MS / 1000 - 60, next_ping: null, timeout: 60, schedule: null, tz: null, grace: 60,
});
const project = (over: Partial<HealthchecksProject> = {}): HealthchecksProject => ({
  id: 'p1', name: 'Homelab', base_url: 'https://healthchecks.io/', api_key: '********', poll_interval: 300,
  show_on_overview: true, fetched_at: 1,
  checks: [
    { key: 'a', name: 'Backup', slug: 'backup', visible: true },
    { key: 'b', name: 'SSL', slug: 'ssl', visible: true },
    { key: 'c', name: 'Hidden', slug: 'hidden', visible: false },
    { key: 'd', name: 'Old job', slug: 'old', visible: true },
  ],
  ...over,
});
const runtime: Record<string, ProjectRuntime> = {
  p1: { polled_at: 1, ok: true, error: null, offline: false, checks: { a: st('Backup', 'up'), b: st('SSL', 'down'), c: st('Hidden', 'up') } },
};
const draw = (projects: HealthchecksProject[], rt: Record<string, ProjectRuntime> | undefined = runtime) =>
  render(<HealthchecksPanel projects={projects} runtime={rt} nowMs={NOW_MS} />).container;

describe('HealthchecksPanel', () => {
  it('renders a chip per visible check with its state and last-ping age', () => {
    const container = draw([project()]);
    const chips = [...container.querySelectorAll('.hcp-chip')];
    expect(chips.map((c) => c.className)).toEqual(['hcp-chip hc-up', 'hcp-chip hc-down', 'hcp-chip hc-gone']);
    expect(chips.map((c) => c.querySelector('.hcp-name')?.textContent)).toEqual(['up: Backup', 'down: SSL', 'gone: Old job']);
    expect(chips.map((c) => c.querySelector('.hcp-time')?.textContent)).toEqual(['1m', '1m', 'gone']);
    expect(chips[1]).toHaveAttribute('title', 'down · last ping 1 minute ago');
    expect(screen.queryByText('Hidden')).toBeNull();
    expect(container.querySelector('.hcp-head .hc-sum')?.textContent).toBe('1 up · 1 down · 1 gone');
  });

  it('draws one hidden-from-AT bar segment per visible check, worst first', () => {
    const bar = draw([project()]).querySelector('.hcp-bar')!;
    expect(bar).toHaveAttribute('aria-hidden', 'true');
    expect([...bar.children].map((s) => s.className)).toEqual(['hc-down', 'hc-up', 'hc-gone']);
    expect(bar.classList.contains('dense')).toBe(false);
  });

  it('headlines the worst state and counts the shown checks', () => {
    const container = draw([project()]);
    expect(screen.getByRole('heading', { name: 'Healthchecks' })).toBeInTheDocument();
    const pill = container.querySelector('.panel-head .hc-pill')!;
    expect(pill.className).toBe('hc-pill hc-down');
    expect(pill.textContent).toBe('1 down');
    expect(container.querySelector('.panel-head .sub')?.textContent).toBe('1 project · 3 checks');
    expect(container.querySelector('.hcp-note')).toBeNull();
  });

  it.each([
    ['offline', { ...runtime.p1, offline: true }, 'System is offline — polling paused.', false],
    ['failed', { ...runtime.p1, ok: false, error: 'HTTP 503' }, 'Last poll failed: HTTP 503', true],
    ['never polled', undefined, 'Waiting for first poll.', false],
  ] as const)('renders an unknown project stateless with the reason (%s)', (_, rt, text, err) => {
    const container = draw([project()], rt ? { p1: rt } : undefined);
    const bar = container.querySelector('.hcp-bar')!;
    expect(bar.className).toBe('hcp-bar hc-unknown');
    expect(bar.children).toHaveLength(0);
    const chips = [...container.querySelectorAll('.hcp-chip')];
    expect(chips.map((c) => c.className)).toEqual(Array(3).fill('hcp-chip hc-unknown'));
    expect(chips.map((c) => c.querySelector('.hcp-time')?.textContent)).toEqual(Array(3).fill('unknown'));
    const note = container.querySelector('.hcp-note')!;
    expect(note.textContent).toBe(text);
    expect(note.classList.contains('hcp-note-err')).toBe(err);
    expect(note).not.toHaveAttribute('role');
    expect(screen.getByText('status unknown')).toBeInTheDocument();
    expect(container.querySelector('.panel-head .hc-pill')?.textContent).toBe('unknown');
  });

  it('packs the bar without gaps only above 40 checks', () => {
    const many = (n: number): HealthchecksProject => {
      const refs: HealthcheckRef[] = Array.from({ length: n }, (_, i) => ({ key: `k${i}`, name: `Job ${i}`, slug: `k${i}`, visible: true }));
      return project({ checks: refs });
    };
    const allUp = (n: number) => ({
      p1: { ...runtime.p1, checks: Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, st(`Job ${i}`, 'up')])) },
    });
    expect(draw([many(40)], allUp(40)).querySelector('.hcp-bar')?.classList.contains('dense')).toBe(false);
    expect(draw([many(41)], allUp(41)).querySelector('.hcp-bar')?.classList.contains('dense')).toBe(true);
  });

  it('renders one block per shown project and pluralises the header', () => {
    const second = project({ id: 'p2', name: 'VPS', checks: [{ key: 'x', name: 'Uptime', slug: 'up', visible: true }] });
    const rt = { ...runtime, p2: { ...runtime.p1, checks: { x: st('Uptime', 'up') } } };
    const container = draw([project(), second], rt);
    expect([...container.querySelectorAll('.hcp-proj .hcp-head strong')].map((s) => s.textContent)).toEqual(['Homelab', 'VPS']);
    expect(container.querySelector('.panel-head .sub')?.textContent).toBe('2 projects · 4 checks');
  });

  it('is omitted when no project has visible checks on the Overview', () => {
    const container = draw([project({ show_on_overview: false }), project({ id: 'p2', checks: [] })]);
    expect(container.firstChild).toBeNull();
  });

  it('prefers the live upstream name over the fetched one', () => {
    const renamed = { p1: { ...runtime.p1, checks: { ...runtime.p1.checks, a: st('Nightly backup', 'up') } } };
    draw([project()], renamed);
    expect(screen.getByText('Nightly backup')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/components/HealthchecksPanel.test.tsx`
Expected: FAIL. No `.hcp-chip` / `.hcp-bar` elements (the old markup renders `.hc-badge`).

- [ ] **Step 3: Rewrite the component**

Replace the whole of `frontend/src/components/HealthchecksPanel.tsx` with:

```tsx
import type { JSX } from 'react';
import type { HealthcheckRef, HealthchecksProject, ProjectRuntime } from '../types';
import {
  DISPLAY_LABEL, ago, checkDisplayStatus, elapsedShort, overviewPill, projectUnknown, type CheckDisplay,
} from '../utils';
import { HcSummary } from './HcSummary';

export interface HealthchecksPanelProps {
  projects: HealthchecksProject[];
  runtime: Record<string, ProjectRuntime> | undefined;
  nowMs: number;
}

const BAR_ORDER: CheckDisplay[] = ['down', 'grace', 'up', 'paused', 'new', 'gone'];
const DENSE_AFTER = 40;
const TIMED: CheckDisplay[] = ['up', 'grace', 'down'];

function unknownNote(rt: ProjectRuntime | undefined): { text: string; err: boolean } {
  if (rt?.offline) return { text: 'System is offline — polling paused.', err: false };
  if (rt && !rt.ok && rt.error) return { text: `Last poll failed: ${rt.error}`, err: true };
  return { text: 'Waiting for first poll.', err: false };
}

interface ProjectBlockProps {
  project: HealthchecksProject;
  refs: HealthcheckRef[];
  rt: ProjectRuntime | undefined;
  nowMs: number;
}

function ProjectBlock({ project, refs, rt, nowMs }: ProjectBlockProps): JSX.Element {
  const unknown = projectUnknown(rt);
  const items = refs.map((ref) => ({ ref, display: checkDisplayStatus(rt, ref.key) }));
  const segments = [...items].sort((a, b) => BAR_ORDER.indexOf(a.display) - BAR_ORDER.indexOf(b.display));
  const note = unknown ? unknownNote(rt) : null;
  const barClass = `hcp-bar${unknown ? ' hc-unknown' : ''}${refs.length > DENSE_AFTER ? ' dense' : ''}`;
  return (
    <div className="hcp-proj">
      <div className="hcp-head">
        <strong>{project.name}</strong>
        <div className={barClass} aria-hidden="true">
          {unknown ? null : segments.map(({ ref, display }) => <span key={ref.key} className={`hc-${display}`} />)}
        </div>
        <HcSummary refs={refs} runtime={rt} />
      </div>
      {note ? <div className={`hcp-note${note.err ? ' hcp-note-err' : ''}`}>{note.text}</div> : null}
      <div className="hcp-chips">
        {items.map(({ ref, display }) => {
          const live = rt?.checks[ref.key];
          return (
            <span
              key={ref.key}
              className={`hcp-chip hc-${display}`}
              title={`${DISPLAY_LABEL[display]} · last ping ${ago(live?.last_ping ?? null, nowMs)}`}
            >
              <i aria-hidden="true" />
              <span className="hcp-name">
                <span className="hc-sr">{DISPLAY_LABEL[display]}: </span>
                {live?.name ?? ref.name}
              </span>
              <span className="hcp-time">
                {TIMED.includes(display) ? elapsedShort(live?.last_ping ?? null, nowMs) : DISPLAY_LABEL[display]}
              </span>
            </span>
          );
        })}
      </div>
    </div>
  );
}

export function HealthchecksPanel({ projects, runtime, nowMs }: HealthchecksPanelProps): JSX.Element | null {
  const rows = projects
    .filter((p) => p.show_on_overview)
    .map((p) => ({ project: p, refs: p.checks.filter((c) => c.visible), runtime: runtime?.[p.id] }))
    .filter((row) => row.refs.length > 0);
  if (rows.length === 0) return null;
  const pill = overviewPill(rows);
  const total = rows.reduce((n, row) => n + row.refs.length, 0);
  return (
    <div className="panel ov-wide hc-panel">
      <div className="panel-head">
        <h4>Healthchecks</h4>
        <span className={`hc-pill hc-${pill.status}`}><i aria-hidden="true" />{pill.text}</span>
        <span className="sub">
          {rows.length} {rows.length === 1 ? 'project' : 'projects'}
          <span className="hcp-n-checks"> · {total} {total === 1 ? 'check' : 'checks'}</span>
        </span>
      </div>
      {rows.map(({ project, refs, runtime: rt }) => (
        <ProjectBlock key={project.id} project={project} refs={refs} rt={rt} nowMs={nowMs} />
      ))}
    </div>
  );
}
```

`rows` elements have `{ project, refs, runtime }`, so they satisfy `OverviewRow` structurally and can be passed straight to `overviewPill`.

- [ ] **Step 4: Replace the CSS**

In `frontend/src/styles.css`, Healthchecks section:

(a) Change the comment line
`/* status: pill (table), badge (overview), dot (narrow table) */`
to
`/* status: pill (table + overview header), chip (overview), dot (narrow table) */`

(b) Remove every `.hc-badge` selector from the status block. The block becomes exactly:

```css
.hc-pill { display: inline-flex; align-items: center; gap: 6px; border-radius: 999px; font-weight: 600; white-space: nowrap; border: 1px solid transparent; padding: 2px 8px; font-size: 12px; }
.hc-pill i, .hc-dot { display: inline-block; flex: none; width: 7px; height: 7px; border-radius: 50%; }
.hc-pill.hc-paused, .hc-pill.hc-new { color: var(--text-2); }
.hc-pill.hc-up { color: var(--ok); background: var(--ok-soft); }
.hc-pill.hc-grace { color: var(--warn); background: var(--warn-soft); }
.hc-pill.hc-down { color: var(--err); background: var(--err-soft); }
.hc-pill.hc-gone, .hc-pill.hc-unknown { color: var(--text-3); background: transparent; border: 1px dashed var(--border-strong); }
.hc-pill.hc-up i, .hc-dot.hc-up { background: var(--ok); }
.hc-pill.hc-grace i, .hc-dot.hc-grace { background: var(--warn); }
.hc-pill.hc-down i, .hc-dot.hc-down { background: var(--err); }
.hc-pill.hc-paused i, .hc-dot.hc-paused,
.hc-pill.hc-new i, .hc-dot.hc-new { background: var(--text-3); }
.hc-pill.hc-gone i, .hc-dot.hc-gone,
.hc-pill.hc-unknown i, .hc-dot.hc-unknown { background: transparent; border: 1px dashed var(--text-3); }
```

(c) Replace the `/* overview panel */` block (`.hc-row` … `.hc-badges` rules) with:

```css
/* overview panel */
.hc-panel { container-type: inline-size; }
.hc-panel .panel-head { justify-content: flex-start; gap: 10px; }
.hc-panel .panel-head h4, .hc-panel .panel-head .sub { white-space: nowrap; }
.hc-panel .panel-head .sub { margin-left: auto; }
.hcp-proj + .hcp-proj { margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--border); }
.hcp-head { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; }
.hcp-head strong { flex: none; font-size: 13px; }
.hcp-head .hc-sum { white-space: nowrap; }
.hcp-bar { flex: 1; min-width: 60px; display: flex; gap: 2px; height: 8px; border-radius: 4px; overflow: hidden; }
.hcp-bar.dense { gap: 0; }
.hcp-bar span { flex: 1; }
.hcp-bar .hc-up { background: var(--ok); }
.hcp-bar .hc-grace { background: var(--warn); }
.hcp-bar .hc-down { background: var(--err); }
.hcp-bar .hc-paused, .hcp-bar .hc-new { background: var(--border-strong); }
.hcp-bar .hc-gone { background: repeating-linear-gradient(90deg, var(--border-strong) 0 3px, transparent 3px 5px); }
.hcp-bar.hc-unknown { background: repeating-linear-gradient(135deg, var(--surface-2) 0 4px, var(--border) 4px 7px); }
.hcp-note { margin: -2px 0 10px; font-size: 12px; color: var(--text-2); }
.hcp-note.hcp-note-err { color: var(--err); }
.hcp-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.hcp-chip { flex: 1 0 auto; max-width: 100%; display: inline-flex; align-items: center; gap: 8px; height: 34px; padding: 0 12px; border-radius: 9px; background: var(--surface-2); border: 1px solid var(--border); font-size: 13px; font-weight: 600; color: var(--text); }
.hcp-chip i { flex: none; width: 8px; height: 8px; border-radius: 50%; }
.hcp-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hcp-time { flex: none; margin-left: auto; padding-left: 10px; font-family: var(--mono); font-size: 11.5px; font-weight: 600; letter-spacing: -.3px; color: var(--text-3); }
/* Every chip state is explicit; the base dot has no fill, so an unhandled state never reads as up. */
.hcp-chip.hc-up i { background: var(--ok); }
.hcp-chip.hc-grace { background: var(--warn-soft); border-color: transparent; color: var(--warn); }
.hcp-chip.hc-grace i { background: var(--warn); }
.hcp-chip.hc-down { background: var(--err-soft); border-color: transparent; color: var(--err); }
.hcp-chip.hc-down i { background: var(--err); }
.hcp-chip.hc-grace .hcp-time, .hcp-chip.hc-down .hcp-time { color: inherit; opacity: .8; }
.hcp-chip.hc-paused, .hcp-chip.hc-new { color: var(--text-3); }
.hcp-chip.hc-paused i, .hcp-chip.hc-new i { background: var(--text-3); }
.hcp-chip.hc-gone, .hcp-chip.hc-unknown { color: var(--text-3); background: transparent; border: 1px dashed var(--border-strong); }
.hcp-chip.hc-gone i, .hcp-chip.hc-unknown i { background: transparent; border: 1px dashed var(--text-3); }
@container (max-width: 520px) {
  .hcp-head { flex-wrap: wrap; row-gap: 8px; }
  .hcp-head .hc-sum { margin-left: auto; white-space: normal; text-align: right; }
  .hcp-bar { order: 3; flex-basis: 100%; }
  .hcp-n-checks { display: none; }
}
```

(d) In the `@media (max-width: 620px)` block of the same section, delete these two now-dead lines:

```css
  .hc-row { grid-template-columns: 1fr; gap: 8px; }
  .hc-row-name strong { display: inline; margin-right: 6px; }
```

(e) Verify nothing else references the removed classes:

Run (from repo root): `grep -rnE "hc-badge|hc-row|hc-badges" frontend/src`
Expected: no output. `frontend/e2e/healthchecks.spec.ts` still references `.hc-badge`; Task 3 fixes that.

- [ ] **Step 5: Run the tests and gates**

Run: `npx vitest run src/components/HealthchecksPanel.test.tsx`
Expected: PASS (8 tests + 3 `it.each` cases).

Run: `npm test`
Expected: oxlint clean, all vitest files pass, coverage thresholds met.

Run: `npx tsc --noEmit -p tsconfig.app.json`
Expected: exit 0, no output.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/HealthchecksPanel.tsx frontend/src/components/HealthchecksPanel.test.tsx frontend/src/styles.css
git commit -m "feat(frontend): redesign Healthchecks overview panel with summary bar and chips"
```

---

### Task 3: Playwright coverage (layout the jsdom tests can't see)

**Files:**
- Modify: `frontend/e2e/healthchecks.spec.ts`

**Interfaces:**
- Consumes from Task 2: the DOM contract listed there (`.hc-panel`, `.panel-head .hc-pill`, `.hcp-n-checks`, `.hcp-head`, `.hcp-bar`, `.hcp-chips`, `.hcp-chip.hc-{display}`).
- Produces: nothing consumed later.

- [ ] **Step 1: Let `stubHealthchecks` take custom data, and add a many-checks fixture**

In `frontend/e2e/healthchecks.spec.ts`, directly after the `RUNTIME` constant, add:

```ts
const MANY_KEYS = Array.from({ length: 24 }, (_, i) => `k${i}`);
const jobName = (i: number) => `Job ${'x'.repeat(i % 7)}${i}`;
const MANY_PROJECT = {
  ...PROJECT,
  checks: MANY_KEYS.map((key, i) => ({ key, name: jobName(i), slug: key, visible: true })),
};
const MANY_RUNTIME = {
  p1: {
    ...RUNTIME.p1,
    checks: Object.fromEntries(MANY_KEYS.map((key, i) => [key, check(jobName(i), key, i === 3 ? 'down' : 'up', 600)])),
  },
};
```

Change the `stubHealthchecks` signature and its two data references:

```ts
async function stubHealthchecks(page: Page, project: object = PROJECT, runtime: object = RUNTIME): Promise<void> {
  await page.route('**/api/healthchecks', async (route) => {
    if (route.request().method() === 'GET') await route.fulfill({ json: [project] });
    else await route.fallback();
  });
  await page.routeWebSocket('**/api/ws', (ws) => {
    const server = ws.connectToServer();
    server.onMessage((message) => {
      const frame = JSON.parse(String(message)) as { kind: string; payload: Record<string, unknown> };
      if (frame.kind === 'state') frame.payload.healthchecks = runtime;
      ws.send(JSON.stringify(frame));
    });
  });
}
```

(Keep the existing comment above the function.)

- [ ] **Step 2: Update the existing Overview test**

Rename the test and replace its three `.hc-badge` assertions. It becomes:

```ts
test('the overview shows healthchecks chips between the stat cards and the IP panel', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await stubHealthchecks(page);
  await page.goto('/');
  const panel = page.locator('.hc-panel');
  await expect(panel.locator('.hcp-chip')).toHaveCount(3);
  await expect(panel.locator('.hcp-chip.hc-down')).toContainText('SSL (hydrogen)');
  await expect(panel.locator('.hcp-chip.hc-gone')).toContainText('Old job');
  await expect(panel.locator('.panel-head .hc-pill.hc-down')).toHaveText('1 down');
  const geometry = await page.evaluate(() => {
    const stats = document.querySelector('.stats')!.getBoundingClientRect();
    const hc = document.querySelector('.hc-panel')!.getBoundingClientRect();
    const ip = document.querySelector('.ov-grid > .hc-panel + .panel')!.getBoundingClientRect();
    return { statsBottom: stats.bottom, hcTop: hc.top, hcBottom: hc.bottom, ipTop: ip.top };
  });
  expect(geometry.hcTop).toBeGreaterThan(geometry.statsBottom);
  expect(geometry.ipTop).toBeGreaterThan(geometry.hcBottom);
  await expect(page.locator('.ov-grid > .hc-panel + .panel')).toContainText('Public IP');
});
```

- [ ] **Step 3: Add the two new layout tests**

Add directly after the Overview test:

```ts
// jsdom has no layout engine; only a real browser proves rows fill edge to edge.
test('overview chips fill every wrapped row edge to edge, with the bar inline on desktop', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await stubHealthchecks(page, MANY_PROJECT, MANY_RUNTIME);
  await page.goto('/');
  const panel = page.locator('.hc-panel');
  await expect(panel.locator('.hcp-chip')).toHaveCount(24);
  const layout = await panel.evaluate((el) => {
    const box = el.querySelector('.hcp-chips')!.getBoundingClientRect();
    const byTop = new Map<number, { left: number; right: number }[]>();
    for (const chip of el.querySelectorAll('.hcp-chip')) {
      const r = chip.getBoundingClientRect();
      const key = Math.round(r.top);
      byTop.set(key, [...(byTop.get(key) ?? []), { left: r.left, right: r.right }]);
    }
    const rows = [...byTop.values()].map((rs) => ({
      left: Math.min(...rs.map((r) => r.left)) - box.left,
      right: box.right - Math.max(...rs.map((r) => r.right)),
    }));
    const bar = el.querySelector('.hcp-bar')!.getBoundingClientRect();
    const name = el.querySelector('.hcp-head strong')!.getBoundingClientRect();
    return { rows, barTop: bar.top, nameBottom: name.bottom };
  });
  expect(layout.rows.length).toBeGreaterThan(1);
  for (const row of layout.rows) {
    expect(Math.abs(row.left)).toBeLessThanOrEqual(1);
    expect(Math.abs(row.right)).toBeLessThanOrEqual(1);
  }
  expect(layout.barTop).toBeLessThan(layout.nameBottom);
});

test('on a phone the overview bar gets its own line and nothing overflows the panel', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await stubHealthchecks(page, MANY_PROJECT, MANY_RUNTIME);
  await page.goto('/');
  const panel = page.locator('.hc-panel');
  await expect(panel.locator('.hcp-chip')).toHaveCount(24);
  await expect(panel.locator('.hcp-n-checks')).toBeHidden();
  const g = await panel.evaluate((el) => {
    const cs = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    const contentRight = box.right - parseFloat(cs.borderRightWidth) - parseFloat(cs.paddingRight);
    const pill = el.querySelector('.panel-head .hc-pill')!.getBoundingClientRect();
    const head = el.querySelector('.hcp-head')!.getBoundingClientRect();
    const name = el.querySelector('.hcp-head strong')!.getBoundingClientRect();
    const bar = el.querySelector('.hcp-bar')!.getBoundingClientRect();
    const chipRights = [...el.querySelectorAll('.hcp-chip')].map((c) => c.getBoundingClientRect().right);
    return { pillHeight: pill.height, headWidth: head.width, nameBottom: name.bottom, barTop: bar.top, barWidth: bar.width, contentRight, maxChipRight: Math.max(...chipRights) };
  });
  expect(g.pillHeight).toBeLessThan(30);
  expect(g.barTop).toBeGreaterThanOrEqual(g.nameBottom);
  expect(g.barWidth).toBeGreaterThanOrEqual(0.9 * g.headWidth);
  expect(g.maxChipRight).toBeLessThanOrEqual(g.contentRight + 0.5);
});
```

- [ ] **Step 4: Replace the badge probe in the "every status is styled" test**

In the test `'every status is styled on pills, badges and dots, and an unknown class never reads as up'`:

- Rename it to `'every status is styled on pills, chips and dots, and an unknown class never reads as up'`.
- Replace the mount line
  `` `<span class="hc-badge hc-${status}"><i></i>x</span>` + ``
  with
  `` `<span class="hcp-chip hc-${status}"><i></i>x</span>` + ``
- Replace both occurrences of `['pill', 'badge', 'dot']` with `['pill', 'chip', 'dot']`.

Then confirm the e2e file has no badge left:

Run (from repo root): `grep -n "hc-badge" frontend/e2e/healthchecks.spec.ts`
Expected: no output.

- [ ] **Step 5: Run e2e**

Make sure port 8123 is free (a server already on it would serve a stale bundle):
Run: `ss -ltn | grep -q ':8123 ' && echo BUSY || echo FREE`
Expected: `FREE`

Run: `npx playwright test e2e/healthchecks.spec.ts`
Expected: all tests pass, including the 2 new ones.

Run: `npm run test:e2e`
Expected: the full suite passes (confirms nothing else depended on the old markup).

- [ ] **Step 6: Commit**

```bash
git add frontend/e2e/healthchecks.spec.ts
git commit -m "test(e2e): cover Healthchecks overview chips, flush rows and phone layout"
```
