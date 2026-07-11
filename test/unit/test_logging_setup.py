"""Tests for the ring-buffer logging handler."""
import logging

from tether_ddns.logging_setup import (
    APP_LOGGER_NAME,
    LogRingHandler,
    install_ring_handler,
)


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
