"""Filesystem layout for the JSON-backed stores.

Every persisted file lives in one home directory so an operator points a
single variable at a volume. Resolution is deliberately lazy: reading the
environment and the working directory per call keeps the layout responsive
to `monkeypatch.chdir` and to a home set after import.
"""
from __future__ import annotations

import os
from pathlib import Path

ENV_VAR = 'TETHER_DDNS_HOME_PATH'
CONFIG_FILENAME = 'tether-ddns.config.json'
STATE_FILENAME = 'tether-ddns.state.json'
INCIDENTS_FILENAME = 'tether-ddns.incidents.json'


def home() -> Path:
    """Resolve the data home from the env var, else the working directory."""
    env = os.environ.get(ENV_VAR)
    return Path(env) if env else Path.cwd()


def config_path() -> Path:
    """Return the configuration file path."""
    return home() / CONFIG_FILENAME


def state_path() -> Path:
    """Return the runtime-state file path."""
    return home() / STATE_FILENAME


def incidents_path() -> Path:
    """Return the incident-window file path."""
    return home() / INCIDENTS_FILENAME
