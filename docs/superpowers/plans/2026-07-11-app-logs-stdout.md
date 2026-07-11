# App Logs to Uvicorn's Stdout — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Print `tether_ddns` application log records to the process stdout, styled to match uvicorn's console output.

**Architecture:** Add an idempotent `install_stdout_handler()` to `tether_ddns/logging_setup.py` that attaches a `logging.StreamHandler(sys.stdout)` — formatted with `uvicorn.logging.DefaultFormatter` — to the `tether_ddns` logger, then call it once from the app lifespan in `tether_ddns/app.py`.

**Tech Stack:** Python 3.12, stdlib `logging`, `uvicorn.logging.DefaultFormatter`, pytest.

## Global Constraints

- Docstrings required on all public functions (flake8 pep257); single quotes; alphabetical import order (flake8 I-rules).
- Must pass: `flake8`, `ruff check`, `mypy .`, `pyright tether_ddns`, `pytest` with coverage `--cov-fail-under=90`.
- No new third-party dependencies (`uvicorn` is already a dependency).
- Attach to the `tether_ddns` logger only (not root). Do not modify the ring handler, WebSocket, or frontend.

---

### Task 1: `install_stdout_handler` in logging_setup

**Files:**
- Modify: `tether_ddns/logging_setup.py`
- Test: `test/unit/test_logging_setup.py`

**Interfaces:**
- Consumes: existing `APP_LOGGER_NAME = 'tether_ddns'` from `tether_ddns/logging_setup.py`.
- Produces: `install_stdout_handler() -> None` — attaches a `logging.StreamHandler` writing to `sys.stdout`, with a `uvicorn.logging.DefaultFormatter('%(levelprefix)s %(message)s')` formatter, to the `tether_ddns` logger; idempotent (no second stdout handler on repeat calls).

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/test_logging_setup.py`. First extend the import block:

```python
"""Tests for the ring-buffer logging handler."""
import logging
import sys

from uvicorn.logging import DefaultFormatter

from tether_ddns.logging_setup import (
    APP_LOGGER_NAME,
    LogRingHandler,
    install_ring_handler,
    install_stdout_handler,
)
```

Then append these tests at the end of the file:

```python
def _stdout_stream_handlers() -> list[logging.StreamHandler]:
    logger = logging.getLogger(APP_LOGGER_NAME)
    return [
        h for h in logger.handlers
        if isinstance(h, logging.StreamHandler) and getattr(h, 'stream', None) is sys.stdout
    ]


def test_install_stdout_handler_attaches_uvicorn_styled_handler() -> None:
    """A stdout StreamHandler with a DefaultFormatter is attached to the app logger."""
    logger = logging.getLogger(APP_LOGGER_NAME)
    for h in _stdout_stream_handlers():
        logger.removeHandler(h)
    install_stdout_handler()
    handlers = _stdout_stream_handlers()
    assert len(handlers) == 1
    assert isinstance(handlers[0].formatter, DefaultFormatter)
    logger.removeHandler(handlers[0])


def test_install_stdout_handler_is_idempotent() -> None:
    """Calling install_stdout_handler twice does not add a second stdout handler."""
    logger = logging.getLogger(APP_LOGGER_NAME)
    for h in _stdout_stream_handlers():
        logger.removeHandler(h)
    install_stdout_handler()
    install_stdout_handler()
    handlers = _stdout_stream_handlers()
    assert len(handlers) == 1
    logger.removeHandler(handlers[0])


def test_install_stdout_handler_emits_record(capsys) -> None:
    """An app INFO record is written to stdout after installation."""
    logger = logging.getLogger(APP_LOGGER_NAME)
    for h in _stdout_stream_handlers():
        logger.removeHandler(h)
    install_stdout_handler()
    logger.info('hello stdout')
    captured = capsys.readouterr()
    assert 'hello stdout' in captured.out
    for h in _stdout_stream_handlers():
        logger.removeHandler(h)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest test/unit/test_logging_setup.py -v -o addopts=""`
Expected: FAIL with `ImportError: cannot import name 'install_stdout_handler'`.

- [ ] **Step 3: Implement `install_stdout_handler`**

In `tether_ddns/logging_setup.py`, add `import sys` (keep imports alphabetical: `sys` follows `logging`) and `from uvicorn.logging import DefaultFormatter` in the third-party import group. Then add this function after `install_ring_handler`:

```python
def install_stdout_handler() -> None:
    """Attach a uvicorn-styled stdout handler to the application logger.

    Application records already reach the ring buffer; this additionally prints
    them to stdout formatted like uvicorn's console lines. The call is
    idempotent so repeated setup does not duplicate console output.
    """
    logger = logging.getLogger(APP_LOGGER_NAME)
    for existing in logger.handlers:
        if (isinstance(existing, logging.StreamHandler)
                and getattr(existing, 'stream', None) is sys.stdout
                and isinstance(existing.formatter, DefaultFormatter)):
            return
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(DefaultFormatter('%(levelprefix)s %(message)s'))
    logger.addHandler(handler)
```

Note on import ordering: the existing file imports are `logging`, then `from collections import deque`, then `from typing import Callable`. Add `import sys` immediately after `import logging`, and add `from uvicorn.logging import DefaultFormatter` after the `typing` import (third-party group). Verify with `flake8` in Step 5.

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest test/unit/test_logging_setup.py -v -o addopts=""`
Expected: all PASS.

- [ ] **Step 5: Lint and type-check**

Run:
```bash
ruff check tether_ddns/logging_setup.py test/unit/test_logging_setup.py
flake8 tether_ddns/logging_setup.py test/unit/test_logging_setup.py
mypy .
pyright tether_ddns
```
Expected: no errors. Fix any import-order or docstring violations reported.

- [ ] **Step 6: Commit**

```bash
git add tether_ddns/logging_setup.py test/unit/test_logging_setup.py
git commit -m "feat(logging): add uvicorn-styled stdout handler for app logs"
```

---

### Task 2: Wire stdout handler into the app lifespan

**Files:**
- Modify: `tether_ddns/app.py`

**Interfaces:**
- Consumes: `install_stdout_handler() -> None` from Task 1.

- [ ] **Step 1: Add the call in the lifespan**

In `tether_ddns/app.py`, update the import on line 15 and the lifespan body. Change:

```python
from tether_ddns.logging_setup import LogRingHandler, install_ring_handler
```
to:
```python
from tether_ddns.logging_setup import (
    LogRingHandler,
    install_ring_handler,
    install_stdout_handler,
)
```

Then in the `lifespan` function, immediately after `install_ring_handler(handler)`:

```python
        handler = LogRingHandler()
        install_ring_handler(handler)
        install_stdout_handler()
```

- [ ] **Step 2: Verify the app imports and starts**

Run: `python -c "from tether_ddns.app import create_app; create_app()"`
Expected: no exception (the factory builds; lifespan runs on startup).

- [ ] **Step 3: Run the full test suite with coverage**

Run: `python -m pytest`
Expected: all pass; coverage ≥ 90%.

- [ ] **Step 4: Lint and type-check**

Run:
```bash
ruff check tether_ddns/app.py
flake8 tether_ddns/app.py
mypy .
pyright tether_ddns
```
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add tether_ddns/app.py
git commit -m "feat(app): print application logs to stdout on startup"
```

---

## Manual Verification (after both tasks)

1. Start the server: `python -m tether_ddns` (or the project's run command).
2. Trigger an app log (e.g. a scheduler sync or hook activity, or wait for the startup check).
3. Confirm a uvicorn-styled line such as `INFO:     Router firewall: applied ...` appears on the console alongside uvicorn's own access/startup lines, with no duplicate lines.
