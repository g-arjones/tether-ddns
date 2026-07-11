# Sticky Modal Title/Footer with Scrollable Body — Design Spec

**Date:** 2026-07-11
**Status:** Approved

## Overview

Modals currently scroll as a whole (`.modal` has `max-height: 90vh; overflow-y:
auto`), so on a long form (e.g. the Router Firewall hook) the title and footer
scroll away with the content. This makes the header and footer stay fixed while
only the body scrolls. CSS-only change.

## Change — `frontend/src/styles.css`

- `.modal`: change to a flex column and remove the scroll from the container.
  - Add `display: flex; flex-direction: column;`
  - Remove `overflow-y: auto;` (keep `max-height: 90vh`).
- `.modal-head`: add `flex: none;` (stays at top).
- `.modal-foot`: add `flex: none;` (stays at bottom).
- `.modal-body`: add `overflow-y: auto; flex: 1 1 auto; min-height: 0;` so it
  becomes the single scroll region. (`min-height: 0` lets a flex child shrink
  below its content size so it can scroll.)

No markup or component changes — the existing `.modal-head` / `.modal-body` /
`.modal-foot` structure in `DomainModal` and `HookModal` already matches.

## Testing

This is a pure CSS layout change; jsdom does not compute layout, so an automated
assertion would be brittle. Verification is manual/visual:

- Open the Router Firewall hook modal (a long form). The title and footer stay
  fixed while the middle scrolls.
- Short modals (e.g. Add Domain with DuckDNS) still look correct with no
  unnecessary scrollbar.

The existing `DomainModal`/`HookModal` component tests must continue to pass
(no behavior change).

## Out of Scope

- Any change to modal open/close behavior, markup, or component logic.
- Responsive/mobile-specific modal redesign.
