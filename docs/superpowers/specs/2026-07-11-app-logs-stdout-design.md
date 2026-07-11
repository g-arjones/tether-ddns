# App Logs to Uvicorn's Stdout — Design Spec

**Date:** 2026-07-11
**Status:** Approved

## Overview

Application (`tether_ddns`) log records are captured by the ring-buffer handler and surfaced
in the frontend log viewer, but they never reach the process console. Uvicorn installs its own
colored `StreamHandler` on the `uvicorn` / `uvicorn.access` loggers (via
`uvicorn.logging.DefaultFormatter`) and leaves the root logger untouched, so `tether_ddns`
records — scheduler syncs, hook activity, IP changes — are invisible on stdout. This adds a
stdout handler for the application logger, styled to match uvicorn's console output.

## Change

In `tether_ddns/logging_setup.py`, add an idempotent setup function:

```python
def install_stdout_handler() -> None:
    """Attach a uvicorn-styled stdout handler to the application logger."""
```

Behaviour:

- Attaches a `logging.StreamHandler(sys.stdout)` to the `tether_ddns` logger.
- Formats records with `uvicorn.logging.DefaultFormatter('%(levelprefix)s %(message)s')`, so
  lines match uvicorn's style — e.g. `INFO:     Router firewall: applied Wireguard -> ...`.
- `DefaultFormatter`'s default TTY colour auto-detection is used (no forced colours), so piped
  or redirected output stays clean.
- **Idempotent:** if the app logger already has a stdout `StreamHandler` whose formatter is a
  `DefaultFormatter`, the function is a no-op. This prevents duplicate console lines across
  repeated setup calls and in tests.
- Attaches directly to `tether_ddns` (not root). The app logger's level is already raised to
  `INFO` by `install_ring_handler`; there is no root handler under uvicorn, so `propagate`
  stays at its default and no duplicate lines occur.

## Wiring

Called once at startup in `tether_ddns/app.py`, alongside the existing `install_ring_handler`
call. Purely additive: the ring handler (UI/WebSocket) is unchanged.

## Testing

Unit tests in `test/unit/`:

1. After `install_stdout_handler()`, the `tether_ddns` logger has a `StreamHandler` targeting
   `sys.stdout` whose formatter is a `uvicorn.logging.DefaultFormatter`.
2. Calling `install_stdout_handler()` twice does not add a second stdout handler (idempotence).
3. An emitted app `INFO` record is written to the stream (captured via a redirected stream or
   by asserting the handler formats/emits it).

## Out of Scope

- Any change to the ring-buffer handler, WebSocket delivery, or frontend.
- Access-log formatting or capturing library/root logs on the console.
- Making log level or format user-configurable.
