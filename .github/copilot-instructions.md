# Copilot Instructions

## Design Context

This project has captured design context for the [impeccable](.github/skills/impeccable/SKILL.md) frontend workflow. Read these before working on UI:

- [PRODUCT.md](../PRODUCT.md) — strategic context: **product** register, **web** platform, users (self-hosters, homelab enthusiasts, small-org sysadmins), purpose, positioning, brand personality, and design principles.
- [DESIGN.md](../DESIGN.md) — visual system: color tokens, typography, elevation, and components. North Star: **"The Instrument Panel."**

**Register:** product · **Platform:** web (React 19 + Vite SPA, served by FastAPI).

**Design principles (from PRODUCT.md):**
1. Show real state, don't summarize it away.
2. Legibility over decoration.
3. Extensibility is visible (providers, hooks, IP sources feel first-class).
4. Fail loud and clear.
5. Respect the operator's expertise.

**Voice:** technical, transparent, no-nonsense — an operator's tool, not consumer-SaaS marketing. No decorative gradients, hero-metric templates, or playful mascots. Reserve the blue accent for interactive/live elements; use monospace only for literal network values (IPs, record types, logs).
