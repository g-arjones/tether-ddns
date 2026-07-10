"""Configuration models and JSON-backed persistence."""
from __future__ import annotations

import os
import tempfile
from pathlib import Path
from typing import Literal, cast
from uuid import uuid4

from pydantic import BaseModel, Field

ENV_VAR = 'TETHER_DDNS_CONFIG_PATH'
DEFAULT_FILENAME = 'tether-ddns.json'


class AppSettings(BaseModel):
    """Global application settings."""

    check_interval: int = 300
    ip_source: str = 'ipify'
    update_on_startup: bool = True
    retry_on_failure: bool = True
    notify: bool = True


class DomainConfig(BaseModel):
    """A single managed DNS record."""

    id: str = Field(default_factory=lambda: uuid4().hex)  # noqa: A003
    hostname: str
    provider: str
    record_type: Literal['A', 'AAAA'] = 'A'
    ttl: str = 'Auto'
    enabled: bool = True
    update_period: int = 300
    provider_config: dict[str, object] = Field(default_factory=dict[str, object])


class HookConfig(BaseModel):
    """A configured hook instance."""

    id: str = Field(default_factory=lambda: uuid4().hex)  # noqa: A003
    hook: str
    enabled: bool = True
    events: list[str] = Field(default_factory=list[str])
    config: dict[str, object] = Field(default_factory=dict[str, object])


class AppConfig(BaseModel):
    """Full application configuration."""

    settings: AppSettings = Field(default_factory=AppSettings)
    domains: list[DomainConfig] = Field(default_factory=list[DomainConfig])
    hooks: list[HookConfig] = Field(default_factory=list[HookConfig])


class ConfigStore:
    """Loads and saves :class:`AppConfig` as JSON on disk."""

    def __init__(self, path: Path | None = None) -> None:
        """Create a store bound to a path (resolved if omitted)."""
        self._path = path if path is not None else self.resolve_path()

    @property
    def path(self) -> Path:
        """Return the configuration file path."""
        return self._path

    @staticmethod
    def resolve_path() -> Path:
        """Resolve the config path from the env var or cwd fallback."""
        env = os.environ.get(ENV_VAR)
        return Path(env) if env else Path.cwd() / DEFAULT_FILENAME

    def load(self) -> AppConfig:
        """Load configuration, returning defaults when absent."""
        if not self._path.exists():
            return AppConfig()
        return AppConfig.model_validate_json(self._path.read_text('utf-8'))

    def save(self, cfg: AppConfig) -> None:
        """Persist configuration atomically."""
        self._path.parent.mkdir(parents=True, exist_ok=True)
        data = cfg.model_dump_json(indent=2)
        fd, tmp = tempfile.mkstemp(dir=self._path.parent, suffix='.tmp')
        try:
            with os.fdopen(fd, 'w', encoding='utf-8') as fh:
                fh.write(data)
            os.replace(tmp, self._path)
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)


MASK = '********'


def _password_fields(schema: dict[str, object]) -> set[str]:
    props = schema.get('properties')
    if not isinstance(props, dict):
        return set()
    fields: set[str] = set()
    for name, spec in cast('dict[object, object]', props).items():
        if isinstance(spec, dict):
            spec_typed = cast('dict[object, object]', spec)
            if spec_typed.get('format') == 'password':
                fields.add(str(name))
    return fields


def mask_secrets(
    schema: dict[str, object], data: dict[str, object],
) -> dict[str, object]:
    """Return a copy of data with password fields masked."""
    out = dict(data)
    for field in _password_fields(schema):
        if out.get(field):
            out[field] = MASK
    return out


def merge_secrets(
    schema: dict[str, object],
    incoming: dict[str, object],
    existing: dict[str, object],
) -> dict[str, object]:
    """Merge incoming config, preserving existing masked secrets."""
    out = dict(incoming)
    for field in _password_fields(schema):
        value = out.get(field)
        if not value or value == MASK:
            if field in existing:
                out[field] = existing[field]
    return out
