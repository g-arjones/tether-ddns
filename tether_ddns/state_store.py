"""JSON-backed persistence for the live runtime state.

The state file is machine-written and fully regenerable, so loading is
fail-soft: a missing, unreadable, or invalid file yields ``None`` and the
application starts with fresh state.
"""
from __future__ import annotations

import logging
import os
import tempfile
from pathlib import Path

from pydantic import ValidationError

from tether_ddns.runtime import RuntimeState

ENV_VAR = 'TETHER_DDNS_STATE_PATH'
DEFAULT_FILENAME = 'tether-ddns.state.json'

logger = logging.getLogger(__name__)


class StateStore:
    """Loads and saves :class:`RuntimeState` as JSON on disk."""

    def __init__(self, path: Path | None = None) -> None:
        """Create a store bound to a path (resolved if omitted)."""
        self._path = path if path is not None else self.resolve_path()

    @property
    def path(self) -> Path:
        """Return the state file path."""
        return self._path

    @staticmethod
    def resolve_path() -> Path:
        """Resolve the state path from the env var or cwd fallback."""
        env = os.environ.get(ENV_VAR)
        return Path(env) if env else Path.cwd() / DEFAULT_FILENAME

    def load(self) -> RuntimeState | None:
        """Load persisted state, or None when absent/corrupt (fail-soft)."""
        if not self._path.exists():
            return None
        try:
            return RuntimeState.model_validate_json(
                self._path.read_text('utf-8'))
        except (OSError, ValidationError, ValueError) as exc:
            logger.warning(
                'Discarding unreadable runtime state at %s: %s',
                self._path, exc)
            return None

    def save(self, state: RuntimeState) -> None:
        """Persist runtime state atomically."""
        self._path.parent.mkdir(parents=True, exist_ok=True)
        data = state.model_dump_json(indent=2)
        fd, tmp = tempfile.mkstemp(dir=self._path.parent, suffix='.tmp')
        try:
            with os.fdopen(fd, 'w', encoding='utf-8') as fh:
                fh.write(data)
            os.replace(tmp, self._path)
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)
