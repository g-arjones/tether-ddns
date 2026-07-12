# About Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an "About" view showing app metadata and the actual runtime/build versions of the key backend and frontend tech stack, grouped by layer.

**Architecture:** Backend adds a read-only `GET /api/about` endpoint that resolves versions via `importlib.metadata` + `platform`. Frontend injects React/Vite/TypeScript versions at build time via Vite `define`, adds a sixth rail view `AboutView` that fetches `/api/about`, and renders an app header plus two grouped panels. TDD; strict gates.

**Tech Stack:** Python 3.12 (FastAPI, importlib.metadata); React 19 + TypeScript + Vite; Vitest + Playwright.

## Global Constraints

- Python `>=3.12`. Backend strict gates: flake8 (pep257 docstrings, alphabetical import order, single quotes), mypy (`mypy .`), pyright strict (`pyright tether_ddns`), ruff. Run gates over BOTH `tether_ddns/` AND `test/` (repo meta-tests lint the test tree).
- Backend coverage gate: `pytest test/ --cov-fail-under=90`.
- Backend test conventions: every test function has a one-line docstring; async tests use `@pytest.mark.asyncio` + `async def`; access protected members via `patch.object`; alphabetical imports.
- Frontend: strict TS; `npx tsc --noEmit` and `npm run build` clean; `npm run lint` (oxlint) clean; every new module has a Vitest test; keep coverage thresholds; no new runtime dependencies.
- Versions are literal network/tech values → render in `var(--mono)`.
- venv at `.venv` (`source .venv/bin/activate`; project uses `uv`). Frontend dir is `frontend/` — run frontend commands there.

---

## Task 1: Project description in metadata

**Files:**
- Modify: `pyproject.toml`

**Interfaces:**
- Produces: package metadata `Summary` = the app description, readable via `importlib.metadata.metadata('tether-dns').get('Summary')`.

- [ ] **Step 1: Add the description field**

In `pyproject.toml`, under `[project]` (after the `version` line):

```toml
description = "Self-hosted dynamic DNS — keep your DNS records pointed at your changing public IP."
```

- [ ] **Step 2: Reinstall so metadata regenerates**

The editable install's `METADATA` is generated at install time; adding the field to `pyproject.toml` does not update it until reinstall.

Run: `cd /home/arjones/dev/tether-ddns && source .venv/bin/activate && uv pip install -e . >/dev/null 2>&1 || pip install -e . >/dev/null 2>&1; python3 -c "import importlib.metadata as m; print(repr(m.metadata('tether-dns').get('Summary')))"`
Expected: prints the description string (not `None`).

- [ ] **Step 3: Commit**

```bash
git add pyproject.toml
git commit -m "chore: add project description to pyproject metadata"
```

---

## Task 2: `GET /api/about` endpoint

**Files:**
- Modify: `tether_ddns/api.py`
- Test: `test/unit/test_api.py`

**Interfaces:**
- Produces: `GET /api/about` returning
  `{ 'app': { 'name': str, 'version': str, 'description': str },
     'backend': dict[str, str] }` where `backend` maps display keys
  (`python`, `apscheduler`, `fastapi`, `pydantic`, `aiodns`, `aiohttp`,
  `uvicorn`, `websockets`) to version strings, `'unknown'` on lookup failure.

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/test_api.py` (this file already has `_client(tmp_path)` and imports `Any`, `patch`):

```python
def test_about_returns_app_and_backend(tmp_path: Path) -> None:
    """GET /api/about returns app metadata and backend versions."""
    with _client(tmp_path) as client:
        resp: Any = client.get('/api/about')
    assert resp.status_code == 200
    body: dict[str, Any] = resp.json()
    assert body['app']['name'] == 'Tether'
    assert isinstance(body['app']['version'], str) and body['app']['version']
    backend: dict[str, str] = body['backend']
    for key in ('python', 'apscheduler', 'fastapi', 'pydantic',
                'aiodns', 'aiohttp', 'uvicorn', 'websockets'):
        assert key in backend
        assert isinstance(backend[key], str) and backend[key]


def test_about_unknown_package_falls_back(tmp_path: Path) -> None:
    """A missing distribution yields 'unknown' rather than a 500."""
    import importlib.metadata as md

    real_version = md.version

    def fake_version(dist: str) -> str:
        if dist == 'fastapi':
            raise md.PackageNotFoundError(dist)
        return real_version(dist)

    with patch('tether_ddns.api.metadata.version', side_effect=fake_version):
        with _client(tmp_path) as client:
            resp: Any = client.get('/api/about')
    assert resp.status_code == 200
    assert resp.json()['backend']['fastapi'] == 'unknown'
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/arjones/dev/tether-ddns && source .venv/bin/activate && pytest test/unit/test_api.py -k about -v`
Expected: FAIL — 404 (route not defined) / import error.

- [ ] **Step 3: Implement the endpoint**

In `tether_ddns/api.py`, add module imports near the top (respect alphabetical order):

```python
import platform
from importlib import metadata
```

Add, at module level (after imports, before `register_routes`):

```python
APP_NAME = 'Tether'
APP_DISTRIBUTION = 'tether-dns'

# display key -> installed distribution name
_BACKEND_DISTS: dict[str, str] = {
    'apscheduler': 'APScheduler',
    'fastapi': 'fastapi',
    'pydantic': 'pydantic',
    'aiodns': 'aiodns',
    'aiohttp': 'aiohttp',
    'uvicorn': 'uvicorn',
    'websockets': 'websockets',
}


def _dist_version(dist: str) -> str:
    """Return an installed distribution version, or 'unknown'."""
    try:
        return metadata.version(dist)
    except metadata.PackageNotFoundError:
        return 'unknown'


def _about_payload() -> dict[str, object]:
    """Assemble app metadata and backend runtime versions."""
    try:
        app_version = metadata.version(APP_DISTRIBUTION)
        summary = metadata.metadata(APP_DISTRIBUTION).get('Summary') or ''
    except metadata.PackageNotFoundError:
        app_version, summary = 'unknown', ''
    backend: dict[str, str] = {'python': platform.python_version()}
    for key, dist in _BACKEND_DISTS.items():
        backend[key] = _dist_version(dist)
    return {
        'app': {
            'name': APP_NAME,
            'version': app_version,
            'description': summary,
        },
        'backend': backend,
    }
```

Inside `register_routes`, alongside the other `@router.get` routes, add:

```python
    @router.get('/about')
    def get_about() -> dict[str, object]:
        return _about_payload()
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest test/unit/test_api.py -k about -v`
Expected: PASS.

- [ ] **Step 5: Gates + commit**

Run: `flake8 tether_ddns test && mypy . && pyright tether_ddns && ruff check tether_ddns`
Expected: clean.

```bash
git add tether_ddns/api.py test/unit/test_api.py
git commit -m "feat(api): add GET /api/about with runtime backend versions"
```

---

## Task 3: Build-time frontend version injection

**Files:**
- Modify: `frontend/vite.config.ts`
- Modify: `frontend/vite.config.ts` test define (see Vitest note) — if Vitest config is separate, also that file
- Create: `frontend/src/buildinfo.d.ts`

**Interfaces:**
- Produces: compile-time globals `__REACT_VERSION__`, `__VITE_VERSION__`,
  `__TS_VERSION__` (all `string`), available in app code and tests.

- [ ] **Step 1: Read the current vite config**

Read `frontend/vite.config.ts` fully to see how `defineConfig`, plugins, and any existing `test`/`define` blocks are structured (Vitest config may live inside it).

- [ ] **Step 2: Inject the versions**

At the top of `frontend/vite.config.ts`, import the installed package versions and add a `define` block (merge with any existing one). Prefer `createRequire` to read the JSONs robustly:

```ts
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const reactVersion = require('react/package.json').version as string;
const viteVersion = require('vite/package.json').version as string;
const tsVersion = require('typescript/package.json').version as string;
```

In the config object add (merging if `define` already exists):

```ts
  define: {
    __REACT_VERSION__: JSON.stringify(reactVersion),
    __VITE_VERSION__: JSON.stringify(viteVersion),
    __TS_VERSION__: JSON.stringify(tsVersion),
  },
```

If Vitest configuration is in this same file (a `test` key), the `define` block
applies to tests too. If Vitest uses a separate config, add the same `define`
there so component tests compile. If neither defines it at test time, tests will
fail to find the globals — verify by running a test in Task 5.

- [ ] **Step 3: Declare the globals for TypeScript**

Create `frontend/src/buildinfo.d.ts`:

```ts
declare const __REACT_VERSION__: string;
declare const __VITE_VERSION__: string;
declare const __TS_VERSION__: string;
```

- [ ] **Step 4: Verify typecheck and build**

Run: `cd frontend && npx tsc --noEmit && npm run build 2>&1 | tail -3`
Expected: clean build; no "cannot find name __REACT_VERSION__" errors.

- [ ] **Step 5: Commit**

```bash
git add frontend/vite.config.ts frontend/src/buildinfo.d.ts
git commit -m "build(frontend): inject React/Vite/TypeScript versions"
```

---

## Task 4: About types and API client

**Files:**
- Modify: `frontend/src/types.ts`
- Modify: `frontend/src/api.ts`
- Test: `frontend/src/api.test.ts` (extend if present; else add a focused test)

**Interfaces:**
- Produces:
  - `AboutInfo` interface: `{ app: { name: string; version: string; description: string }; backend: Record<string, string> }`.
  - `api.getAbout(): Promise<AboutInfo>` hitting `/api/about`.

- [ ] **Step 1: Add the type**

In `frontend/src/types.ts` add:

```typescript
export interface AboutInfo {
  app: { name: string; version: string; description: string };
  backend: Record<string, string>;
}
```

- [ ] **Step 2: Add the API client**

In `frontend/src/api.ts` add (import `AboutInfo` in the existing type import from `./types`):

```typescript
export const getAbout = () => json<AboutInfo>('/api/about');
```

- [ ] **Step 3: Verify typecheck + lint**

Run: `cd frontend && npx tsc --noEmit && npm run lint`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/types.ts frontend/src/api.ts
git commit -m "feat(frontend): add AboutInfo type and getAbout client"
```

---

## Task 5: `AboutView` component

**Files:**
- Create: `frontend/src/views/AboutView.tsx`
- Test: `frontend/src/views/AboutView.test.tsx`

**Interfaces:**
- Consumes: `api.getAbout`, `AboutInfo`, injected version globals.
- Produces: `export function AboutView(): JSX.Element`.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/views/AboutView.test.tsx`:

```tsx
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AboutView } from './AboutView';
import * as api from '../api';

const about = {
  app: { name: 'Tether', version: '0.0.1', description: 'Self-hosted DDNS test blurb.' },
  backend: {
    python: '3.12.7', apscheduler: '3.11.3', fastapi: '0.139.0', pydantic: '2.13.4',
    aiodns: '4.0.4', aiohttp: '3.14.1', uvicorn: '0.51.0', websockets: '16.1',
  },
};

describe('AboutView', () => {
  it('renders app header, description, and both panels', async () => {
    vi.spyOn(api, 'getAbout').mockResolvedValue(about);
    render(<AboutView />);
    expect(await screen.findByText('Self-hosted DDNS test blurb.')).toBeInTheDocument();
    expect(screen.getByText('Backend')).toBeInTheDocument();
    expect(screen.getByText('Frontend')).toBeInTheDocument();
    expect(await screen.findByText('0.139.0')).toBeInTheDocument(); // fastapi
    expect(screen.getByText('React')).toBeInTheDocument();
  });

  it('shows an error note but still renders the Frontend panel on fetch failure', async () => {
    vi.spyOn(api, 'getAbout').mockRejectedValue(new Error('boom'));
    render(<AboutView />);
    expect(await screen.findByText(/Couldn't load version info/i)).toBeInTheDocument();
    expect(screen.getByText('Frontend')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/views/AboutView.test.tsx`
Expected: FAIL — module not found. (If it fails instead on undefined `__REACT_VERSION__`, fix the Vitest `define` from Task 3 Step 2.)

- [ ] **Step 3: Implement `AboutView`**

Create `frontend/src/views/AboutView.tsx`:

```tsx
import { useEffect, useState, type JSX } from 'react';
import type { AboutInfo } from '../types';
import { getAbout } from '../api';

const BACKEND_ORDER = [
  'python', 'apscheduler', 'fastapi', 'pydantic',
  'aiodns', 'aiohttp', 'uvicorn', 'websockets',
] as const;

const FRONTEND_ROWS: [string, string][] = [
  ['React', __REACT_VERSION__],
  ['Vite', __VITE_VERSION__],
  ['TypeScript', __TS_VERSION__],
];

function Row({ name, version }: { name: string; version: string }): JSX.Element {
  return (
    <div className="about-row">
      <span className="about-name">{name}</span>
      <span className="about-ver">{version}</span>
    </div>
  );
}

export function AboutView(): JSX.Element {
  const [about, setAbout] = useState<AboutInfo | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    getAbout()
      .then((info) => { if (active) setAbout(info); })
      .catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, []);

  return (
    <>
      <div className="section-head"><h3>About</h3></div>
      <div className="panel about-header">
        <h2>{about?.app.name ?? 'Tether'}</h2>
        <span className="about-ver">v{about?.app.version ?? '—'}</span>
        <p className="about-desc">{about?.app.description ?? ''}</p>
      </div>
      <div className="settings-grid">
        <div className="panel">
          <div className="sg-title">Backend</div>
          {failed && <div className="about-error">Couldn't load version info.</div>}
          {BACKEND_ORDER.map((k) => (
            <Row key={k} name={k} version={about?.backend[k] ?? '—'} />
          ))}
        </div>
        <div className="panel">
          <div className="sg-title">Frontend</div>
          {FRONTEND_ROWS.map(([name, version]) => (
            <Row key={name} name={name} version={version} />
          ))}
        </div>
      </div>
    </>
  );
}
```

- [ ] **Step 4: Add minimal CSS**

Append to `frontend/src/styles.css`:

```css
/* ---------- About ---------- */
.about-header { display: flex; flex-direction: column; gap: 6px; margin-bottom: 16px; }
.about-header h2 { font-size: 20px; font-weight: 700; letter-spacing: -.3px; }
.about-desc { color: var(--text-2); font-size: 14px; max-width: 60ch; }
.about-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 0; border-bottom: 1px solid var(--border); }
.about-row:last-child { border-bottom: none; }
.about-name { font-size: 14px; color: var(--text); }
.about-ver { font-family: var(--mono); font-size: 13px; font-weight: 650; color: var(--text-2); }
.about-error { color: var(--warn); font-size: 13px; margin-bottom: 8px; }
```

- [ ] **Step 5: Run test + typecheck + lint**

Run: `cd frontend && npx vitest run src/views/AboutView.test.tsx && npx tsc --noEmit && npm run lint`
Expected: PASS + clean.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/views/AboutView.tsx frontend/src/views/AboutView.test.tsx frontend/src/styles.css
git commit -m "feat(frontend): add AboutView with grouped version panels"
```

---

## Task 6: Rail item + App routing

**Files:**
- Modify: `frontend/src/layout/Rail.tsx`, `frontend/src/layout/Rail.test.tsx`
- Modify: `frontend/src/App.tsx`

**Interfaces:**
- Consumes: `AboutView`.
- Produces: `ViewKey` includes `'about'`; a sixth rail nav button "About";
  `App` renders `<AboutView />` when `activeView === 'about'`.

- [ ] **Step 1: Update the Rail test**

In `frontend/src/layout/Rail.test.tsx`, add to the nav-items test (or add a new test) an assertion that an "About" button renders:

```tsx
  it('renders the About nav item', () => {
    render(<Rail {...base} />);
    expect(screen.getByRole('button', { name: /About/ })).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd frontend && npx vitest run src/layout/Rail.test.tsx`
Expected: FAIL — no About button.

- [ ] **Step 3: Add the rail item**

In `frontend/src/layout/Rail.tsx`: add `'about'` to the `ViewKey` union, and append an About nav def after `settings` in the `items` array (info-circle icon):

```tsx
    { key: 'about', label: 'About', icon: (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><path d="M12 16v-4M12 8h.01" /></svg>) },
```

- [ ] **Step 4: Wire App routing**

In `frontend/src/App.tsx`:
- import `AboutView` from `./views/AboutView`.
- add to `TITLES`: `about: { title: 'About', sub: 'Version & tech stack' }`.
- add the render branch after the settings branch:

```tsx
            {activeView === 'about' && <AboutView />}
```

- [ ] **Step 5: Run tests + typecheck + lint + build**

Run: `cd frontend && npx vitest run src/layout/Rail.test.tsx && npx tsc --noEmit && npm run lint && npm run build 2>&1 | tail -3`
Expected: PASS + clean build.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/layout/Rail.tsx frontend/src/layout/Rail.test.tsx frontend/src/App.tsx
git commit -m "feat(frontend): add About rail item and route"
```

---

## Task 7: e2e + full verification

**Files:**
- Modify: `frontend/e2e/dashboard.spec.ts`

- [ ] **Step 1: Add an e2e test**

Add to `frontend/e2e/dashboard.spec.ts`:

```typescript
test('about view shows backend and frontend panels', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /About/ }).click();
  await expect(page.getByRole('heading', { name: 'About', level: 2 })).toBeVisible();
  await expect(page.getByText('Backend')).toBeVisible();
  await expect(page.getByText('Frontend')).toBeVisible();
});
```

- [ ] **Step 2: Run the full frontend suite + build + e2e**

Run: `cd frontend && npx tsc --noEmit && npm run lint && npm test 2>&1 | grep -E "Test Files|Tests " && npm run build 2>&1 | tail -2 && npm run test:e2e 2>&1 | tail -4`
Expected: all pass; build clean; e2e green.

- [ ] **Step 3: Run the full backend suite + gates**

Run: `cd /home/arjones/dev/tether-ddns && source .venv/bin/activate && flake8 tether_ddns test && mypy . && pyright tether_ddns && pytest test/ --cov=tether_ddns --cov-fail-under=90 -q 2>&1 | tail -3`
Expected: all clean; coverage ≥ 90%.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "test(e2e): cover About view navigation"
```

---

## Self-Review Notes

- **Spec coverage:** §1 → Task 1; §2 (endpoint) → Task 2; §3 (build inject) → Task 3; §4 (types/api/view/rail) → Tasks 4–6; §5 (testing) → every task + Task 7. All covered.
- **Type consistency:** `AboutInfo`, `getAbout`, `_about_payload`, `_BACKEND_DISTS`, `__REACT_VERSION__`/`__VITE_VERSION__`/`__TS_VERSION__`, `BACKEND_ORDER` used identically across tasks. `BACKEND_ORDER` (frontend render order) mirrors `_BACKEND_DISTS` keys + `python`.
- **Metadata caveat:** Task 1 reinstalls the editable package so `Summary` is populated; the endpoint falls back to `''` if absent, so tests won't hard-fail if reinstall is skipped (only the description would be empty).
- **Vitest globals:** Task 3 Step 2 flags that the injected globals must be defined at test time; Task 5 Step 2 catches it if missing.
