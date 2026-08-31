"""Tests for the on-disk layout resolvers."""
from pathlib import Path

import pytest

from tether_ddns import paths


def test_home_uses_env(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Home honours TETHER_DDNS_HOME_PATH."""
    monkeypatch.setenv('TETHER_DDNS_HOME_PATH', str(tmp_path))
    assert paths.home() == tmp_path


def test_home_falls_back_to_cwd(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Without the env var, the working directory is the home."""
    monkeypatch.delenv('TETHER_DDNS_HOME_PATH', raising=False)
    monkeypatch.chdir(tmp_path)
    assert paths.home() == tmp_path


def test_files_resolve_into_the_env_home(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """All three files sit in the configured home under fixed names."""
    monkeypatch.setenv('TETHER_DDNS_HOME_PATH', str(tmp_path))
    assert paths.config_path() == tmp_path / 'tether-ddns.config.json'
    assert paths.state_path() == tmp_path / 'tether-ddns.state.json'
    assert paths.incidents_path() == tmp_path / 'tether-ddns.incidents.json'


def test_files_fall_back_to_cwd(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """All three files sit in the cwd when the env var is unset."""
    monkeypatch.delenv('TETHER_DDNS_HOME_PATH', raising=False)
    monkeypatch.chdir(tmp_path)
    assert paths.config_path() == tmp_path / 'tether-ddns.config.json'
    assert paths.state_path() == tmp_path / 'tether-ddns.state.json'
    assert paths.incidents_path() == tmp_path / 'tether-ddns.incidents.json'


def test_home_expands_tilde(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """A tilde-prefixed home path expands to the real home directory."""
    monkeypatch.setenv('HOME', str(tmp_path))
    monkeypatch.setenv('TETHER_DDNS_HOME_PATH', '~/tether')
    assert paths.home() == tmp_path / 'tether'


def test_home_is_resolved_lazily(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Changing the env var after import changes later resolutions."""
    monkeypatch.setenv('TETHER_DDNS_HOME_PATH', str(tmp_path / 'a'))
    first = paths.config_path()
    monkeypatch.setenv('TETHER_DDNS_HOME_PATH', str(tmp_path / 'b'))
    assert first != paths.config_path()
    assert paths.config_path() == tmp_path / 'b' / 'tether-ddns.config.json'
