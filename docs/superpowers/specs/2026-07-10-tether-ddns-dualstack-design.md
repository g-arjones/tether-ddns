# Tether DDNS — Dual-Stack & Dashboard Fixes Design Spec

**Date:** 2026-07-10
**Status:** Approved

## Overview

Five follow-up fixes. Two are UI-only, two are backend behavior changes (dual-stack IP,
reachability job split), and one is a shared unit bug fixed in one place. Delivered on
`feat/tether-ddns-dualstack`.

## Changes

### 1. Dual-stack IPv4 + IPv6 (backend + UI)

Today a single `public_ip` is detected and shown. We add first-class IPv4 and IPv6.

**IP sources (`ip_sources/`):**
- `IPSource.detect(self, family: IPFamily) -> str | None`, where
  `IPFamily = Literal['ipv4', 'ipv6']`.
- `detect_public_ip(source_key: str, family: IPFamily) -> str | None`.
- HTTP sources query per-family endpoints:
  - ipify: `https://api.ipify.org` (v4) / `https://api6.ipify.org` (v6).
  - icanhazip: `https://ipv4.icanhazip.com` / `https://ipv6.icanhazip.com`.
- A family with no connectivity returns `None` (already exception-safe).

**Runtime (`runtime.py`):**
- Replace `public_ip` with `public_ipv4: str | None` and `public_ipv6: str | None`,
  each with a setter that emits. `snapshot()` exposes both keys.

**Scheduler syncs:**
- A record → IPv4; AAAA record → IPv6. `sync_domain` is called with the IP for the
  domain's record type. A domain whose required family is unknown/undetectable is left
  untouched that cycle (logged), not synced with an empty IP.

**API (`api.py`):**
- `GET /api/state` returns both families via `snapshot()`.
- `POST /api/domains/{id}/sync`: pick family from the domain's `record_type`; if that
  family's IP is unknown, detect it (`detect_public_ip(ip_source, family)`); on failure
  return `HTTPException(503, 'public IP unknown')`; else sync.

**Frontend:**
- Header shows two pills: `IPv4 <value>` and `IPv6 <value or N/A>`, sourced from
  `snapshot.public_ipv4` / `public_ipv6`.
- `StateSnapshot` type: replace `public_ip` with `public_ipv4` / `public_ipv6`.
- DomainCard already labels Assigned IPv4/IPv6 by record type; unchanged.

### 2. Reachability every 30s, independent of the IP sync interval (backend)

**`scheduler.py`:**
- Add module constant `REACHABILITY_INTERVAL_SECONDS = 30` (no magic number).
- Two periodic jobs registered in `start()`:
  - `check_reachability` on `REACHABILITY_INTERVAL_SECONDS` — runs the DNS-quorum check,
    updates `state.online`, and fires `reachability_changed` hooks **only on transition**.
  - `sync_ips` on `settings.check_interval` — when `state.online`, detects both families,
    fires `ip_changed` per changed family, syncs domains by record-type family, and runs
    `retry_on_failure`. Skips work when offline.
- `check_once(cfg, state)` = `check_reachability` then (if online) `sync_ips`; used by
  startup (`run_startup_check`) and `POST /api/refresh`, preserving today's manual-refresh
  behavior (a refresh can fire both event types).

**Hook firing cadence (explicit behavior change):**
- `reachability_changed` now fires from the dedicated 30s job, so online↔offline
  transitions are detected up to `check_interval` sooner. Still transition-only.
- `ip_changed` still fires only from the sync job and only when online; it now keys off
  the shared `state.online` maintained by the 30s job rather than a just-run check.
- Each event type is emitted from exactly one periodic job (no duplicate firing). Manual
  `check_once` runs both in sequence. All dispatch remains exception-isolated per hook.
- With dual-stack, `ip_changed` fires per family whose value changed; `HookEvent`
  shape is unchanged (`old`/`new` carry that family's previous/new value).

### 3. Interval unit bug — settings chips + dashboard (frontend)

`check_interval` is canonical **seconds** on the backend (default 300). The UI wrongly
treats it as minutes, so the dashboard shows `300m` and no interval chip highlights.

- Settings modal: convert on load (`seconds / 60` → active chip) and on save
  (`chip * 60` → seconds).
- Dashboard "Update Interval" stat: format seconds → `Xm` (or `Xh` when a whole hour),
  e.g. 300 → `5m`, 3600 → `1h`.
- Backend and API keep seconds; only presentation converts.

### 4. count-badge vertical alignment (frontend CSS)

In `.section-head`, the badge should sit vertically aligned with the heading text. The
row currently stretches to the tall "Add" button. Fix by aligning items to the heading
baseline/center so `.count-badge` lines up with the `<h2>` on both Domains and Hooks.
Verified visually.

## Testing & gates

- Backend: `pytest test/` passes, coverage ≥ 90, flake8 / mypy / pyright-strict / ruff
  green. New/updated tests: dual-family IP detection; runtime dual fields + snapshot;
  scheduler two-job split (reachability transition hooks vs sync ip_changed hooks) and
  per-family sync; api sync family selection + 503.
- Frontend: `tsc --noEmit` clean; Vitest for interval formatting (seconds→display) and
  dual IP pills; coverage thresholds hold; Playwright e2e green.

## Out of scope

- Per-family reachability (reachability stays a single online/offline signal).
- Configurable reachability interval (fixed 30s constant this round).
- New provider capabilities beyond passing the family-appropriate IP.
