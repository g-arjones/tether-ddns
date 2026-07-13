# DomainCard IPv6 Overflow Fix — Design

**Date:** 2026-07-12
**Status:** Approved
**Area:** Frontend — `DomainCard` component

## Problem

A full IPv6 address (up to 39 characters, e.g. `2001:0db8:85a3:0000:0000:8a2e:0370:7334`)
renders inside `.ip-val` at `15px` monospace within `.dc-ip`. That element is a flex row
(`justify-content: space-between`) shared with the enable/disable toggle switch. There is no
wrapping, shrinking, or overflow handling, so a long AAAA value either overflows the ~340px
card or crushes the toggle. IPv4 values never trigger this because they are short.

## Goals

- A full IPv6 address fits within the card without overflowing or distorting layout.
- The enable/disable toggle remains present and functional, relocated out of the IP row.
- Preserve the design principle "show real state, don't summarize it away" — no truncation
  or ellipsis of the address.

## Design

### 1. IP row (`.dc-ip`)
- Remove the toggle switch from this row. The label + value block spans the full row width.
- Add `min-width: 0` to the value container so it can shrink/wrap within the card rather
  than forcing overflow.

### 2. `.ip-val` font
- Reduce font size from `15px` to `13.5px` (keep monospace family, weight, letter-spacing feel)
  so a full IPv6 fits on one line at the minimum card width.
- Add `word-break: break-all` as a safety net so extreme narrow/zoom cases wrap instead of
  overflowing.

### 3. Toggle relocation (Layout B)
- Move the `.switch` toggle into `.dc-foot`, grouped with the action buttons on the right:

  ```
  Updated 912d ago               [toggle][sync][edit][delete]
  ```

- The toggle sits first in the right-aligned action group, before sync/edit/delete.

### 4. Footer safety
- `.dc-updated` gets `min-width: 0` so its text yields gracefully. The elapsed time is already
  capped at a days-granularity form (`relTime` never expands beyond `NNNd ago`, ~7 chars max),
  so overflow is not a real risk — this is defensive only.

## Files Touched

- `frontend/src/components/DomainCard.tsx` — move the `<label className="switch">` JSX from
  `.dc-ip` into the `.dc-foot` action group.
- `frontend/src/styles.css` — adjust `.dc-ip`, `.ip-val`, `.dc-actions`/`.dc-foot`, and
  `.dc-updated` rules. Note: there are **two duplicate** `.dc-ip` rule blocks (≈ line 336 and
  ≈ line 741); both must be updated to stay consistent.

## Testing

- Existing `DomainCard`-related unit tests must still pass.
- Visually confirm a full IPv6 (`2001:0db8:85a3:0000:0000:8a2e:0370:7334`) fits within the
  card and the toggle still works from its new footer position.

## Out of Scope

- No changes to `relTime` formatting.
- No truncation / tooltip / copy-button treatment of the address.
- No unrelated refactor of the duplicate CSS blocks beyond the rules named above.
