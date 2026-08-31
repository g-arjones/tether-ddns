"""FastAPI application factory and lifespan wiring."""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncGenerator

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from starlette.responses import Response
from starlette.types import Scope

from tether_ddns import paths
from tether_ddns.api import register_routes
from tether_ddns.config_store import ConfigStore
from tether_ddns.context import AppContext
from tether_ddns.hooks.base import load_hooks
from tether_ddns.incident_store import IncidentStore
from tether_ddns.ip_sources.base import load_ip_sources
from tether_ddns.logging_setup import (
    LogRingHandler,
    install_ring_handler,
    install_stdout_handler,
)
from tether_ddns.providers.base import load_providers
from tether_ddns.reachability import ReachabilityProbe
from tether_ddns.runtime import RuntimeState
from tether_ddns.scheduler import Scheduler
from tether_ddns.services.dispatch import DispatchService
from tether_ddns.services.incidents import IncidentRecorder
from tether_ddns.services.sync import SyncService
from tether_ddns.state_store import StateStore
from tether_ddns.ws import ConnectionManager

logger = logging.getLogger(__name__)
_STATIC_DIR = Path(__file__).parent / 'static'


class SpaStaticFiles(StaticFiles):
    """Static files that always revalidate the SPA entry point.

    Asset filenames are content-hashed and safe to cache forever, but a cached
    ``index.html`` outlives an upgrade and then references hashed bundles the
    build has already deleted, leaving a blank page.
    """

    async def get_response(self, path: str, scope: Scope) -> Response:
        """Add a revalidation header to HTML responses."""
        response = await super().get_response(path, scope)
        if response.headers.get('content-type', '').startswith('text/html'):
            response.headers['Cache-Control'] = 'no-cache'
        return response


def create_app(
    config_store: ConfigStore | None = None,
    state_store: StateStore | None = None,
    incident_store: IncidentStore | None = None,
) -> FastAPI:
    """Create the configured FastAPI application."""
    resolved_config_store = config_store if config_store is not None else ConfigStore()
    resolved_state_store = (state_store if state_store is not None else StateStore())
    resolved_incident_store = (
        incident_store if incident_store is not None else IncidentStore())

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
        handler = LogRingHandler()
        install_ring_handler(handler)
        install_stdout_handler()
        logger.info('Data home: %s', paths.home())
        load_providers()
        load_hooks()
        load_ip_sources()
        config = resolved_config_store.load()
        runtime = RuntimeState()
        persisted = resolved_state_store.load()
        if persisted is not None:
            runtime.restore(persisted, config)
        recorder = IncidentRecorder(resolved_incident_store)
        runtime.incident_ongoing = recorder.view.ongoing
        runtime.incident_rev = recorder.view.rev
        runtime.rebuild(config)
        manager = ConnectionManager()
        handler.add_listener(lambda rec: manager.sync_broadcast('log', rec))
        runtime.add_listener(lambda snap: manager.sync_broadcast('state', snap))
        ctx = AppContext(config, runtime, resolved_config_store, resolved_state_store, manager,
                         recorder)
        dispatch = DispatchService(ctx)
        sync = SyncService(ctx, dispatch)
        scheduler = Scheduler(ctx, sync, dispatch, ReachabilityProbe())
        scheduler.start()
        if config.settings.update_on_startup:
            scheduler.run_startup_check()
        app.state.store = resolved_config_store
        app.state.state_store = resolved_state_store
        app.state.config = config
        app.state.runtime = runtime
        app.state.manager = manager
        app.state.log_handler = handler
        app.state.scheduler = scheduler
        app.state.ctx = ctx
        app.state.dispatch = dispatch
        app.state.sync = sync
        try:
            yield
        finally:
            scheduler.shutdown()

    app = FastAPI(lifespan=lifespan)
    register_routes(app)
    if _STATIC_DIR.exists():
        app.mount('/', SpaStaticFiles(directory=str(_STATIC_DIR), html=True), name='static')
    return app
