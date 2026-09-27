# App icon: Orbit

Date: 2026-09-26 · Status: approved in the visual companion (option D "Orbit", +20% fill)

## Goal

Replace the Vite placeholder favicon/PWA icons and the rail's globe logo with one brand mark:
a record (bead) held on an orbit around your host (center dot). The globe stays as the
Domains nav icon; the brand logo stops duplicating it.

## Glyph (24-unit grid, source of truth)

Same grammar as `components/icons.tsx`: `fill="none" stroke="currentColor"`, round caps/joins.

- Orbit: `<ellipse cx="12" cy="12" rx="9.5" ry="4.5" transform="rotate(-35 12 12)"/>`, stroke 2.
- Orbit gap: the ellipse is masked by a black `circle cx="19.8" cy="6.5" r="3.8"` over a white
  `rect 24×24` (`maskUnits="userSpaceOnUse"`), so the bead sits in clear air.
- Bead: `circle cx="19.8" cy="6.5" r="2.1"`, `fill="currentColor" stroke="none"`.
- Host: `circle cx="12" cy="12" r="2.4"`, `fill="currentColor" stroke="none"`.

## Surfaces (512×512 canvas unless noted)

| File (`frontend/public/`) | Background | Glyph color | Glyph box | Stroke |
|---|---|---|---|---|
| `icon.svg` (primary) | rounded tile `rx=111`, `#3b82f6` | `#fff` | 384 @ 64,64 | 2 |
| `icon-light.svg` | rounded tile `#ffffff`, 8-unit `#d5dbe8` border | `#3b82f6` | 384 @ 64,64 | 2 |
| `icon-dark.svg` | rounded tile `#0b0f1a`, 8-unit `#2f3b58` border | `#3b82f6` | 384 @ 64,64 | 2 |
| `icon-maskable.svg` (PWA) | full bleed `#3b82f6` | `#fff` | 352 @ 80,80 | 2 |
| `favicon.svg` (replaces Vite's) | rounded tile `rx=112`, `#3b82f6` | `#fff` | 464 @ 24,24 | 2.5 |

The favicon is deliberately fuller and heavier so the lines survive 16px. The maskable glyph
stays inside the 80% safe-zone circle (farthest point ≈170 of 205 units from center).

Rounded tiles use `rect x=4 y=4 width=504 height=504` so the border isn't clipped.

## Raster fallbacks (derived, never hand-edited)

iOS `apple-touch-icon` does not accept SVG and several installers still prefer PNG, so these
are rendered from the SVG masters above (headless Chromium via `playwright-core`):

- `icon-192.png`, `icon-512.png` ← `icon.svg`
- `icon-maskable-512.png` ← `icon-maskable.svg`
- `apple-touch-icon.png` (180) ← `icon-maskable.svg` (iOS applies its own rounding; must be opaque)

## Wiring

- `manifest.json` `icons`: `icon.svg` (`sizes: "any"`, `purpose: "any"`), `icon-192.png`,
  `icon-512.png` (`any`), `icon-maskable.svg` (`any` size, `maskable`), `icon-maskable-512.png`
  (`maskable`). `background_color`/`theme_color` unchanged.
- `index.html`: `favicon.svg` and `apple-touch-icon.png` links already point at the right names.
- Rail: new `IconLogo` export in `components/icons.tsx` (the only file allowed to hold `<svg>`),
  mask id from React `useId()` so collapsed/expanded or repeated renders never share an id.
  `Rail.tsx` brand uses `<IconLogo />`; `.rail .logo svg` grows 21px → 25px inside the 38px tile.
  Domains nav keeps `IconGlobe`.

## Testing

- `icons.test.tsx`: `IconLogo` renders an ellipse whose `mask` references an existing `<mask>`,
  and two instances get distinct mask ids.
- Existing Rail/App tests keep passing; `npx tsc --noEmit -p tsconfig.app.json`; `npm run build`.
- Visual check: screenshot the rail (dark + light, expanded + collapsed) and the favicon in a tab.

## Out of scope

- `frontend/public/icons.svg` is an unreferenced Vite template sprite (Bluesky/GitHub symbols).
  Leaving it; deleting it is a separate call.
- README/docs logo usage of the light/dark variants.
