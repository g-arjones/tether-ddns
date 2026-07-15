"""Tests for the runtime StateStore."""
import logging
from pathlib import Path

import pytest

from tether_ddns.reachability import ReachabilityResult
from tether_ddns.runtime import RuntimeState
from tether_ddns.state_store import StateStore


def test_resolve_path_uses_env(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """resolve_path honours TETHER_DDNS_STATE_PATH."""
    target = tmp_path / 'state.json'
    monkeypatch.setenv('TETHER_DDNS_STATE_PATH', str(target))
    assert StateStore.resolve_path() == target


def test_resolve_path_falls_back_to_cwd(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Without the env var, the default state file in cwd is used."""
    monkeypatch.delenv('TETHER_DDNS_STATE_PATH', raising=False)
    monkeypatch.chdir(tmp_path)
    assert StateStore.resolve_path() == tmp_path / 'tether-ddns.state.json'


def test_load_missing_returns_none(tmp_path: Path) -> None:
    """Loading a missing state file yields None (fresh start)."""
    store = StateStore(tmp_path / 'nope.json')
    assert store.load() is None


def test_save_then_load_round_trips(tmp_path: Path) -> None:
    """Saved state is read back with IPs and reachability counters intact."""
    store = StateStore(tmp_path / 'state.json')
    state = RuntimeState()
    state.set_public_ipv4('1.2.3.4')
    state.record_reachability(
        ReachabilityResult(online=True, successes=3, total=3, probes=[]))
    store.save(state)
    loaded = store.load()
    assert loaded is not None
    assert loaded.public_ipv4 == '1.2.3.4'
    assert loaded.reachability_checks == 1


def test_load_corrupt_returns_none_and_warns(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """A corrupt state file is discarded fail-soft with a warning."""
    path = tmp_path / 'state.json'
    path.write_text('{ not valid json', encoding='utf-8')
    store = StateStore(path)
    with caplog.at_level(logging.WARNING):
        assert store.load() is None
    assert any(r.levelno >= logging.WARNING for r in caplog.records)


def test_path_property_returns_bound_path(tmp_path: Path) -> None:
    """The path property exposes the store's bound path."""
    path = tmp_path / 'state.json'
    assert StateStore(path).path == path
