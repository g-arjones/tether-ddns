"""REST and WebSocket route registration."""
# pyright: reportUnusedFunction=false
from __future__ import annotations

import platform
import time
from importlib import metadata

from fastapi import APIRouter, FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.exceptions import RequestValidationError

from pydantic import BaseModel, ConfigDict, Field, HttpUrl, ValidationError

from tether_ddns.config_store import (
    AppSettings,
    DEFAULT_HEALTHCHECKS_URL,
    DomainConfig,
    HealthchecksProject,
    HeartbeatInterval,
    HookConfig,
    MASK,
    PollInterval,
    mask_secrets,
    merge_secrets,
)
from tether_ddns.healthchecks import HealthchecksError
from tether_ddns.hooks.base import EVENT_SPECS, HOOK_REGISTRY
from tether_ddns.ip_sources.base import IP_SOURCE_REGISTRY
from tether_ddns.providers.base import PROVIDER_REGISTRY
from tether_ddns.services.collection import find_or_404
from tether_ddns.services.dispatch import DispatchService
from tether_ddns.services.healthchecks import HealthchecksService, merge_refs
from tether_ddns.services.heartbeat import HeartbeatService


APP_NAME = 'Tether'
APP_DISTRIBUTION = 'tether-ddns'

# ordered (display name, installed distribution name)
_BACKEND_DISTS: list[tuple[str, str]] = [
    ('APScheduler', 'APScheduler'),
    ('FastAPI', 'fastapi'),
    ('Pydantic', 'pydantic'),
    ('aiodns', 'aiodns'),
    ('aiohttp', 'aiohttp'),
    ('Uvicorn', 'uvicorn'),
    ('websockets', 'websockets'),
]


def _dist_version(dist: str) -> str:
    """Return an installed distribution version, or 'unknown'."""
    try:
        return metadata.version(dist)
    except metadata.PackageNotFoundError:
        return 'unknown'


def _about_payload() -> dict[str, object]:
    """Assemble app metadata and backend runtime versions."""
    try:
        app_version = metadata.version(APP_DISTRIBUTION)
        summary = metadata.metadata(APP_DISTRIBUTION).get('Summary') or ''
    except metadata.PackageNotFoundError:
        app_version, summary = 'unknown', ''
    backend: list[dict[str, str]] = [
        {'name': 'Python', 'version': platform.python_version()},
    ]
    backend.extend(
        {'name': name, 'version': _dist_version(dist)}
        for name, dist in _BACKEND_DISTS)
    return {
        'app': {
            'name': APP_NAME,
            'version': app_version,
            'description': summary,
        },
        'backend': backend,
    }


class DomainInput(BaseModel):
    """Incoming domain payload (id assigned server-side)."""

    hostname: str
    provider: str
    record_type: str = 'A'
    enabled: bool = True
    update_period: int = 300
    provider_config: dict[str, object] = {}


class HookInput(BaseModel):
    """Incoming hook payload."""

    hook: str
    enabled: bool = True
    events: list[str] = []
    config: dict[str, object] = {}


class SettingsUpdate(BaseModel):
    """Partial settings update; rejects unknown keys and bad types."""

    model_config = ConfigDict(extra='forbid')

    check_interval: int | None = None
    ip_source: str | None = None
    update_on_startup: bool | None = None
    retry_on_failure: bool | None = None
    notify: bool | None = None
    heartbeat_url: HttpUrl | None = None
    heartbeat_interval: HeartbeatInterval | None = None


class HealthchecksInput(BaseModel):
    """Incoming healthchecks.io project (id and checks assigned server-side)."""

    model_config = ConfigDict(extra='forbid', str_strip_whitespace=True)

    name: str = Field(min_length=1)
    base_url: HttpUrl = HttpUrl(DEFAULT_HEALTHCHECKS_URL)
    api_key: str = Field(min_length=1)
    poll_interval: PollInterval = 300
    show_on_overview: bool = True


class HealthchecksUpdate(BaseModel):
    """Partial project update; an empty or masked key keeps the stored one."""

    model_config = ConfigDict(extra='forbid')

    name: str | None = None
    base_url: HttpUrl | None = None
    api_key: str | None = None
    poll_interval: PollInterval | None = None
    show_on_overview: bool | None = None


class CheckVisibility(BaseModel):
    """Toggle a fetched check's Overview visibility."""

    model_config = ConfigDict(extra='forbid')

    visible: bool


def _provider_schema(provider: str) -> dict[str, object]:
    cls = PROVIDER_REGISTRY.get(provider)
    return cls.config_schema() if cls else {}


def _hook_schema(hook: str) -> dict[str, object]:
    cls = HOOK_REGISTRY.get(hook)
    return cls.config_schema() if cls else {}


def _validate_hook_events(hook: str, events: list[str]) -> None:
    cls = HOOK_REGISTRY.get(hook)
    if cls is None:
        raise HTTPException(status_code=400, detail=f'unknown hook {hook}')
    for event in events:
        if event not in cls.supported_events():
            raise HTTPException(
                status_code=400,
                detail=f'unsupported event {event} for hook {hook}')


def _masked_domain(d: DomainConfig) -> dict[str, object]:
    data = d.model_dump()
    data['provider_config'] = mask_secrets(_provider_schema(d.provider), d.provider_config)
    return data


def _masked_hook(h: HookConfig) -> dict[str, object]:
    data = h.model_dump()
    data['config'] = mask_secrets(_hook_schema(h.hook), h.config)
    return data


def _masked_project(p: HealthchecksProject) -> dict[str, object]:
    data: dict[str, object] = p.model_dump(mode='json')
    data['api_key'] = MASK
    return data


def _body_validation_error(exc: ValidationError) -> RequestValidationError:
    """Re-shape a model ValidationError as FastAPI's 422 with body-prefixed locs."""
    errors: list[dict[str, object]] = []
    for error in exc.errors():
        item = dict(error)
        item['loc'] = ('body', *error['loc'])
        errors.append(item)
    return RequestValidationError(errors)


def _upstream_error(exc: HealthchecksError) -> RequestValidationError:
    """Report an upstream failure as a 422 on the form field it concerns."""
    return RequestValidationError([
        {'type': 'value_error', 'loc': ('body', exc.field), 'msg': str(exc), 'input': None}])


def _persist(app: FastAPI) -> None:
    app.state.store.save(app.state.config)


def register_routes(app: FastAPI) -> None:
    """Attach all API routes to the app."""
    router = APIRouter(prefix='/api')

    @router.get('/state')
    def get_state() -> dict[str, object]:
        cfg = app.state.config
        snap: dict[str, object] = app.state.runtime.snapshot()
        snap['settings'] = cfg.settings.model_dump(mode='json')
        snap['logs'] = app.state.log_handler.snapshot()
        return snap

    @router.get('/reachability/incidents')
    def get_incidents() -> dict[str, object]:
        window: dict[str, object] = app.state.ctx.incidents.window().model_dump()
        return window

    @router.get('/providers')
    def get_providers() -> list[dict[str, object]]:
        return [
            {'key': k, 'display_name': c.display_name, 'schema': c.config_schema()}
            for k, c in PROVIDER_REGISTRY.items()
        ]

    @router.get('/about')
    def get_about() -> dict[str, object]:
        return _about_payload()

    @router.get('/hooks')
    def get_hooks() -> list[dict[str, object]]:
        return [
            {'key': k, 'display_name': c.display_name,
             'events': [
                 {'key': e, 'label': EVENT_SPECS[e].label}
                 for e in c.supported_events()],
             'schema': c.config_schema()}
            for k, c in HOOK_REGISTRY.items()
        ]

    @router.get('/ip-sources')
    def get_ip_sources() -> list[dict[str, object]]:
        return [
            {'key': k, 'display_name': c.display_name}
            for k, c in IP_SOURCE_REGISTRY.items()
        ]

    @router.get('/domains')
    def list_domains() -> list[dict[str, object]]:
        return [_masked_domain(d) for d in app.state.config.domains]

    @router.post('/domains')
    def create_domain(payload: DomainInput) -> dict[str, object]:
        domain = DomainConfig(**payload.model_dump())
        app.state.config.domains.append(domain)
        _persist(app)
        app.state.runtime.rebuild(app.state.config)
        return _masked_domain(domain)

    @router.put('/domains/{domain_id}')
    def update_domain(domain_id: str, payload: DomainInput) -> dict[str, object]:
        i, d = find_or_404(app.state.config.domains, domain_id, 'domain not found')
        data = payload.model_dump()
        data['provider_config'] = merge_secrets(
            _provider_schema(payload.provider),
            payload.provider_config, d.provider_config)
        updated = DomainConfig(id=domain_id, **data)
        app.state.config.domains[i] = updated
        _persist(app)
        app.state.runtime.rebuild(app.state.config)
        return _masked_domain(updated)

    @router.delete('/domains/{domain_id}')
    def delete_domain(domain_id: str) -> dict[str, bool]:
        i, _ = find_or_404(app.state.config.domains, domain_id, 'domain not found')
        del app.state.config.domains[i]
        _persist(app)
        app.state.runtime.rebuild(app.state.config)
        return {'ok': True}

    @router.post('/domains/{domain_id}/sync')
    async def sync_now(domain_id: str) -> dict[str, bool]:
        _, d = find_or_404(app.state.config.domains, domain_id, 'domain not found')
        await app.state.sync.sync_one_now(d)
        return {'ok': True}

    @router.get('/hooks-config')
    def list_hook_config() -> list[dict[str, object]]:
        return [_masked_hook(h) for h in app.state.config.hooks]

    @router.post('/hooks-config')
    def create_hook(payload: HookInput) -> dict[str, object]:
        _validate_hook_events(payload.hook, payload.events)
        hook = HookConfig(**payload.model_dump())
        app.state.config.hooks.append(hook)
        _persist(app)
        return _masked_hook(hook)

    @router.put('/hooks-config/{hook_id}')
    def update_hook(hook_id: str, payload: HookInput) -> dict[str, object]:
        _validate_hook_events(payload.hook, payload.events)
        i, h = find_or_404(app.state.config.hooks, hook_id, 'hook not found')
        data = payload.model_dump()
        data['config'] = merge_secrets(
            _hook_schema(payload.hook), payload.config, h.config)
        updated = HookConfig(id=hook_id, **data)
        app.state.config.hooks[i] = updated
        _persist(app)
        return _masked_hook(updated)

    @router.delete('/hooks-config/{hook_id}')
    def delete_hook(hook_id: str) -> dict[str, bool]:
        i, _ = find_or_404(app.state.config.hooks, hook_id, 'hook not found')
        del app.state.config.hooks[i]
        _persist(app)
        return {'ok': True}

    @router.post('/hooks-config/{hook_id}/run')
    async def run_hook(hook_id: str) -> dict[str, object]:
        _, h = find_or_404(app.state.config.hooks, hook_id, 'hook not found')
        dispatch: DispatchService = app.state.dispatch
        return await dispatch.run_hook_now(h)

    @router.get('/settings')
    def get_settings() -> dict[str, object]:
        settings: dict[str, object] = app.state.config.settings.model_dump(mode='json')
        return settings

    @router.put('/settings')
    def put_settings(payload: SettingsUpdate) -> dict[str, object]:
        current = app.state.config.settings
        set_fields = payload.model_dump(exclude_unset=True)
        try:
            merged = AppSettings(**{**current.model_dump(), **set_fields})
        except ValidationError as exc:
            raise _body_validation_error(exc) from exc
        interval_changed = merged.check_interval != current.check_interval
        heartbeat_changed = merged.heartbeat_interval != current.heartbeat_interval
        url_changed = merged.heartbeat_url != current.heartbeat_url
        app.state.config.settings = merged
        _persist(app)
        if interval_changed:
            app.state.scheduler.reschedule_sync()
        if url_changed:
            app.state.runtime.set_heartbeat(None)
        if heartbeat_changed or url_changed:
            app.state.scheduler.reschedule_heartbeat(
                run_now=url_changed and merged.heartbeat_url is not None)
        dumped: dict[str, object] = merged.model_dump(mode='json')
        return dumped

    @router.post('/heartbeat/ping')
    async def ping_heartbeat() -> dict[str, object]:
        heartbeat: HeartbeatService = app.state.heartbeat
        status = await heartbeat.run(force=True)
        if status is None:
            raise HTTPException(status_code=400, detail='heartbeat URL not configured')
        return status.model_dump()

    @router.get('/healthchecks')
    def list_healthchecks() -> list[dict[str, object]]:
        return [_masked_project(p) for p in app.state.config.healthchecks]

    @router.post('/healthchecks')
    async def create_healthchecks(payload: HealthchecksInput) -> dict[str, object]:
        service: HealthchecksService = app.state.healthchecks
        try:
            remote = await service.validate(str(payload.base_url), payload.api_key)
        except HealthchecksError as exc:
            raise _upstream_error(exc) from exc
        project = HealthchecksProject(
            **payload.model_dump(), checks=merge_refs([], remote), fetched_at=time.time())
        app.state.config.healthchecks.append(project)
        _persist(app)
        service.record_success(project, remote)
        app.state.scheduler.schedule_healthchecks(project)
        return _masked_project(project)

    @router.put('/healthchecks/{project_id}')
    async def update_healthchecks(
        project_id: str, payload: HealthchecksUpdate,
    ) -> dict[str, object]:
        i, current = find_or_404(
            app.state.config.healthchecks, project_id, 'project not found')
        set_fields = payload.model_dump(exclude_unset=True)
        if set_fields.get('api_key') in ('', MASK):
            del set_fields['api_key']
        try:
            candidate = HealthchecksProject(**{**current.model_dump(), **set_fields})
        except ValidationError as exc:
            raise _body_validation_error(exc) from exc
        endpoint_changed = (
            candidate.base_url != current.base_url or candidate.api_key != current.api_key)
        if not endpoint_changed:
            app.state.config.healthchecks[i] = candidate
            _persist(app)
            if candidate.poll_interval != current.poll_interval:
                app.state.scheduler.schedule_healthchecks(candidate, run_now=True)
            return _masked_project(candidate)
        service: HealthchecksService = app.state.healthchecks
        try:
            remote = await service.validate(str(candidate.base_url), candidate.api_key)
        except HealthchecksError as exc:
            raise _upstream_error(exc) from exc
        # Re-fetch: the project may have been edited, replaced or deleted while validating.
        i, fresh = find_or_404(
            app.state.config.healthchecks, project_id, 'project not found')
        merged = HealthchecksProject(**{**fresh.model_dump(), **set_fields})
        merged.checks = merge_refs(fresh.checks, remote)
        merged.fetched_at = time.time()
        app.state.config.healthchecks[i] = merged
        _persist(app)
        service.record_success(merged, remote)
        app.state.scheduler.schedule_healthchecks(merged)
        return _masked_project(merged)

    @router.delete('/healthchecks/{project_id}')
    def delete_healthchecks(project_id: str) -> dict[str, bool]:
        i, _ = find_or_404(app.state.config.healthchecks, project_id, 'project not found')
        del app.state.config.healthchecks[i]
        _persist(app)
        app.state.scheduler.unschedule_healthchecks(project_id)
        app.state.runtime.drop_project_runtime(project_id)
        return {'ok': True}

    @router.post('/healthchecks/{project_id}/fetch')
    async def fetch_healthchecks(project_id: str) -> dict[str, object]:
        find_or_404(app.state.config.healthchecks, project_id, 'project not found')
        service: HealthchecksService = app.state.healthchecks
        try:
            project = await service.fetch(project_id)
        except HealthchecksError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        return _masked_project(project)

    @router.put('/healthchecks/{project_id}/checks/{key}')
    def set_check_visibility(
        project_id: str, key: str, payload: CheckVisibility,
    ) -> dict[str, object]:
        _, project = find_or_404(
            app.state.config.healthchecks, project_id, 'project not found')
        ref = next((c for c in project.checks if c.key == key), None)
        if ref is None:
            raise HTTPException(status_code=404, detail='check not found')
        ref.visible = payload.visible
        _persist(app)
        return _masked_project(project)

    @router.post('/refresh')
    async def refresh() -> dict[str, bool]:
        await app.state.scheduler.check_once()
        return {'ok': True}

    @router.websocket('/ws')
    async def ws_endpoint(ws: WebSocket) -> None:
        await app.state.manager.connect(ws)
        await ws.send_json({'kind': 'state', 'payload': app.state.runtime.snapshot()})
        for entry in app.state.log_handler.snapshot():
            await ws.send_json({'kind': 'log', 'payload': entry})
        app.state.manager.register(ws)
        try:
            while True:
                if await ws.receive_text() == 'ping':
                    await ws.send_json({'kind': 'pong', 'payload': None})
        except WebSocketDisconnect:
            app.state.manager.disconnect(ws)

    app.include_router(router)
