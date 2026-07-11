"""Application logging: a ring-buffer handler that fans out to listeners."""
from __future__ import annotations

import logging
from collections import deque
from typing import Callable

LogRecordDict = dict[str, object]
Listener = Callable[[LogRecordDict], None]

APP_LOGGER_NAME = 'tether_ddns'
_ATTACH_TO = ('uvicorn', 'uvicorn.access', APP_LOGGER_NAME)


class LogRingHandler(logging.Handler):
    """Logging handler retaining recent records and notifying listeners."""

    def __init__(self, maxlen: int = 500) -> None:
        """Initialise the handler with a bounded record buffer."""
        super().__init__()
        self.records: deque[LogRecordDict] = deque(maxlen=maxlen)
        self._listeners: list[Listener] = []

    def add_listener(self, cb: Listener) -> None:
        """Register a callback invoked for each new record."""
        self._listeners.append(cb)

    def remove_listener(self, cb: Listener) -> None:
        """Remove a previously registered callback."""
        if cb in self._listeners:
            self._listeners.remove(cb)

    def snapshot(self) -> list[LogRecordDict]:
        """Return a copy of the currently buffered records."""
        return list(self.records)

    def emit(self, record: logging.LogRecord) -> None:
        """Store the record and notify listeners (never raises)."""
        try:
            entry: LogRecordDict = {
                'time': record.created,
                'level': record.levelname,
                'logger': record.name,
                'message': record.getMessage(),
            }
            self.records.append(entry)
            for cb in list(self._listeners):
                cb(entry)
        except Exception:  # noqa: BLE001 - logging must not raise
            self.handleError(record)


def get_logger() -> logging.Logger:
    """Return the application logger."""
    return logging.getLogger(APP_LOGGER_NAME)


def install_ring_handler(handler: LogRingHandler) -> None:
    """Attach the ring handler to uvicorn and app loggers.

    uvicorn.error propagates to uvicorn, so attaching to uvicorn alone captures
    it once; uvicorn.access does not propagate and is attached directly. The app
    logger level is raised to INFO so application logs are captured.
    """
    for name in _ATTACH_TO:
        logging.getLogger(name).addHandler(handler)
    logging.getLogger(APP_LOGGER_NAME).setLevel(logging.INFO)
