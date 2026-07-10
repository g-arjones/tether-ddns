"""Tests for the ring-buffer logging handler."""
import logging

from tether_ddns.logging_setup import LogRingHandler


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
