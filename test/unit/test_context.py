"""Tests for the framework-free AppContext."""
from pathlib import Path
from unittest.mock import MagicMock

from tether_ddns.config_store import AppConfig, ConfigStore
from tether_ddns.context import AppContext
from tether_ddns.runtime import RuntimeState
from tether_ddns.state_store import StateStore
from tether_ddns.ws import ConnectionManager


def _ctx() -> tuple[AppContext, MagicMock, MagicMock]:
    """Build an AppContext with mocked store and manager."""
    cfg = AppConfig()
    runtime = RuntimeState()
    store = MagicMock()
    manager = MagicMock()
    ctx = AppContext(cfg, runtime, store, MagicMock(), manager)
    return ctx, store, manager


def test_persist_saves_config_via_store() -> None:
    """persist() saves the current config through the store."""
    ctx, store, _ = _ctx()
    ctx.persist()
    store.save.assert_called_once_with(ctx.config)


def test_rebuild_persists_then_rebuilds_runtime() -> None:
    """rebuild() saves config and rebuilds runtime from it."""
    ctx, store, _ = _ctx()
    ctx.runtime = MagicMock(spec=RuntimeState)
    ctx.rebuild()
    store.save.assert_called_once_with(ctx.config)
    ctx.runtime.rebuild.assert_called_once_with(ctx.config)


def test_persist_state_writes_runtime(tmp_path: Path) -> None:
    """persist_state saves the current runtime via the state store."""
    runtime = RuntimeState()
    runtime.set_public_ipv4('5.6.7.8')
    state_store = StateStore(tmp_path / 'state.json')
    ctx = AppContext(
        config=AppConfig(),
        runtime=runtime,
        config_store=ConfigStore(tmp_path / 'cfg.json'),
        state_store=state_store,
        manager=ConnectionManager(),
    )
    ctx.persist_state()
    loaded = state_store.load()
    assert loaded is not None
    assert loaded.public_ipv4 == '5.6.7.8'
