"""REST and WebSocket route registration."""
# pyright: reportUnusedFunction=false
from __future__ import annotations

from fastapi import APIRouter, FastAPI, HTTPException, WebSocket, WebSocketDisconnect

from pydantic import BaseModel, ConfigDict

from tether_ddns.config import (
    AppSettings,
    DomainConfig,
    HookConfig,
    mask_secrets,
    merge_secrets,
)
from tether_ddns.hooks.base import HOOK_REGISTRY, SUPPORTED_EVENTS
from tether_ddns.ip_sources.base import IP_SOURCE_REGISTRY
from tether_ddns.providers.base import PROVIDER_REGISTRY


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


def _provider_schema(provider: str) -> dict[str, object]:
    cls = PROVIDER_REGISTRY.get(provider)
    return cls.config_schema() if cls else {}


def _hook_schema(hook: str) -> dict[str, object]:
    cls = HOOK_REGISTRY.get(hook)
    return cls.config_schema() if cls else {}


def _masked_domain(d: DomainConfig) -> dict[str, object]:
    data = d.model_dump()
    data['provider_config'] = mask_secrets(_provider_schema(d.provider), d.provider_config)
    return data


def _masked_hook(h: HookConfig) -> dict[str, object]:
    data = h.model_dump()
    data['config'] = mask_secrets(_hook_schema(h.hook), h.config)
    return data


def _persist(app: FastAPI) -> None:
    app.state.store.save(app.state.config)


def register_routes(app: FastAPI) -> None:
    """Attach all API routes to the app."""
    router = APIRouter(prefix='/api')

    @router.get('/state')
    def get_state() -> dict[str, object]:
        cfg = app.state.config
        snap: dict[str, object] = app.state.runtime.snapshot()
        snap['settings'] = cfg.settings.model_dump()
        snap['logs'] = app.state.log_handler.snapshot()
        return snap

    @router.get('/providers')
    def get_providers() -> list[dict[str, object]]:
        return [
            {'key': k, 'display_name': c.display_name, 'schema': c.config_schema()}
            for k, c in PROVIDER_REGISTRY.items()
        ]

    @router.get('/hooks')
    def get_hooks() -> list[dict[str, object]]:
        return [
            {'key': k, 'display_name': c.display_name,
             'events': list(SUPPORTED_EVENTS), 'schema': c.config_schema()}
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
        for i, d in enumerate(app.state.config.domains):
            if d.id == domain_id:
                data = payload.model_dump()
                data['provider_config'] = merge_secrets(
                    _provider_schema(payload.provider),
                    payload.provider_config, d.provider_config)
                updated = DomainConfig(id=domain_id, **data)
                app.state.config.domains[i] = updated
                _persist(app)
                app.state.runtime.rebuild(app.state.config)
                return _masked_domain(updated)
        raise HTTPException(status_code=404, detail='domain not found')

    @router.delete('/domains/{domain_id}')
    def delete_domain(domain_id: str) -> dict[str, bool]:
        before = len(app.state.config.domains)
        app.state.config.domains = [
            d for d in app.state.config.domains if d.id != domain_id]
        if len(app.state.config.domains) == before:
            raise HTTPException(status_code=404, detail='domain not found')
        _persist(app)
        app.state.runtime.rebuild(app.state.config)
        return {'ok': True}

    @router.post('/domains/{domain_id}/sync')
    async def sync_now(domain_id: str) -> dict[str, bool]:
        from tether_ddns.ip_sources.base import IPFamily, detect_public_ip
        from tether_ddns.scheduler import sync_domain
        for d in app.state.config.domains:
            if d.id == domain_id:
                runtime = app.state.runtime
                family: IPFamily = 'ipv6' if d.record_type == 'AAAA' else 'ipv4'
                ip = runtime.public_ipv4 if family == 'ipv4' else runtime.public_ipv6
                if not ip:
                    ip = await detect_public_ip(app.state.config.settings.ip_source, family)
                    if not ip:
                        raise HTTPException(
                            status_code=503, detail='public IP unknown')
                    if family == 'ipv4':
                        runtime.set_public_ipv4(ip)
                    else:
                        runtime.set_public_ipv6(ip)
                await sync_domain(d, ip, runtime)
                return {'ok': True}
        raise HTTPException(status_code=404, detail='domain not found')

    @router.get('/hooks-config')
    def list_hook_config() -> list[dict[str, object]]:
        return [_masked_hook(h) for h in app.state.config.hooks]

    @router.post('/hooks-config')
    def create_hook(payload: HookInput) -> dict[str, object]:
        hook = HookConfig(**payload.model_dump())
        app.state.config.hooks.append(hook)
        _persist(app)
        return _masked_hook(hook)

    @router.put('/hooks-config/{hook_id}')
    def update_hook(hook_id: str, payload: HookInput) -> dict[str, object]:
        for i, h in enumerate(app.state.config.hooks):
            if h.id == hook_id:
                data = payload.model_dump()
                data['config'] = merge_secrets(
                    _hook_schema(payload.hook), payload.config, h.config)
                updated = HookConfig(id=hook_id, **data)
                app.state.config.hooks[i] = updated
                _persist(app)
                return _masked_hook(updated)
        raise HTTPException(status_code=404, detail='hook not found')

    @router.delete('/hooks-config/{hook_id}')
    def delete_hook(hook_id: str) -> dict[str, bool]:
        before = len(app.state.config.hooks)
        app.state.config.hooks = [
            h for h in app.state.config.hooks if h.id != hook_id]
        if len(app.state.config.hooks) == before:
            raise HTTPException(status_code=404, detail='hook not found')
        _persist(app)
        return {'ok': True}

    @router.get('/settings')
    def get_settings() -> dict[str, object]:
        settings: dict[str, object] = app.state.config.settings.model_dump()
        return settings

    @router.put('/settings')
    def put_settings(payload: SettingsUpdate) -> dict[str, object]:
        current = app.state.config.settings
        set_fields = payload.model_dump(exclude_unset=True)
        merged = AppSettings(**{**current.model_dump(), **set_fields})
        app.state.config.settings = merged
        _persist(app)
        dumped: dict[str, object] = merged.model_dump()
        return dumped

    @router.post('/refresh')
    async def refresh() -> dict[str, bool]:
        await app.state.scheduler.check_once(app.state.config, app.state.runtime)
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
                await ws.receive_text()
        except WebSocketDisconnect:
            app.state.manager.disconnect(ws)

    app.include_router(router)
