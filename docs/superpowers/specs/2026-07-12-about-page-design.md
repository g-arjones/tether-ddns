# About Page Design

**Date:** 2026-07-12
**Scope:** A new "About" view showing app metadata and the key tech-stack
versions, grouped by backend and frontend, sourced from actual runtime/build
versions. Backend adds a `GET /api/about` endpoint; frontend adds a sixth rail
view with build-time-injected frontend versions.

## Context

The dashboard is a five-view left-rail SPA (Overview / Domains / Hooks / Logs /
Settings) served by FastAPI. Backend deps are declared unpinned in
`pyproject.toml`; frontend deps use ranges in `package.json`. To show *truthful*
versions we read what is actually installed/running, not what is declared.

## Decisions (from brainstorming)

- **Version source:** actual runtime versions. Backend via
  `importlib.metadata.version(...)` + `platform.python_version()`; frontend via
  build-time injection.
- **Frontend build tools (Vite, TypeScript) + React:** injected at build time
  through Vite `define` from the installed `package.json` files.
- **Navigation:** a sixth rail nav item ("About"), below Settings.
- **Layout:** an app header (name, version, short description) plus two grouped
  `.panel`s — "Backend" and "Frontend" — each listing dependency + monospace
  version.
- **Description:** stored in `pyproject.toml`'s `description` field, read via
  `importlib.metadata`.

## 1. Project metadata (`pyproject.toml`)

Add a `description` field to `[project]`:

```toml
description = "Self-hosted dynamic DNS — keep your DNS records pointed at your changing public IP."
```

This is read back at runtime via `importlib.metadata.metadata('tether-dns')`.

## 2. Backend — `GET /api/about` (`api.py`)

A read-only endpoint returning app metadata and backend versions:

```jsonc
{
  "app": {
    "name": "Tether",
    "version": "0.0.1",           // metadata version of 'tether-dns'
    "description": "Self-hosted dynamic DNS — keep your DNS records pointed at your changing public IP."
  },
  "backend": {
    "python": "3.12.3",           // platform.python_version()
    "apscheduler": "3.10.4",
    "fastapi": "0.115.0",
    "pydantic": "2.9.2",
    "aiodns": "3.2.0",
    "aiohttp": "3.10.5",
    "uvicorn": "0.30.6",
    "websockets": "13.1"
  }
}
```

- Each dependency version resolves via `importlib.metadata.version(dist)` using
  the correct distribution name (e.g. `APScheduler`). On
  `PackageNotFoundError`, that single entry falls back to `"unknown"` — the
  endpoint never 500s over one missing package.
- `python` uses `platform.python_version()`.
- `app.version` uses `importlib.metadata.version('tether-dns')`; `app.name` is
  the constant `"Tether"`; `app.description` comes from the package metadata
  `Summary` field (the `pyproject` description). If metadata is unavailable,
  version/description fall back to `"unknown"` / `""`.
- The version map is defined once as an ordered mapping of
  `display_key -> distribution_name` so the response order is stable and matches
  the requested list.

## 3. Frontend build-time versions (`vite.config.ts`, `vite-env.d.ts`)

Vite `define` injects three compile-time constants read from the installed
packages at build time:

```ts
import reactPkg from 'react/package.json' assert { type: 'json' };
import vitePkg from 'vite/package.json' assert { type: 'json' };
import tsPkg from 'typescript/package.json' assert { type: 'json' };

define: {
  __REACT_VERSION__: JSON.stringify(reactPkg.version),
  __VITE_VERSION__: JSON.stringify(vitePkg.version),
  __TS_VERSION__: JSON.stringify(tsPkg.version),
}
```

A `vite-env.d.ts` declares the three globals so TypeScript and tests see them:

```ts
declare const __REACT_VERSION__: string;
declare const __VITE_VERSION__: string;
declare const __TS_VERSION__: string;
```

Vitest defines the same constants (via its `define` config) so component tests
compile.

## 4. Frontend — types, api, view, rail

- `types.ts`: `AboutInfo` interface —
  `{ app: { name: string; version: string; description: string };
     backend: Record<string, string> }`.
- `api.ts`: `getAbout = () => json<AboutInfo>('/api/about')`.
- `layout/Rail.tsx`: add `'about'` to `ViewKey`; a sixth nav button "About"
  with an info (ⓘ) icon, below Settings.
- `App.tsx`: `TITLES.about = { title: 'About', sub: 'Version & tech stack' }`;
  render `<AboutView />` when `activeView === 'about'`; fetch about info once on
  mount (alongside the existing config fetches) and pass it down (or let the
  view fetch itself — see below).
- `views/AboutView.tsx`:
  - Fetches `/api/about` on mount via `api.getAbout()` (self-contained; keeps
    `App` unchanged beyond routing).
  - **App header** — Tether name, a monospace version badge (`v{version}`), and
    the description paragraph.
  - **Two `.panel`s** — "Backend" (rows from `backend` map) and "Frontend"
    (React / Vite / TypeScript from the injected constants). Each row: dependency
    name + monospace version value.
  - **States:** before the fetch resolves, backend rows show `—`. On fetch
    failure, an inline "Couldn't load version info." note is shown (fail loud),
    while the frontend panel (build-injected) still renders.

Styling reuses existing `.panel` / `.section-head` / `.sr-text`; add one small
`.about-row` rule (name left, monospace version right) if the existing classes
don't suffice. Versions render in `var(--mono)` per the design system's rule for
literal values.

## 5. Testing

- **Backend (`test_api.py`):**
  - `GET /api/about` returns `app` and `backend` keys; `app.name == 'Tether'`;
    `app.version` and each backend version are non-empty strings; `python` is
    present.
  - Monkeypatching `importlib.metadata.version` to raise `PackageNotFoundError`
    for one dep yields `"unknown"` for that entry and still returns 200.
- **Frontend (`AboutView.test.tsx`):**
  - Mocks `api.getAbout` to resolve a fixture; asserts both panels render, a
    backend version (e.g. fastapi) and the injected FE constants appear, and the
    description shows.
  - A rejected `getAbout` shows the error note but still renders the Frontend
    panel.
- **e2e (`dashboard.spec.ts`):** rail navigates to About; "Backend" and
  "Frontend" panel headings are visible.

## Out of scope

- Listing dev/build-only backend tools (flake8, mypy, etc.).
- License texts or full dependency trees.
- Auto-refreshing versions (static per process/build is correct).
