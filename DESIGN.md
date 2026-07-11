---
name: tether-ddns
description: Operator's dashboard for a stateless, self-hosted dynamic DNS updater.
colors:
  accent: "#3b82f6"
  accent-hover: "#2563eb"
  ok: "#10b981"
  warn: "#f59e0b"
  err: "#ef4444"
  muted-status: "#64748b"
  provider-badge: "#6366f1"
  # Dark theme (default)
  dark-bg: "#0b0f1a"
  dark-bg-2: "#0f1524"
  dark-surface: "#141b2d"
  dark-surface-2: "#1a2337"
  dark-border: "#232d45"
  dark-border-strong: "#2f3b58"
  dark-text: "#e6ebf5"
  dark-text-2: "#9aa6be"
  dark-text-3: "#64748b"
  # Light theme
  light-bg: "#f4f6fb"
  light-bg-2: "#eef1f8"
  light-surface: "#ffffff"
  light-surface-2: "#f7f9fc"
  light-border: "#e4e8f0"
  light-border-strong: "#d5dbe8"
  light-text: "#10192b"
  light-text-2: "#55617a"
  light-text-3: "#8a93a8"
typography:
  display:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif"
    fontSize: "30px"
    fontWeight: 750
    lineHeight: 1
    letterSpacing: "-1px"
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif"
    fontSize: "19px"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "-0.3px"
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif"
    fontSize: "12px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "0.5px"
  mono:
    fontFamily: "SF Mono, ui-monospace, Cascadia Code, Roboto Mono, Menlo, Consolas, monospace"
    fontSize: "12.5px"
    fontWeight: 600
    lineHeight: 1.5
    letterSpacing: "-0.3px"
rounded:
  sm: "10px"
  md: "16px"
  pill: "999px"
spacing:
  xs: "8px"
  sm: "10px"
  md: "16px"
  lg: "20px"
  xl: "28px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "#ffffff"
    rounded: "{rounded.sm}"
    padding: "10px 16px"
  button-primary-hover:
    backgroundColor: "{colors.accent-hover}"
    textColor: "#ffffff"
    rounded: "{rounded.sm}"
    padding: "10px 16px"
  button-ghost:
    backgroundColor: "{colors.dark-surface}"
    textColor: "{colors.dark-text}"
    rounded: "{rounded.sm}"
    padding: "10px 16px"
  button-danger:
    backgroundColor: "{colors.err}"
    textColor: "{colors.err}"
    rounded: "{rounded.sm}"
    padding: "10px 16px"
  card:
    backgroundColor: "{colors.dark-surface}"
    textColor: "{colors.dark-text}"
    rounded: "{rounded.md}"
    padding: "18px"
  input:
    backgroundColor: "{colors.dark-surface-2}"
    textColor: "{colors.dark-text}"
    rounded: "{rounded.sm}"
    padding: "11px 13px"
  chip-active:
    backgroundColor: "{colors.accent}"
    textColor: "#ffffff"
    rounded: "{rounded.pill}"
    padding: "8px 14px"
---

# Design System: tether-ddns

## 1. Overview

**Creative North Star: "The Instrument Panel"**

tether-ddns is read like a gauge cluster, not browsed like a website. The interface exists to report real state — the current public IP, per-domain sync status, streaming logs — and every visual decision serves how fast an operator can read that state and act on it. Density is deliberate: stat readouts, status badges, and monospace IP values pack meaningful signal into a compact frame, with generous but rhythmic spacing so nothing feels crowded. The default theme is a deep navy-black console; a light theme mirrors it exactly for daylight operation.

The system is quiet at rest and loud only when it must be. Surfaces sit flat behind 1px borders until you touch them; status color stays out of the way until a domain is pending, updating, or errored, at which point the semantic palette (amber, blue, red) carries the alarm. Monospace type is reserved for machine truth — IPs, record types, log lines — so the eye learns instantly which values are literal network facts versus interface chrome.

This explicitly rejects consumer-SaaS marketing dressing: no decorative gradients, no hero-metric template with a giant vanity number and supporting stats, no playful mascots or persuasion patterns. It is an operator's tool that shows its real state plainly and hides nothing.

**Key Characteristics:**
- Dense, legible readouts over spacious marketing layouts
- A single blue accent used sparingly against a mostly-neutral surface
- Semantic status color (ok/warn/err) that stays silent until state demands it
- Monospace type reserved for literal network facts (IPs, record types, logs)
- Flat-by-default depth; lift and shadow are responses to interaction
- Dark and light themes that are structural mirrors, not afterthoughts

## 2. Colors

A near-neutral navy console carrying one blue accent, with a three-color semantic status set that only speaks when state changes.

### Primary
- **Tether Blue** (`#3b82f6`): The single interactive accent. Primary buttons, active chips, focused inputs, the "updating" status, INFO log lines, and the brand logo. Its restraint is the point — it marks what is actionable or live, never decoration. Hover deepens to **Tether Blue Deep** (`#2563eb`).

### Secondary
- **Provider Indigo** (`#6366f1`): The default provider badge fill on domain cards, distinguishing the plugin identity avatar from the interactive blue.

### Tertiary — Semantic status
- **Synced Green** (`#10b981`): Healthy, up-to-date records; the online IP dot. Paired with a 14%-opacity soft fill for badge backgrounds.
- **Pending Amber** (`#f59e0b`): Pending updates and WARNING log lines.
- **Error Red** (`#ef4444`): Failed updates, ERROR log lines, destructive actions. Soft fill for badges; solid on danger hover.
- **Muted Slate** (`#64748b`): Paused/idle status and tertiary text.

### Neutral
Dark theme (default): backgrounds `#0b0f1a` / `#0f1524`, surfaces `#141b2d` / `#1a2337`, borders `#232d45` / `#2f3b58`, text `#e6ebf5` (primary) / `#9aa6be` (secondary) / `#64748b` (tertiary).
Light theme: backgrounds `#f4f6fb` / `#eef1f8`, surfaces `#ffffff` / `#f7f9fc`, borders `#e4e8f0` / `#d5dbe8`, text `#10192b` / `#55617a` / `#8a93a8`.

### Named Rules
**The Silent-Until-State Rule.** Status color is absent by default. Green, amber, and red appear only when a domain's actual condition warrants it — a screen of healthy domains is mostly neutral. Color is a signal, not a decoration; if everything is colored, nothing is.

**The One Accent Rule.** Blue is the only interactive hue. Anything the operator can click, focus, or that is actively working wears it; nothing else does.

## 3. Typography

**Display / Body Font:** System UI stack (`-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, ...`)
**Label/Mono Font:** `"SF Mono", ui-monospace, "Cascadia Code", "Roboto Mono", Menlo, Consolas, monospace`

**Character:** One native system sans carries the entire interface, weighted from 400 to 750 for hierarchy rather than mixing families. A monospace stack stands apart for literal network values, so machine truth is visually distinct from interface prose. No web fonts, no display serif — the type is invisible infrastructure, chosen to render instantly and match the host OS.

### Hierarchy
- **Display** (750, 30px, line-height 1, letter-spacing -1px): Stat readout values (e.g. domain count, active IP). The largest type on the page; caps here, no marketing hero scale.
- **Title** (700, 19px, letter-spacing -0.3px): Section headings ("Domains", "Hooks").
- **Body** (400–600, 13–15px, line-height 1.5): Field labels, card names, descriptions, general interface text.
- **Label** (600, 12px, letter-spacing 0.5px, uppercase): Stat labels, IP field captions, settings group titles. The tracked uppercase micro-label for readouts.
- **Mono** (600–650, 11–15px, letter-spacing -0.3px): IP addresses, record types, log lines. Literal network facts only.

### Named Rules
**The Machine-Truth Rule.** Monospace is reserved for values the system reports literally — IP addresses, DNS record types, log output. Never use it for interface labels or prose; its presence should always mean "this is a real network value."

## 4. Elevation

Flat-by-default. Surfaces rest as 1px-bordered planes with no shadow; depth is a response to state, not an ambient property. Hovering a stat, domain card, or button lifts it 1–2px and, where appropriate, adds a soft drop shadow. Only modals and toasts carry persistent elevation, because they genuinely float above the console. The border-color shift (`--border` → `--border-strong`) does much of the depth work that shadows do elsewhere.

### Shadow Vocabulary
- **Ambient surface** (`box-shadow: 0 10px 30px -12px rgba(0,0,0,.6)` dark / `0 10px 30px -14px rgba(20,30,60,.18)` light): Cards and stats on hover; modals and toasts at rest.
- **Accent glow** (`box-shadow: 0 0 0 1px rgba(59,130,246,.25), 0 8px 30px -10px rgba(59,130,246,.45)`): The brand logo and focus emphasis — the only place blue light spills.
- **Focus ring** (`box-shadow: 0 0 0 3px rgba(59,130,246,.15)`): Inputs and selects on focus, paired with a blue border.

### Named Rules
**The Flat-By-Default Rule.** Surfaces are flat at rest. Shadow and lift appear only in response to interaction (hover, focus) or genuine layering (modals, toasts). Never apply a resting drop shadow to an inline surface.

## 5. Components

Precise and restrained: legible, quiet, with a subtle lift on interaction rather than pronounced motion.

### Buttons
- **Shape:** 10px radius (`--radius-sm`), inline-flex with an 8px icon gap.
- **Primary:** Tether Blue fill, white text, `10px 16px` padding, with a soft blue drop shadow (`0 6px 20px -8px rgba(59,130,246,.5)`). Hover deepens to `#2563eb` and lifts 1px.
- **Ghost:** Surface background, 1px border, primary text. Hover strengthens the border and shifts to `--surface-2`.
- **Danger:** Soft red fill (`--err-soft`) with red text; hover inverts to solid red with white text.
- **Disabled:** 50% opacity, no transform.
- **Small:** `7px 12px`, 13px.
- **Icon buttons:** 40×40 (topbar) or 34×34 (card actions), same radius family, border-and-color hover.

### Chips
- **Style:** Pill (999px), `--surface-2` background, 1px border, 13px/600 muted text, flex-grow to fill a row.
- **State:** Active chip flips to Tether Blue fill, white text, transparent border. Used for interval and settings selectors.

### Cards / Containers
- **Corner Style:** 16px radius (`--radius-md`).
- **Background:** `--surface`, on `--bg`.
- **Shadow Strategy:** Flat at rest; ambient shadow + `--border-strong` on hover (see Elevation). An updating domain card borders in Tether Blue.
- **Border:** 1px `--border`.
- **Internal Padding:** 18–20px.

### Inputs / Fields
- **Style:** `--surface-2` fill, 1px `--border`, 10px radius, `11px 13px` padding, full width.
- **Focus:** Border shifts to Tether Blue with a 3px `rgba(59,130,246,.15)` focus ring. No glow beyond the ring.
- **Toggle switch:** 44×25 pill; track fills Tether Blue when checked, white knob translates 19px.

### Navigation
- **Style:** Sticky top bar with a 14px backdrop blur over a translucent background, 1px bottom border. Left: logo tile + wordmark. Right: live IP pill (mono value + status dot), theme toggle, refresh. On mobile (≤620px) the IP-pill label and brand subtitle collapse.

### Signature: Status Badge
A pill carrying a 7px status dot plus a short label, tinted with the semantic soft-fill/solid pair per state: synced (green), pending (amber), error (red), paused (slate), updating (blue, dot pulses). This is the primary at-a-glance health signal on every domain card.

## 6. Do's and Don'ts

### Do:
- **Do** keep the interface mostly neutral; let semantic color (green/amber/red) appear only when a domain's real state calls for it — the Silent-Until-State Rule.
- **Do** reserve Tether Blue (`#3b82f6`) for interactive or live elements only, and deepen to `#2563eb` on hover.
- **Do** set IPs, DNS record types, and log lines in the monospace stack — the Machine-Truth Rule.
- **Do** keep surfaces flat at rest and add lift/shadow only on hover, focus, or genuine layering (modals, toasts).
- **Do** mirror every color and component decision across the dark and light themes; they are structural equals.
- **Do** use full 1px borders and border-color shifts for definition and depth.

### Don't:
- **Don't** add decorative gradients, gradient text, or `background-clip: text` — this is an operator's console, not a marketing page.
- **Don't** build a hero-metric template: no giant vanity number with supporting stats as the page's centerpiece.
- **Don't** introduce playful mascots, illustrations, or persuasion patterns; the voice is technical and no-nonsense.
- **Don't** use monospace for interface labels or prose — it must always signal a literal network value.
- **Don't** apply resting drop shadows to inline surfaces, or use color where a neutral would read faster.
- **Don't** use `border-left`/`border-right` greater than 1px as a colored accent stripe on cards, rows, or badges.
