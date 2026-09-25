"""Tests for configuration models and the ConfigStore."""
from pathlib import Path

from pydantic import ValidationError

import pytest

from tether_ddns.config_store import (
    AppConfig, AppSettings, ConfigStore, DomainConfig, HealthcheckRef,
    HealthchecksProject,
)


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


def test_config_without_healthchecks_loads_empty(tmp_path: Path) -> None:
    """A config file written before healthchecks existed loads with no projects."""
    path = tmp_path / 'cfg.json'
    path.write_text('{"settings": {}, "domains": [], "hooks": []}', encoding='utf-8')
    assert ConfigStore(path).load().healthchecks == []


def test_healthchecks_project_defaults() -> None:
    """A project defaults to healthchecks.io, a 5-minute poll and Overview visibility."""
    project = HealthchecksProject(name='Homelab', api_key='k')
    assert str(project.base_url) == 'https://healthchecks.io/'
    assert project.poll_interval == 300
    assert project.show_on_overview is True
    assert project.fetched_at is None
    assert project.checks == []
    assert len(project.id) == 32


@pytest.mark.parametrize('seconds', [60, 86400])
def test_poll_interval_accepts_bounds(seconds: int) -> None:
    """The poll interval accepts its inclusive bounds."""
    project = HealthchecksProject(name='a', api_key='k', poll_interval=seconds)
    assert project.poll_interval == seconds


@pytest.mark.parametrize('seconds', [59, 86401])
def test_poll_interval_rejects_out_of_range(seconds: int) -> None:
    """The poll interval rejects values outside 60 s to 1 day."""
    with pytest.raises(ValidationError):
        HealthchecksProject(name='a', api_key='k', poll_interval=seconds)


def test_project_base_url_rejects_non_http() -> None:
    """Only http(s) base URLs are accepted."""
    with pytest.raises(ValidationError):
        HealthchecksProject(
            name='a', api_key='k',
            base_url='ftp://hc.example.lan',  # type: ignore[arg-type]
        )


@pytest.mark.parametrize('field', ['name', 'api_key'])
def test_project_rejects_blank_text(field: str) -> None:
    """Name and key must be non-blank after whitespace is stripped."""
    data = {'name': 'a', 'api_key': 'k', field: '   '}
    with pytest.raises(ValidationError):
        HealthchecksProject.model_validate(data)


def test_healthchecks_round_trip(tmp_path: Path) -> None:
    """Projects and their fetched checks survive a save/load cycle."""
    store = ConfigStore(tmp_path / 'cfg.json')
    project = HealthchecksProject(
        name='Homelab', api_key='secret',
        base_url='https://hc.example.lan/sub',  # type: ignore[arg-type]
        poll_interval=120, fetched_at=1.5,
        checks=[HealthcheckRef(key='k1', name='Backup', slug='backup', visible=False)])
    store.save(AppConfig(healthchecks=[project]))
    loaded = store.load().healthchecks
    assert loaded == [project]
    assert str(loaded[0].base_url) == 'https://hc.example.lan/sub'
