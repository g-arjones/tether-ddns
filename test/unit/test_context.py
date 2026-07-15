"""Tests for the framework-free AppContext."""
from unittest.mock import MagicMock

from tether_ddns.config import AppConfig
from tether_ddns.context import AppContext
from tether_ddns.runtime import RuntimeState


def _ctx() -> tuple[AppContext, MagicMock, MagicMock]:
    """Build an AppContext with mocked store and manager."""
    cfg = AppConfig()
    runtime = RuntimeState()
    store = MagicMock()
    manager = MagicMock()
    return AppContext(cfg, runtime, store, manager), store, manager


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
