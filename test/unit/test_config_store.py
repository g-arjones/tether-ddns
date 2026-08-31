"""Tests for configuration models and the ConfigStore."""
from pathlib import Path

import pytest

from tether_ddns.config_store import AppConfig, ConfigStore, DomainConfig


def test_default_path_sits_in_the_home_dir(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """A default-constructed store writes into TETHER_DDNS_HOME_PATH."""
    monkeypatch.setenv('TETHER_DDNS_HOME_PATH', str(tmp_path))
    assert ConfigStore().path == tmp_path / 'tether-ddns.config.json'


def test_load_missing_returns_defaults(tmp_path: Path) -> None:
    """Loading a missing file yields a default AppConfig."""
    store = ConfigStore(tmp_path / 'nope.json')
    cfg = store.load()
    assert cfg.settings.check_interval == 300
    assert cfg.domains == []


def test_save_then_load_round_trips(tmp_path: Path) -> None:
    """Saved configuration is read back identically."""
    store = ConfigStore(tmp_path / 'cfg.json')
    cfg = AppConfig(
        settings=store.load().settings,
        domains=[DomainConfig(hostname='home.example.com', provider='duckdns')],
        hooks=[],
    )
    store.save(cfg)
    loaded = store.load()
    assert loaded.domains[0].hostname == 'home.example.com'
    assert loaded.domains[0].id == cfg.domains[0].id
