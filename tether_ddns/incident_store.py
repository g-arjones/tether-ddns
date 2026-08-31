"""JSON-backed persistence for the reachability incident window.

The file is machine-written and regenerable, so loading is fail-soft: a
missing, unreadable, or invalid file yields a fresh empty window.
"""
from __future__ import annotations

import logging
import os
import tempfile
from pathlib import Path

from pydantic import ValidationError

from tether_ddns import paths
from tether_ddns.incidents import IncidentWindow

logger = logging.getLogger(__name__)


class IncidentStore:
    """Loads and saves :class:`IncidentWindow` as JSON on disk."""

    def __init__(self, path: Path | None = None) -> None:
        """Create a store bound to a path (resolved if omitted)."""
        self._path = path if path is not None else paths.incidents_path()

    @property
    def path(self) -> Path:
        """Return the incident file path."""
        return self._path

    def load(self) -> IncidentWindow:
        """Load the persisted window, or a fresh one when absent/corrupt."""
        if not self._path.exists():
            return IncidentWindow()
        try:
            return IncidentWindow.model_validate_json(
                self._path.read_text('utf-8'))
        except (OSError, ValidationError, ValueError) as exc:
            logger.warning(
                'Discarding unreadable incident window at %s: %s',
                self._path, exc)
            return IncidentWindow()

    def save(self, window: IncidentWindow) -> None:
        """Persist the incident window atomically."""
        self._path.parent.mkdir(parents=True, exist_ok=True)
        data = window.model_dump_json(indent=2)
        fd, tmp = tempfile.mkstemp(dir=self._path.parent, suffix='.tmp')
        try:
            with os.fdopen(fd, 'w', encoding='utf-8') as fh:
                fh.write(data)
            os.replace(tmp, self._path)
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)
