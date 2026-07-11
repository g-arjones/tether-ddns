# Log Viewer Auto-Scroll (Follow) — Design Spec

**Date:** 2026-07-11
**Status:** Approved

## Overview

The log viewer renders a growing list of records but never scrolls, so new logs
appear below the fold and the user must scroll manually. This makes the viewer
follow new logs — auto-scrolling to the bottom — while respecting a user who has
scrolled up to read history.

## Behavior

- The `.log-viewer` element gets a ref and an `onScroll` handler.
- A `stickToBottom` flag tracks whether the user is at (or within ~40px of) the
  bottom: `scrollHeight - scrollTop - clientHeight <= 40`.
- A `useEffect` keyed on `logs` scrolls the viewer to the bottom
  (`el.scrollTop = el.scrollHeight`) **only when `stickToBottom` is true**.
- Initial state is `true`, so the viewer follows from first render.
- Scrolling up (beyond the threshold) sets `stickToBottom = false`, pausing the
  follow; scrolling back to the bottom re-enables it.

## Implementation

In `frontend/src/App.tsx`:

- `const logViewerRef = useRef<HTMLDivElement>(null);`
- `const [stickToBottom, setStickToBottom] = useState(true);`
- `onScroll` handler on `.log-viewer` recomputes `stickToBottom` from the
  element's scroll metrics.
- `useEffect(() => { const el = logViewerRef.current; if (el && stickToBottom) el.scrollTop = el.scrollHeight; }, [logs, stickToBottom]);`
- Attach `ref={logViewerRef}` and `onScroll={...}` to the existing
  `.log-viewer` div (keep `data-testid="log-viewer"`).

No CSS or backend changes.

## Testing

**Frontend (Vitest):** a focused test that renders the log list, simulates the
scroll metrics, and asserts follow behavior. Because jsdom does not lay out
elements, drive it by setting `scrollTop`/`scrollHeight`/`clientHeight` on the
element and dispatching `scroll`:

- When the element reports it is at the bottom, adding logs sets `scrollTop` to
  `scrollHeight` (follows).
- After a `scroll` event that leaves it scrolled up (gap > 40px), adding logs
  does **not** move `scrollTop` to the bottom (paused).

If driving this through the full `App` is impractical in jsdom, extract the
follow logic into a tiny presentational `LogViewer` component (props: `logs`)
and test it directly. Prefer keeping it in `App` if a reliable test is feasible;
otherwise extract `LogViewer` and render it from `App`.

## Out of Scope

- A visible "Follow" toggle button.
- Changing log formatting, buffering, or the WebSocket stream.
- Virtualized/windowed rendering of the log list.
