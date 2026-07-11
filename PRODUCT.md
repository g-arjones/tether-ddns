# Product

## Register

product

## Platform

web

## Users

Self-hosters and homelab enthusiasts running their own dynamic DNS, alongside sysadmins and IT pros at small organizations. They reach for tether-ddns when they control their own infrastructure and want their DNS records to track a changing public IP without handing that job to a third-party service. Their context is a self-hosted deployment they administer directly — often over the LAN, sometimes behind a router they also manage. On any given screen the primary job is to confirm at a glance that their DNS records are current and healthy, and to act quickly when something needs attention.

## Product Purpose

tether-ddns is a stateless, self-hosted dynamic DNS updater. It periodically checks internet reachability, detects the current public IP across IPv4 and IPv6, and updates one or more DDNS records through auto-loaded provider plugins. The web UI surfaces live status, streaming logs, and configuration over a single WebSocket. Success is a user opening the dashboard and immediately trusting that their records are up to date — and, when they aren't, seeing exactly why.

## Positioning

A dynamic DNS updater you extend rather than outgrow: providers, hooks, and IP sources are pluggable, so the tool adapts to the user's stack instead of forcing the user to adapt to it.

## Brand Personality

Technical, transparent, and no-nonsense. The voice speaks to people who read logs and understand their own network. It shows real state plainly rather than dressing it up, favors accuracy over reassurance, and earns trust by being legible. The feeling to evoke is quiet control: the confidence of a tool that does exactly what it says and hides nothing.

## Anti-references

Not consumer SaaS marketing fluff. No decorative gradients, no hero-metric templates with a giant number and supporting stats, no playful mascots or persuasion patterns. This is an operator's tool, not a landing page trying to convert a visitor.

## Design Principles

Show real state, don't summarize it away — surface the actual IP, status, and logs the operator needs to reason about the system.

Legibility over decoration — every visual choice should make status faster to read, never prettier at the cost of clarity.

Extensibility is visible — the plugin nature of providers, hooks, and IP sources should feel first-class in the UI, not buried.

Fail loud and clear — when an update or reachability check fails, the interface makes it obvious and points at the reason.

Respect the operator's expertise — assume a technical user; avoid hand-holding, hidden magic, and unexplained abstractions.

## Accessibility & Inclusion

No formal WCAG target is mandated, but the interface should hold to sensible defaults: sufficient text contrast in both dark and light themes, full keyboard navigability, and a reduced-motion alternative for any animation.
