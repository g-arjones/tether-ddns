# Frontend Overhaul — Left-Rail Instrument Panel Design

**Date:** 2026-07-12
**Scope:** Frontend only (React 19 + Vite SPA). Ports the near-final
`frontend/mockup-left-rail.html` into the live app as a five-view, left-rail
instrument panel, and builds the new Overview reachability instrument. Consumes
the telemetry added by the backend plan
(`2026-07-12-overview-instrument-backend.md`), which is implemented first.

## Context

The current app is a single-scroll page (top bar + stats + domains + hooks +
logs inline, settings in a modal), driven by `useLiveState` over `/api/ws`. The
mockup is a left-rail SPA with five views — Overview / Domains / Hooks / Logs /
Settings — plus the new reachability instrument. Existing components
(`DomainCard`, `DomainModal`, `HookModal`, `LogViewer`, `SchemaForm`, `Toasts`)
are reused where they map.

## Decisions (from brainstorming)

- **Fidelity:** faithful port of the mockup **plus** an explicit deviations list
  (below), resolved up front.
- **Provider badge color:** derived hue from the provider key (hash) — pluggable,
  zero-maintenance.
- **Routing:** lightweight local `activeView` state; no router, no new deps.
- **Structure:** split by view; `App.tsx` stays the state/handler hub.
- **CSS:** port the mockup's stylesheet wholesale into global `styles.css`,
  keyed to the same class names the components emit.
- **Testing:** heavy — full render tests for all five views + new panels, plus
  expanded Playwright e2e.

## 1. Architecture & data flow

Single-page app; five views switched by `activeView` state in `App.tsx`.
`App.tsx` owns: WS live state (`useLiveState`), config fetches
(domains/hooks/settings/providers/ip-sources), all mutation handlers, toasts,
theme, and rail state (collapsed / mobile-open). It passes data + callbacks to
view components. No router, no store library, no new dependencies.

The snapshot grows (per the backend plan): `reachability`, `next_check_at`,
`ipv4_changed_at`, `ipv6_changed_at`. `types.ts` extends `StateSnapshot`.

## 2. File structure

```
frontend/src/
  App.tsx                     // hub: state, WS, handlers, routing, rail
  types.ts                    // + Reachability, ResolverProbe, CheckRecord, changed-at fields
  useLiveState.ts             // unchanged (already streams full snapshot)
  utils.ts                    // + deriveHue(key), formatUptime, formatCountdown, relStable
  layout/
    Rail.tsx                  // nav, brand, collapse/resize, mobile drawer, online dot
    TopBar.tsx                // title, IP pills, refresh, theme toggle, rail toggle
  views/
    OverviewView.tsx          // stats grid + IP/reachability panel + record-health/next-check
    DomainsView.tsx           // section head + domain grid (+ empty state)
    HooksView.tsx             // section head + hook list (+ empty state)
    LogsView.tsx              // toolbar (search + level filters) + LogViewer
    SettingsView.tsx          // scheduling / behavior / ip-source
  components/                 // existing, reused; some updated
    StatCard.tsx              // new (extracted)
    ReachabilityPanel.tsx     // new: uptime, quorum bars, resolver latency
    RecordHealthPanel.tsx     // new: health bar + legend + next-check countdown
    IpReadoutPanel.tsx        // new: dual-stack IP rows w/ "stable" duration
    DomainCard.tsx            // updated: toggle switch, derived-hue badge
    DomainModal.tsx           // updated: A / AAAA choices, SchemaForm provider config
    HookModal.tsx             // reused (schema-driven)
    LogViewer.tsx             // reused
    SchemaForm.tsx            // reused
    Toasts.tsx                // reused
```

Each view is independently testable; the Overview instrument decomposes into
focused panels.

## 3. The Overview instrument

- **StatCard grid** — Total Domains, Synced, Needs Update, Update Interval.
  Pure derivation from domains + settings.
- **IpReadoutPanel** — IPv4/IPv6 rows; "stable Nh Nm" from
  `now - ipv{4,6}_changed_at`; subtitle `dual-stack · {settings.ip_source}`.
- **ReachabilityPanel** —
  - Uptime %: `reachability.online / reachability.checks`; "up Nh Nm" from
    `reachability.started_at`.
  - Online/offline badge from the latest history bar vs. quorum.
  - Quorum bars: from `reachability.history`; the frontend renders the last
    `QUORUM_BARS = 24` of the 60 (module constant, matches the mockup scale).
  - Resolver latency rows: from `reachability.latest[]` (`ip`, `ok`,
    `latency_ms`); render "timeout" when `!ok`.
- **RecordHealthPanel** — health bar + legend from domain statuses; next-check
  countdown anchored to `next_check_at`, ticking locally each second between
  snapshots.

All live-updating via WS snapshots.

## 4. Deviations resolved (mockup vs. real API/components)

| # | Mockup shows | Reality | Resolution |
|---|---|---|---|
| 1 | Combined **"A + AAAA"** record-type option | We support `A` and `AAAA` as record types, but not both on one domain | Drop only the **combined** option; the type dropdown offers **A** and **AAAA**. |
| 2 | Hardcoded per-provider badge colors + letter | Providers come from `/api/providers` | Derive a stable hue from provider key; keep initials. |
| 3 | Hardcoded ip-source `<select>` | Sources from `/api/ip-sources` | Populate from the API. |
| 4 | Hardcoded hook types + event chips | Hooks/events from `/api/hooks` | Populate from the API; reuse schema-driven `HookModal`. |
| 5 | Enable/disable **toggle switch** on card | Existing card uses a pause/play button | Adopt the toggle switch; wire to existing `onToggle`. |
| 6 | Fixed **API token** field in domain modal | Provider config is schema-driven | Use `SchemaForm` for provider config. |
| 7 | "dual-stack · ipify", per-IP "stable 2h 14m" | ip_source is dynamic; needs changed-at timestamps | Subtitle from `settings.ip_source`; "stable" from `ipv{4,6}_changed_at`. |
| 8 | Hardcoded resolver IPs | Resolvers from snapshot | Render from `reachability.latest`. |
| 9 | Client-only drifting countdown | Backend exposes `next_check_at` | Anchor to `next_check_at`; tick locally between snapshots. |
| 10 | Retry / Notifications toggles | Both in `Settings` | Keep; already backed. |
| 11 | Static HTML + fake data | React + WS live state | Port to React views; extend snapshot type. |
| 12 | Rail collapse/resize + mobile drawer + theme | Top bar only; theme persists | Port the rail; keep existing theme persistence. |

## 5. Error handling & edge states

- WS disconnected / `snapshot === null` → instrument shows `—` placeholders,
  rail dot offline, no crash.
- Empty domains/hooks → existing empty states, ported per view.
- Zero reachability checks → uptime `—`, empty quorum track.
- `next_check_at === null` (before first schedule) → countdown `—`.
- Config fetch failure (dev / no backend) → silent, as today.

## 6. Testing (heavy)

- **Unit (Vitest):** `deriveHue`, `formatUptime`, `formatCountdown`,
  `relStable`; full render tests for all five views; render tests for
  `ReachabilityPanel`, `RecordHealthPanel`, `IpReadoutPanel`, `StatCard`,
  `Rail`, `TopBar`; update existing component tests for changed props/markup.
- **e2e (Playwright):** extend `dashboard.spec.ts` — rail navigation across all
  five views, collapse/resize, mobile drawer, Overview instrument from a mocked
  snapshot, theme toggle.
- Keep existing coverage thresholds; `tsc --noEmit` clean.

## Out of scope

- Backend telemetry (separate, already-approved plan — implemented first).
- Single-domain dual A+AAAA records.
- Deep-linking / URL routing.
