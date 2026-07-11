"""FastAPI application factory and lifespan wiring."""
from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncGenerator

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from tether_ddns.api import register_routes
from tether_ddns.config import ConfigStore
from tether_ddns.hooks.base import load_hooks
from tether_ddns.ip_sources.base import load_ip_sources
from tether_ddns.logging_setup import (
    LogRingHandler,
    install_ring_handler,
    install_stdout_handler,
)
from tether_ddns.providers.base import load_providers
from tether_ddns.runtime import RuntimeState
from tether_ddns.scheduler import Scheduler
from tether_ddns.ws import ConnectionManager

_STATIC_DIR = Path(__file__).parent / 'static'


def create_app(store: ConfigStore | None = None) -> FastAPI:
    """Create the configured FastAPI application."""
    resolved_store = store if store is not None else ConfigStore()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
        handler = LogRingHandler()
        install_ring_handler(handler)
        install_stdout_handler()
        load_providers()
        load_hooks()
        load_ip_sources()
        config = resolved_store.load()
        runtime = RuntimeState()
        runtime.rebuild(config)
        manager = ConnectionManager()
        handler.add_listener(lambda rec: manager.sync_broadcast('log', rec))
        runtime.add_listener(lambda snap: manager.sync_broadcast('state', snap))
        scheduler = Scheduler()
        scheduler.start(config, runtime)
        if config.settings.update_on_startup:
            scheduler.run_startup_check(config, runtime)
        app.state.store = resolved_store
        app.state.config = config
        app.state.runtime = runtime
        app.state.manager = manager
        app.state.log_handler = handler
        app.state.scheduler = scheduler
        try:
            yield
        finally:
            scheduler.shutdown()

    app = FastAPI(lifespan=lifespan)
    register_routes(app)
    if _STATIC_DIR.exists():
        app.mount('/', StaticFiles(directory=str(_STATIC_DIR), html=True), name='static')
    return app
