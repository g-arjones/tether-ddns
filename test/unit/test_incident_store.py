"""Tests for the IncidentStore persistence layer."""
import logging
from pathlib import Path

import pytest

from tether_ddns.incident_store import IncidentStore
from tether_ddns.incidents import Incident, IncidentWindow


def test_default_path_sits_in_the_home_dir(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """A default-constructed store writes into TETHER_DDNS_HOME_PATH."""
    monkeypatch.setenv('TETHER_DDNS_HOME_PATH', str(tmp_path))
    assert IncidentStore().path == tmp_path / 'tether-ddns.incidents.json'


def test_load_missing_returns_fresh_window(tmp_path: Path) -> None:
    """Loading a missing file yields an empty window, not None."""
    store = IncidentStore(tmp_path / 'nope.json')
    window = store.load()
    assert window.incidents == []
    assert window.ongoing is None
    assert window.rev == 0


def test_save_then_load_round_trips(tmp_path: Path) -> None:
    """A saved window is read back with its incidents intact."""
    store = IncidentStore(tmp_path / 'incidents.json')
    window = IncidentWindow(
        monitoring_since=100.0, rev=4, ongoing=None,
        incidents=[Incident(
            start=200.0, end=260.0, severity='outage',
            min_successes=0, total=3, failed=['1.1.1.1'])])
    store.save(window)
    loaded = store.load()
    assert loaded.rev == 4
    assert loaded.monitoring_since == 100.0
    assert len(loaded.incidents) == 1
    assert loaded.incidents[0].failed == ['1.1.1.1']


def test_save_then_load_round_trips_ongoing(tmp_path: Path) -> None:
    """An ongoing incident survives a save/load cycle with end unset."""
    store = IncidentStore(tmp_path / 'incidents.json')
    window = IncidentWindow(
        monitoring_since=100.0, rev=1, incidents=[],
        ongoing=Incident(
            start=300.0, end=None, severity='degraded',
            min_successes=2, total=3, failed=['8.8.8.8']))
    store.save(window)
    loaded = store.load()
    assert loaded.ongoing is not None
    assert loaded.ongoing.end is None
    assert loaded.ongoing.severity == 'degraded'


def test_load_corrupt_returns_fresh_window_and_warns(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """A corrupt incident file is discarded fail-soft with a warning."""
    path = tmp_path / 'incidents.json'
    path.write_text('{ not valid json', encoding='utf-8')
    store = IncidentStore(path)
    with caplog.at_level(logging.WARNING):
        window = store.load()
    assert window.incidents == []
    assert any(r.levelno >= logging.WARNING for r in caplog.records)


def test_save_leaves_no_temp_files(tmp_path: Path) -> None:
    """The atomic save removes its temporary file."""
    store = IncidentStore(tmp_path / 'incidents.json')
    store.save(IncidentWindow())
    assert [p.name for p in tmp_path.iterdir()] == ['incidents.json']


def test_path_property_returns_bound_path(tmp_path: Path) -> None:
    """The path property exposes the bound file path."""
    path = tmp_path / 'incidents.json'
    assert IncidentStore(path).path == path
