# Log Capture Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix duplicated log records, capture uvicorn access logs, and stop dropping app INFO logs on the frontend log viewer.

**Architecture:** Change the ring handler's logger attach set and set the app logger level in `tether_ddns/logging_setup.py`. No other module changes.

**Tech Stack:** Python 3.12 (stdlib logging).

## Global Constraints

- Python `>=3.12`. Strict gates: flake8 (pep257 docstrings, alphabetical import order, single quotes, naming), mypy (`mypy .`), pyright strict (`pyright tether_ddns`), ruff.
- Backend coverage gate: `pytest test/` must pass with `--cov-fail-under=90`.
- Backend unit tests in `test/unit/`.
- Tests that touch global loggers must clean up (remove the handler, restore levels) so they don't leak into other tests.

---

## Task 1: Fix the logger wiring

**Files:**
- Modify: `tether_ddns/logging_setup.py`
- Test: `test/unit/test_logging_setup.py`

**Interfaces:**
- `_ATTACH_TO = ('uvicorn', 'uvicorn.access', APP_LOGGER_NAME)`.
- `install_ring_handler(handler)` also sets `logging.getLogger(APP_LOGGER_NAME).setLevel(logging.INFO)`.

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/test_logging_setup.py` (it already imports `logging` and `LogRingHandler`; add `install_ring_handler`, `APP_LOGGER_NAME` to the imports):
```python
def _detach(handler: LogRingHandler) -> None:
    for name in ('uvicorn', 'uvicorn.error', 'uvicorn.access', APP_LOGGER_NAME):
        logging.getLogger(name).removeHandler(handler)


def test_install_captures_uvicorn_error_once() -> None:
    """A uvicorn.error record is captured exactly once (no double-attach)."""
    handler = LogRingHandler()
    install_ring_handler(handler)
    try:
        logging.getLogger('uvicorn.error').warning('boot line')
    finally:
        _detach(handler)
    messages = [r['message'] for r in handler.snapshot()]
    assert messages.count('boot line') == 1


def test_install_captures_access_logs() -> None:
    """A uvicorn.access record reaches the handler."""
    handler = LogRingHandler()
    install_ring_handler(handler)
    try:
        logging.getLogger('uvicorn.access').info('GET /x 200')
    finally:
        _detach(handler)
    assert any(r['message'] == 'GET /x 200' for r in handler.snapshot())


def test_install_captures_app_info_logs() -> None:
    """Application INFO logs reach the handler after install sets the level."""
    handler = LogRingHandler()
    app_logger = logging.getLogger(APP_LOGGER_NAME)
    prev_level = app_logger.level
    install_ring_handler(handler)
    try:
        app_logger.info('scheduler did a thing')
    finally:
        _detach(handler)
        app_logger.setLevel(prev_level)
    assert any(r['message'] == 'scheduler did a thing' for r in handler.snapshot())
```

- [ ] **Step 2: Run to verify they fail**

Run: `python -m pytest test/unit/test_logging_setup.py -v`
Expected: `test_install_captures_uvicorn_error_once` FAILS (count == 2 with the current `uvicorn.error` attach), `test_install_captures_access_logs` FAILS (not attached), `test_install_captures_app_info_logs` FAILS (WARNING level drops INFO).

- [ ] **Step 3: Apply the fix**

In `tether_ddns/logging_setup.py`:
- Change the constant:
```python
_ATTACH_TO = ('uvicorn', 'uvicorn.access', APP_LOGGER_NAME)
```
- Update `install_ring_handler`:
```python
def install_ring_handler(handler: LogRingHandler) -> None:
    """Attach the ring handler to uvicorn and app loggers.

    uvicorn.error propagates to uvicorn, so attaching to uvicorn alone captures
    it once; uvicorn.access does not propagate and is attached directly. The app
    logger level is raised to INFO so application logs are captured.
    """
    for name in _ATTACH_TO:
        logging.getLogger(name).addHandler(handler)
    logging.getLogger(APP_LOGGER_NAME).setLevel(logging.INFO)
```

- [ ] **Step 4: Run to verify they pass**

Run: `python -m pytest test/unit/test_logging_setup.py -v` → all PASS.
Then: `python -m pytest test/ -q` → all pass, coverage ≥ 90.
Lint: `ruff check tether_ddns/logging_setup.py test/unit/test_logging_setup.py`, `flake8 ...`, `mypy tether_ddns/logging_setup.py`, `pyright tether_ddns/logging_setup.py`. Fix violations.

- [ ] **Step 5: Commit**

```bash
git add tether_ddns/logging_setup.py test/unit/test_logging_setup.py
git commit -m "fix: dedupe logs, capture access logs, keep app INFO on the log viewer"
```

---

## Task 2: Fix connect-time duplicate WS delivery

**Files:**
- Modify: `tether_ddns/ws.py`
- Test: `test/unit/test_ws.py`

**Interfaces:**
- `sync_broadcast` snapshots `list(self.connections)` at call time and schedules delivery to
  that snapshot via a private `_broadcast_to(recipients, kind, payload)`.
- `broadcast(kind, payload)` delegates to `_broadcast_to(list(self.connections), ...)`.

- [ ] **Step 1: Write the failing test**

Add to `test/unit/test_ws.py` (it already imports `AsyncMock`, `MagicMock`, `ConnectionManager`; add `import asyncio`):
```python
@pytest.mark.asyncio
async def test_sync_broadcast_targets_schedule_time_sockets() -> None:
    """sync_broadcast delivers only to sockets present when it was scheduled."""
    mgr = ConnectionManager()
    ws1 = MagicMock()
    ws1.send_json = AsyncMock()
    mgr.register(ws1)
    mgr.sync_broadcast('log', {'m': 1})
    ws2 = MagicMock()
    ws2.send_json = AsyncMock()
    mgr.register(ws2)  # registered AFTER scheduling
    await asyncio.sleep(0)  # let the scheduled task run
    ws1.send_json.assert_awaited_once()
    ws2.send_json.assert_not_called()
```

- [ ] **Step 2: Run to verify it fails**

Run: `python -m pytest test/unit/test_ws.py::test_sync_broadcast_targets_schedule_time_sockets -v`
Expected: FAIL — with the current run-time read, `ws2` receives the broadcast.

- [ ] **Step 3: Apply the fix**

In `tether_ddns/ws.py`, replace `broadcast`/`sync_broadcast`:
```python
    async def broadcast(self, kind: str, payload: object) -> None:
        """Send an envelope to every connected socket, dropping failures."""
        await self._broadcast_to(list(self.connections), kind, payload)

    async def _broadcast_to(
        self, recipients: list[Any], kind: str, payload: object,
    ) -> None:
        """Send an envelope to the given sockets, dropping failures."""
        message = {'kind': kind, 'payload': payload}
        for ws in recipients:
            try:
                await ws.send_json(message)
            except Exception:  # noqa: BLE001 - drop broken sockets
                self.disconnect(ws)

    def sync_broadcast(self, kind: str, payload: object) -> None:
        """Schedule a broadcast to the sockets connected at call time."""
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        recipients = list(self.connections)
        loop.create_task(self._broadcast_to(recipients, kind, payload))
```

- [ ] **Step 4: Verify**

Run: `python -m pytest test/unit/test_ws.py -v` → all PASS.
Then `python -m pytest test/ -q` → all pass, coverage ≥ 90.
Lint: `ruff check tether_ddns/ws.py test/unit/test_ws.py`, `flake8 ...`, `mypy tether_ddns/ws.py`, `pyright tether_ddns/ws.py`.

- [ ] **Step 5: Commit**

```bash
git add tether_ddns/ws.py test/unit/test_ws.py
git commit -m "fix: WS sync_broadcast targets sockets present at schedule time (no connect-time dupes)"
```

---

## Task 3: Live verification

**Files:** none.

- [ ] **Step 1: Verify in the running app**

Build + serve, open the app, and confirm in the log viewer: startup lines appear once,
request/access lines appear, app INFO lines show, and the "WebSocket accepted"/"connection
open" lines are no longer doubled on connect.

---

## Self-Review Notes

- **Spec coverage:** duplication (drop `uvicorn.error`, keep `uvicorn`), access logs (add `uvicorn.access`), app INFO (set app logger to INFO) — all three in Task 1 with a test each. Live verification in Task 2.
- **Type consistency:** `_ATTACH_TO`, `install_ring_handler`, `APP_LOGGER_NAME` unchanged in signature.
- **Placeholders:** none. Tests clean up global logger state.
