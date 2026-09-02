# Mantine adoption assessment — tether-ddns frontend

**Status:** evaluation only. No production code was changed.
**Date:** 2026-09-01 · **Mantine version evaluated:** `@mantine/core` 9.6.0 (peer `react ^19.2.0` — matches our React 19.2.7)

A working fidelity probe was built at `/tmp/mantine-probe` (disposable): Vite + React 19 + Mantine 9.6,
importing the project's real `src/styles.css` so hand-rolled and Mantine controls render side by side
under the same tokens. Screenshots: `/tmp/probe-dark.png`, `/tmp/probe-light.png`,
`/tmp/probe-modal-current.png`, `/tmp/probe-modal-mantine.png`, `/tmp/probe-select-*.png`.

---

## 1. Verdict up front

Mantine can reproduce the current look at close to pixel fidelity, and it would delete roughly
**750 lines of component + test code and ~190 of 634 CSS lines**. The cost is roughly **2× the shipped
payload** and a **rewrite of most of the frontend test suite**, because Mantine changes the DOM that
every RTL query and Playwright selector is written against.

The honest framing: this is not a "reduce hand-rolled components" refactor. It is a **replatform of the
control layer**. The instrument-panel half of the app (quorum strip, day strip, incident timeline,
resolver latency rows, log viewer, IP pill) has no Mantine equivalent and stays exactly as it is.

---

## 2. Fidelity: what the probe proved

The probe used one `createTheme()` + one `cssVariablesResolver` + **one 130-line `skin.css`** to bring
stock Mantine onto our tokens. Verified visually in both themes:

| Control | Result |
|---|---|
| Button (primary / ghost) | Indistinguishable after setting `--button-height/-padding-x/-fz/-radius` |
| ActionIcon 40px + 34px | Indistinguishable after setting `--ai-bg/-bd/-color` |
| TextInput / search input | Indistinguishable after setting `--input-height/-padding/-fz/-bg/-bd` |
| Select (closed + open) | Indistinguishable; chevron replaceable via `rightSection` |
| Switch 44×25 | Indistinguishable after `--switch-width/-height/-thumb-size` + `withThumbIndicator={false}` |
| Modal | Indistinguishable except the close button (ours is a bordered 34px box, Mantine's is a bare ✕ — `closeButtonProps` + CSS fixes it) |
| Badge / count badge | Very close (`text-transform: none` + weight override) |
| Progress.Root/Section | Matches `.health-bar` |
| Notification | Matches `.toast` after restyling `.mantine-Notification-icon` to a 30px rounded tile |
| EmptyState | Matches out of the box |
| Chip / SegmentedControl | **Different affordance.** `SegmentedControl` is a joined pill group, not our separate `.filter-chip`s. `Chip.Group` is the closer match but needs flex + `--chip-bg` work |

**Key mechanism that makes this cheap:** Mantine's semantic CSS variables can be aliased straight at our
tokens, and because our tokens already swap on `html[data-theme]`, Mantine follows our theme almost for free:

```js
const shared = {
  '--mantine-color-body': 'var(--bg)',
  '--mantine-color-text': 'var(--text)',
  '--mantine-color-dimmed': 'var(--text-3)',
  '--mantine-color-default': 'var(--surface-2)',
  '--mantine-color-default-border': 'var(--border)',
  '--mantine-primary-color-filled': 'var(--accent)',
  '--mantine-primary-color-filled-hover': 'var(--accent-hover)',
  // …
};
export const resolver = () => ({ variables: {…}, light: shared, dark: shared });
```

**Caveat verified in the probe:** this is *not* sufficient on its own. Components that reach for raw
palette shades (`SegmentedControl`, `Chip`) and Mantine's own `body` rule stayed on the wrong scheme when
only `data-theme` was flipped — measured:

| html attributes | `--bg` | computed `body` background |
|---|---|---|
| `data-theme=dark`, `data-mantine-color-scheme=dark` | `#0b0f1a` | `rgb(11,15,26)` ✅ |
| `data-theme=light`, `data-mantine-color-scheme=dark` | `#f4f6fb` | `rgb(11,15,26)` ❌ |
| `data-theme=light`, `data-mantine-color-scheme=light` | `#f4f6fb` | `rgb(244,246,251)` ✅ |

→ The existing theme toggle in `App.tsx` must also call `setColorScheme()` (or the provider must use
`forceColorScheme`). Both attributes have to move together. This is a two-line change, but forgetting it
produces a half-light UI, so it belongs in the migration checklist.

Mantine converts px→rem via `calc(Xrem * var(--mantine-scale))`; our fractional values (13.5px, 9px,
font-weight 550/650/750) survive that conversion cleanly. `theme.scale` stays at 1.

---

## 3. What would GO

### 3a. Deleted outright — component **and** its test

| File | Lines | Replaced by |
|---|---:|---|
| `components/Modal.tsx` + test | 91 | `Modal` (`@mantine/core`) |
| `components/Select.tsx` + test | 122 | `Select` |
| `components/IconButton.tsx` + test | 81 | `ActionIcon` |
| `components/Toasts.tsx` + test | 63 | `@mantine/notifications` |
| `components/EmptyState.tsx` + test | 41 | `EmptyState` |
| `components/ConnectionOverlay.tsx` + test | 54 | `Overlay` + `Loader` |
| `components/icons.tsx` + test | 239 | an icon package (see §3c) |
| `useDelayedFlag.ts` + test | 62 | `useDebouncedValue` (`@mantine/hooks`) |
| **Total** | **~753** | of 5,936 frontend lines (~13%) |

Notable consequences beyond the line count:

* **`Modal.tsx` going takes the always-mounted-overlay pattern with it.** Repo memory records three
  full-viewport `position: fixed` overlays permanently mounted at `opacity: 0` purely so the CSS
  transition has something to animate, plus the `inert={!open}` /
  `aria-hidden={open ? undefined : true}` invariant and the `.shell inert` dance in `App.tsx`.
  Mantine's `Modal` **unmounts when closed by default** (`keepMounted` is opt-in) and portals outside
  `.shell`, so that entire class of bug — and the Playwright tab-order regression test guarding it —
  disappears rather than being ported.
* **`Select.tsx` going removes the hidden-native-`<select>` + `aria-hidden` trigger trick.** Mantine's
  dropdown is portalled (`comboboxProps.withinPortal`), which also removes the latent clipping risk of
  `.cs-menu` being `position: absolute` inside `.modal-body`.
* **`EmptyState.tsx` going removes the `.empty` global-utility footgun** documented in repo memory
  (the 60px/20px padding collision that cost 11 task reviews).
* The `will-change: transform` modal-flicker fix must be **re-verified on `.mantine-Modal-content`** —
  it is not automatically inherited.

### 3b. Shrunk, not deleted

| File | What goes |
|---|---|
| `SchemaForm.tsx` (108) | `.field` inputs → `TextInput` / `PasswordInput` (built-in reveal toggle) / `NumberInput`; the `<select>` branch → `Select`; the `<label className="switch">` block → `Switch` |
| `SettingsView.tsx` (127) | three hand-rolled `.switch` blocks → `Switch`; `.chips` interval row → `Chip.Group` |
| `DomainModal.tsx` (115) / `HookModal.tsx` (91) | modal chrome + footer markup + `Select`s + the `.switch` block |
| `DomainCard.tsx` (79) | `.switch`, three `IconButton`s → `ActionIcon`; `.status-badge` → `Badge` |
| `LogsView.tsx` (60) | `.log-search` → `TextInput` with `leftSection`; `.filter-chip` row → `Chip.Group` |
| `Rail.tsx` (96) | nav buttons → `NavLink`; shell grid → `AppShell` (**resizer and collapse logic stay** — AppShell has no resizable navbar) |
| `RecordHealthPanel.tsx` (61) | `.health-bar` → `Progress.Root`/`Section`; `setInterval` → `useInterval` |
| `SectionHeader.tsx` (20) | could become `Group` + `Title` + `Badge`, but the `count={{n, noun}}` pluralisation rule is ours and must survive |
| `App.tsx` (414) | `pushToast` + the `setTimeout` dismissal → `notifications.show`; three `try { localStorage… } catch` blocks → `useLocalStorage`; `window.matchMedia('(max-width: 860px)')` → `useMediaQuery`; `window.confirm` on delete → `@mantine/modals` `openConfirmModal` |

### 3c. Icons — the honest answer

**Mantine ships no icon set.** `icons.tsx` cannot be deleted by adopting Mantine alone; it is replaced by
a dependency on an icon package (Tabler / Phosphor / Lucide — the docs' "Icon libraries with Mantine" page
recommends Phosphor, which is what Mantine's own demos use).

Of the 23 icons, **6 stop being needed at all** because Mantine draws them:

| Icon | Drawn by |
|---|---|
| `IconClose` | `Modal` / `CloseButton` |
| `IconChevronDown` | `Select` (still overridable via `rightSection`) |
| `IconCheck` | `Select` check icon (`withCheckIcon`, `checkIconPosition`) |
| `IconMenu` | `Burger` |
| — | `Switch` thumb, `Loader` spinner (currently pure CSS in `.conn-spinner` / `@keyframes spin`) |

The other 17 (`IconGlobe`, `IconHook`, `IconRefresh`, `IconEdit`, `IconTrash`, `IconPlay`, `IconPlus`,
`IconDashboard`, `IconLogs`, `IconSettings`, `IconMoon`, `IconSun`, `IconSearch`, `IconInfo`,
`IconCheckCircle`, `IconAlertTriangle`, `IconClock`) come from the icon library instead.

**This is a real trade:** `icons.tsx` currently enforces a house rule — icons take *no size props*, sizing
is contextual CSS (`.icon-btn svg` 18px, `.act-btn svg` 15px, `.btn svg` 16px, `.empty svg` 46px), and
`strokeWidth` is the only prop. Third-party icon components take a `size` prop and will invite per-call-site
sizing unless the same discipline is re-imposed. Most of the current paths are already Lucide drawings
(`square-pen`, `trash-2`), so visual drift is small if Lucide is chosen.

### 3d. CSS that goes

| Block | Lines |
|---|---:|
| Custom select `.cs*` (495–525) | 31 |
| Modal (526–550) | 25 |
| Connection overlay (613–634) | 22 |
| Buttons `.btn*` (209–225) | 17 |
| Toasts (551–564) | 14 |
| Fields (483–494) | 12 |
| `.icon-btn` + `.act-btn` | ~16 |
| `.chip` + `.filter-chip` | ~14 |
| `.switch` / `.slider` | ~7 |
| `.count-badge` + `.status-badge` | ~11 |
| Empty state (477–482) | 6 |
| `.health-bar` | 3 |
| **Total** | **~180–190 of 634** |

Replaced by ~130 lines of Mantine skin CSS. **Net CSS saving is close to zero** — the win is that the
remaining CSS describes *the instrument panel*, not generic control chrome, and it stops being the place
where global-utility collisions like `.empty` can happen.

---

## 4. What would STAY

Everything below has no Mantine equivalent and is the actual product:

* **`ReachabilityPanel.tsx`** — 24-bar quorum sparkline, 30-day clickable incident strip, per-resolver
  latency bars. Mantine has no sparkline/heat-strip; `@mantine/charts` is recharts and is the wrong tool
  for 24 divs.
* **`IncidentModal.tsx` body** — day timeline with hardcoded `00 06 12 18 24` ticks, `.future` tail,
  incident rows. Only the modal *chrome* is replaceable.
* **`DomainCard.tsx`** — provider colour badge, assigned-IP block, `relTime`.
* **`IpReadoutPanel.tsx`**, **`StatCard.tsx`**, **`RecordHealthPanel`'s legend + countdown**.
* **`LogViewer.tsx`** — monospace lines, per-level colouring, stick-to-bottom follow. `ScrollArea` has no
  stick-to-bottom; the `FOLLOW_THRESHOLD` logic stays either way.
* **`TopBar`'s `.ip-pill`** — segmented IPv4/IPv6 readout with a status dot.
* **`Rail`'s resizer, collapse-to-74px, and safe-area padding** — `AppShell` does not support a resizable
  navbar.
* **The whole token layer**: `:root` tokens, `[data-theme]` blocks, safe-area `--sa-*` tokens, the
  `theme-color` meta sync, the iOS `black-translucent` status-bar scrim, the semantic z-scale.
* **All non-UI code**: `liveConnection.ts` (zombie-socket handling), `useLiveState`, `useIncidents`,
  `api.ts`, `utils.ts`, `types.ts`.

---

## 5. Costs

### 5a. Bundle — measured, not estimated

Production builds, gzip:

| Build | JS raw | JS gz | CSS raw | CSS gz |
|---|---:|---:|---:|---:|
| Current app (`vite build`) | 240.0 kB | 72.7 kB | 29.9 kB | 6.4 kB |
| React 19 + our stylesheet only (baseline) | 190.4 kB | 59.2 kB | 29.9 kB | 6.4 kB |
| Baseline + ~12 Mantine components | 404.7 kB | 122.0 kB | 267.0 kB | 40.8 kB |
| **Mantine delta** | **+214 kB** | **+63 kB** | **+237 kB** | **+34 kB** |

The CSS number is the full `@mantine/core/styles.css`. Switching to per-component imports
(`@mantine/core/styles/Button.css`, …) for the ~38 files we'd actually use measures **129 kB raw /
19.4 kB gz** instead — but requires manually maintaining dependency-ordered imports
(`UnstyledButton.css` *before* `Button.css`, or the base rules override the component).

Realistic shipped delta: **≈ +82 kB gzip** on a current total of ≈ 79 kB gzip. Roughly **2× the payload**.
For a self-hosted LAN dashboard that is probably acceptable; it is worth stating explicitly rather than
discovering later.

### 5b. Tests — the real bill

19 of 24 test files touch a component that would change. The two structural breaks:

* **`Select` is not a `<select>`.** Mantine renders a readonly `<input role="combobox">` plus a portalled
  listbox. Every `getByLabelText('DNS Provider')` + `fireEvent.change` / `selectOptions` in
  `Select.test.tsx`, `DomainModal.test.tsx`, `HookModal.test.tsx`, `SchemaForm.test.tsx`,
  `SettingsView.test.tsx` has to be rewritten to click-then-pick. Mantine documents this in an FAQ
  ("How can I test Select/MultiSelect components?"), so it is a known cost, not a surprise.
* **`Modal` portals and unmounts.** `Modal.test.tsx`, `IncidentModal.test.tsx`, `App.test.tsx` and every
  `.modal` / `.modal-overlay.open` / `.modal-foot` / `.modal-head button` selector in
  `e2e/dashboard.spec.ts` changes. Several e2e tests exist *only* to guard the always-mounted-overlay
  design (tab-order leakage, `inert`, the transform-transition timing rule); those get **deleted**, not
  ported — a genuine simplification.

New test infrastructure required (documented by Mantine):

* a `vitest.setup` that mocks `window.matchMedia`, `ResizeObserver`, `document.fonts`,
  `HTMLElement.prototype.scrollIntoView`, and re-wraps `getComputedStyle`;
* a custom `render()` that wraps everything in `<MantineProvider theme={theme} env="test">`.

Both must be added to `src/setupTests.ts` / a new `test-utils`. Note that `npm test` **does not
type-check** (repo memory) — `npx tsc --noEmit -p tsconfig.app.json` has to be run after every prop
change during a migration of this size.

### 5c. Behavioural / a11y deltas to re-verify

* `IconButton`'s single `label` prop currently makes a nameless icon button *unrepresentable* (it emits
  both `aria-label` and `title`). `ActionIcon` has no such guard — either wrap it or accept the
  regression risk.
* Focus trapping moves from our `inert` invariant to Mantine's `FocusTrap` + `react-remove-scroll`.
  The Playwright "60 tabs" assertion needs re-writing against the new behaviour.
* `prefers-reduced-motion`: our global override zeroes all durations. Mantine has
  `respectReducedMotion` on the theme — needs to be turned on explicitly.
* `postcss-preset-mantine` is **optional**. We have no PostCSS config today; adding one changes the build.
  Without it we lose `light-dark()`, `rem()`, and the `@mixin dark` shorthands, and must write
  `[data-mantine-color-scheme='dark'] &` by hand. Given how little dark-mode CSS we'd write (tokens do
  the work), skipping the preset is defensible.

---

## 6. Recommendation

Adopting Mantine wholesale is a large, mostly-test-shaped project for a ~13% code reduction and a 2×
bundle. Adopting it **piecewise, highest-value-first**, gets most of the benefit with a bounded blast radius:

1. **`@mantine/notifications`** — replaces `Toasts.tsx` + `pushToast` + the `setTimeout` queue. Almost no
   test coupling (`Toasts.test.tsx` is 21 lines). Gains queueing, stacking, drag-dismiss.
2. **`Modal`** — biggest structural win: deletes the always-mounted-overlay pattern, the `inert` /
   `aria-hidden` invariant, and the e2e tests that guard them. Also the biggest test churn — do it alone.
3. **`Select`** — deletes the hidden-`<select>` trick and the clipping risk; brings search, keyboard, and
   portalling. Costs the RTL rewrites in 5 files.
4. **Form controls** (`TextInput` / `PasswordInput` / `NumberInput` / `Switch`) inside `SchemaForm` — this
   is where hand-rolled markup is most duplicated.
5. **`@mantine/hooks` alone** (`useDisclosure`, `useLocalStorage`, `useInterval`, `useMediaQuery`,
   `useDebouncedValue`) — 1.3 MB unpacked but tiny gzipped, zero visual risk, no test churn. **This one is
   worth doing regardless of the rest.**

Steps 1–4 each want their own branch and their own green `npm test` + `npx tsc --noEmit` +
`npm run test:e2e`.

Not recommended: `AppShell` (loses the resizer), `SegmentedControl` for the log filter (wrong affordance),
`@mantine/charts` for the reachability strips (wrong tool).
