"""Tests for configuration models and the ConfigStore."""
from pathlib import Path

from pydantic import ValidationError

import pytest

from tether_ddns.config_store import AppConfig, AppSettings, ConfigStore, DomainConfig


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


URL = 'https://hc-ping.com/5b1c7f0a'


def test_heartbeat_defaults() -> None:
    """The heartbeat is off with a five-minute interval by default."""
    settings = AppSettings()
    assert settings.heartbeat_url is None
    assert settings.heartbeat_interval == 300


@pytest.mark.parametrize('url', ['ftp://hc-ping.com/x', 'hc-ping.com/x', 'not a url'])
def test_heartbeat_url_rejects_non_http(url: str) -> None:
    """Only absolute http/https URLs are accepted."""
    with pytest.raises(ValidationError):
        AppSettings.model_validate({'heartbeat_url': url})


@pytest.mark.parametrize('seconds', [30, 86400])
def test_heartbeat_interval_accepts_bounds(seconds: int) -> None:
    """The interval bounds 30 s and 1 day are inclusive."""
    assert AppSettings.model_validate(
        {'heartbeat_interval': seconds}).heartbeat_interval == seconds


@pytest.mark.parametrize('seconds', [29, 86401, 0])
def test_heartbeat_interval_rejects_out_of_range(seconds: int) -> None:
    """Intervals outside 30 s .. 1 day are rejected."""
    with pytest.raises(ValidationError):
        AppSettings.model_validate({'heartbeat_interval': seconds})


def test_heartbeat_url_round_trips_as_string(tmp_path: Path) -> None:
    """A saved heartbeat URL is written as a JSON string and read back."""
    store = ConfigStore(tmp_path / 'cfg.json')
    store.save(AppConfig.model_validate({'settings': {'heartbeat_url': URL}}))
    assert f'"heartbeat_url": "{URL}"' in store.path.read_text('utf-8')
    assert str(store.load().settings.heartbeat_url) == URL
