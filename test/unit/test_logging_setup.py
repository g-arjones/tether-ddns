"""Tests for the ring-buffer logging handler."""
import logging
import sys
from typing import TextIO, cast

import pytest

from tether_ddns.logging_setup import (
    APP_LOGGER_NAME,
    LogRingHandler,
    install_ring_handler,
    install_stdout_handler,
)

from uvicorn.logging import DefaultFormatter


def test_ring_handler_keeps_last_n_records() -> None:
    """The handler retains only the most recent maxlen records."""
    handler = LogRingHandler(maxlen=2)
    logger = logging.getLogger('test.ring')
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)
    logger.info('one')
    logger.info('two')
    logger.info('three')
    snap = handler.snapshot()
    assert [r['message'] for r in snap] == ['two', 'three']
    assert snap[0]['level'] == 'INFO'


def test_ring_handler_notifies_listeners() -> None:
    """Registered listeners receive each new record dict."""
    handler = LogRingHandler(maxlen=10)
    seen: list[dict[str, object]] = []
    handler.add_listener(seen.append)
    logger = logging.getLogger('test.ring2')
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)
    logger.warning('hi')
    assert seen and seen[-1]['message'] == 'hi'
    assert seen[-1]['level'] == 'WARNING'


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
    access = logging.getLogger('uvicorn.access')
    prev_level = access.level
    access.setLevel(logging.INFO)  # uvicorn sets this at runtime
    install_ring_handler(handler)
    try:
        access.info('GET /x 200')
    finally:
        _detach(handler)
        access.setLevel(prev_level)
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


def _stdout_stream_handlers() -> list[logging.StreamHandler[TextIO]]:
    logger = logging.getLogger(APP_LOGGER_NAME)
    found: list[logging.StreamHandler[TextIO]] = []
    for handler in logger.handlers:
        if isinstance(handler, logging.StreamHandler):
            stream = cast('logging.StreamHandler[TextIO]', handler)
            if stream.stream is sys.stdout:
                found.append(stream)
    return found


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


def test_install_stdout_handler_emits_record(capsys: pytest.CaptureFixture[str]) -> None:
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
