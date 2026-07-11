# Log Capture Fixes — Design Spec

**Date:** 2026-07-10
**Status:** Approved

## Overview

The frontend log viewer (fed by the ring-buffer logging handler over the WebSocket) has
three defects, all rooted in how the handler is wired to Python's logging hierarchy. This
fixes the wiring in `tether_ddns/logging_setup.py`. Delivered on `fix/log-duplication`.

## Problems (diagnosed)

Uvicorn's logger configuration (confirmed live):

| logger | propagate | handlers | parent |
|---|---|---|---|
| `uvicorn` | False | StreamHandler | root |
| `uvicorn.error` | True | — | `uvicorn` |
| `uvicorn.access` | False | StreamHandler | `uvicorn` |
| `tether_ddns` | True (NOTSET→WARNING) | — | root |

The ring handler is currently attached to `('uvicorn', 'uvicorn.error', 'tether_ddns')`.

1. **Duplicated records.** `uvicorn.error` propagates to its parent `uvicorn`. With the ring
   handler on *both*, every `uvicorn.error` record (startup lines, "WebSocket accepted",
   "connection open") is captured twice — once directly on `uvicorn.error`, once via
   propagation to `uvicorn`.
2. **Missing access logs.** `uvicorn.access` has `propagate=False` and is not attached, so
   the request lines visible on uvicorn's stdout (`GET /api/... 200 OK`) never reach the
   frontend.
3. **App INFO logs dropped.** `tether_ddns` has no explicit level, so it inherits root's
   WARNING; application `INFO` logs (scheduler syncs, hook activity, IP changes) are filtered
   out before reaching the handler and never appear on the frontend.
4. **Connect-time duplicate delivery.** Records emitted while a socket is connecting (the
   `ws.accept()` "WebSocket accepted"/"connection open" lines) are captured into the ring
   buffer *and* fanned out via `sync_broadcast`, which defers the send with
   `loop.create_task`. That deferred broadcast reads `self.connections` at *run* time — after
   the endpoint has registered the new socket — so the client receives the record once from
   the buffer replay and once from the live broadcast. (Uvicorn logs each line once; the
   duplication is purely in delivery.)

## Fix

In `tether_ddns/logging_setup.py`:

1. Change the attach set to `('uvicorn', 'uvicorn.access', APP_LOGGER_NAME)`:
   - `uvicorn` captures `uvicorn` + `uvicorn.error` (via propagation) exactly once.
   - `uvicorn.access` is attached directly (it does not propagate) so request logs are captured.
   - `tether_ddns` captures application logs.
2. In `install_ring_handler`, set the application logger level to `INFO`
   (`logging.getLogger(APP_LOGGER_NAME).setLevel(logging.INFO)`) so app `INFO` records reach
   the handler. The handler keeps its default (NOTSET) level, capturing everything the loggers
   emit.

No change to the ring buffer, WebSocket, or frontend — the records simply arrive correctly:
one copy each, including access and app logs.

### WebSocket delivery (`tether_ddns/ws.py`)

Fix the connect-time duplicate: `ConnectionManager.sync_broadcast` captures the recipient
list (`list(self.connections)`) synchronously at schedule time and delivers only to those
sockets. A record emitted during a socket's connect window (before the endpoint registers
it) is therefore delivered only via the buffer replay, never also live. A socket registered
after the record was emitted simply doesn't receive that particular live record (it already
has, or will have, the buffered copy). This makes the recipient set match what a synchronous
broadcast would have done at emit time.

## Testing

Extend `test/unit/test_logging_setup.py`:
- **No duplication:** after `install_ring_handler(h)`, a record logged to `uvicorn.error`
  appears exactly once in the snapshot (guards against the double-attach regression).
- **Access captured:** a record logged to `uvicorn.access` appears in the snapshot.
- **App INFO captured:** an `INFO` record on `tether_ddns` appears after install (guards the
  level fix).
- Tests must clean up (remove the handler / restore levels) to avoid cross-test handler
  leakage on the shared global loggers.

Extend `test/unit/test_ws.py`:
- **Schedule-time recipients:** after `sync_broadcast(...)` is scheduled, a socket registered
  afterward does not receive that broadcast, while a socket present at schedule time does.

Keeps strict gates green (flake8, mypy, pyright strict, ruff) and backend coverage ≥ 90.

## Out of scope

- Changing log formatting, buffer size, or the WebSocket delivery.
- Capturing logs emitted before the lifespan installs the handler (the first one or two
  pre-startup lines); acceptable and unchanged.
