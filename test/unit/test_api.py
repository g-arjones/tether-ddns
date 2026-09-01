"""Tests for the REST API."""
import time
from pathlib import Path
from typing import Any, Callable
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient

import pytest

from starlette.types import Scope

from tether_ddns.app import SpaStaticFiles, create_app
from tether_ddns.config_store import AppConfig, ConfigStore, DomainConfig
from tether_ddns.incident_store import IncidentStore
from tether_ddns.incidents import WINDOW_SECONDS
from tether_ddns.reachability import ReachabilityResult
from tether_ddns.runtime import RuntimeState
from tether_ddns.state_store import StateStore


ResultFactory = Callable[[list[bool]], ReachabilityResult]


@pytest.mark.asyncio
async def test_spa_entry_point_revalidates_but_assets_do_not(tmp_path: Path) -> None:
    """index.html is served no-cache while hashed assets stay cacheable."""
    (tmp_path / 'index.html').write_text('<html></html>', encoding='utf-8')
    (tmp_path / 'app.js').write_text('// bundle', encoding='utf-8')
    static = SpaStaticFiles(directory=str(tmp_path), html=True)
    scope: Scope = {'type': 'http', 'method': 'GET', 'headers': []}

    html = await static.get_response('index.html', scope)
    asset = await static.get_response('app.js', scope)

    assert html.headers['cache-control'] == 'no-cache'
    assert 'cache-control' not in asset.headers


def _client(tmp_path: Path) -> Any:
    """Build a TestClient with startup checks disabled for hermetic tests."""
    store = ConfigStore(tmp_path / 'cfg.json')
    config = AppConfig()
    config.settings.update_on_startup = False
    store.save(config)
    state_store = StateStore(tmp_path / 'state.json')
    incident_store = IncidentStore(tmp_path / 'incidents.json')
    return TestClient(create_app(store, state_store, incident_store))


def test_incident_store_is_injectable(tmp_path: Path) -> None:
    """An injected incident store keeps the app off the shared data home."""
    store = ConfigStore(tmp_path / 'cfg.json')
    config = AppConfig()
    config.settings.update_on_startup = False
    store.save(config)
    incidents = tmp_path / 'incidents.json'
    app = create_app(
        config_store=store,
        state_store=StateStore(tmp_path / 'state.json'),
        incident_store=IncidentStore(incidents))
    with TestClient(app):
        pass
    assert incidents.exists()


def test_default_stores_resolve_into_the_data_home(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """With no stores injected, all three files land in the data home."""
    monkeypatch.setenv('TETHER_DDNS_HOME_PATH', str(tmp_path))
    config = AppConfig()
    config.settings.update_on_startup = False
    ConfigStore(tmp_path / 'tether-ddns.config.json').save(config)
    with TestClient(create_app()):
        pass
    assert (tmp_path / 'tether-ddns.incidents.json').exists()


def test_restores_domain_status_on_startup(tmp_path: Path) -> None:
    """A persisted synced domain is restored (not reset to pending) on boot."""
    store = ConfigStore(tmp_path / 'cfg.json')
    config = AppConfig(domains=[
        DomainConfig(id='a', hostname='a.example.com', provider='duckdns')])
    config.settings.update_on_startup = False
    store.save(config)

    seeded = RuntimeState()
    seeded.rebuild(config)
    seeded.set_status('a', 'synced', ip='1.2.3.4')
    state_store = StateStore(tmp_path / 'state.json')
    state_store.save(seeded)

    app = create_app(
        config_store=store, state_store=state_store,
        incident_store=IncidentStore(tmp_path / 'incidents.json'))
    with TestClient(app):
        runtime: RuntimeState = app.state.runtime
        assert runtime.domains['a'].status == 'synced'
        assert runtime.domains['a'].ip == '1.2.3.4'


def test_state_endpoint_returns_snapshot(tmp_path: Path) -> None:
    """GET /api/state returns settings, domains and logs."""
    with _client(tmp_path) as client:
        resp: Any = client.get('/api/state')
    assert resp.status_code == 200
    body: dict[str, object] = resp.json()
    assert 'settings' in body and 'domains' in body and 'logs' in body
    assert 'public_ipv4' in body and 'public_ipv6' in body


def test_providers_endpoint_lists_duckdns(tmp_path: Path) -> None:
    """GET /api/providers includes DuckDNS with a schema."""
    with _client(tmp_path) as client:
        resp: Any = client.get('/api/providers')
    providers: list[dict[str, object]] = resp.json()
    keys = [p['key'] for p in providers]
    assert 'duckdns' in keys


def test_get_hooks_returns_per_hook_labeled_events(tmp_path: Path) -> None:
    """The /hooks endpoint returns each hook's own events as key/label objects."""
    with _client(tmp_path) as client:
        resp: Any = client.get('/api/hooks')
    assert resp.status_code == 200
    hooks = {h['key']: h for h in resp.json()}
    rf = hooks['router_firewall']
    assert rf['events'] == [{'key': 'ip_changed', 'label': 'IP Changed'}]


def test_create_hook_rejects_unsupported_event(tmp_path: Path) -> None:
    """Saving a hook with an unsupported event returns 400."""
    payload: dict[str, Any] = {
        'hook': 'router_firewall', 'enabled': True,
        'events': ['reachability_changed'], 'config': {},
    }
    with _client(tmp_path) as client:
        resp: Any = client.post('/api/hooks-config', json=payload)
    assert resp.status_code == 400


def test_create_hook_accepts_supported_event(tmp_path: Path) -> None:
    """Saving a hook with a supported event succeeds."""
    payload: dict[str, Any] = {
        'hook': 'router_firewall', 'enabled': True,
        'events': ['ip_changed'],
        'config': {'username': 'u', 'password': 'p'},
    }
    with _client(tmp_path) as client:
        resp: Any = client.post('/api/hooks-config', json=payload)
    assert resp.status_code == 200


def test_run_hook_endpoint_invokes_supported_events(tmp_path: Path) -> None:
    """POST /hooks-config/{id}/run fires the hook and returns a run count."""
    with _client(tmp_path) as client:
        created: Any = client.post('/api/hooks-config', json={
            'hook': 'log', 'enabled': True, 'events': ['ip_changed'], 'config': {},
        }).json()
        client.app.state.runtime.set_public_ipv4('1.2.3.4')
        resp: Any = client.post(f"/api/hooks-config/{created['id']}/run")
    assert resp.status_code == 200
    body: dict[str, object] = resp.json()
    assert body['ran'] == 1
    assert body['skipped'] == []


def test_run_hook_endpoint_404_for_unknown_id(tmp_path: Path) -> None:
    """Running an unknown hook id returns 404."""
    with _client(tmp_path) as client:
        resp: Any = client.post('/api/hooks-config/does-not-exist/run')
    assert resp.status_code == 404


def test_create_domain_masks_secret(tmp_path: Path) -> None:
    """Creating a domain stores it and masks secrets on read-back."""
    with _client(tmp_path) as client:
        resp: Any = client.post('/api/domains', json={
            'hostname': 'home.example.com', 'provider': 'duckdns',
            'provider_config': {'token': 'realsecret', 'domain': 'home'},
        })
        assert resp.status_code == 200
        created: dict[str, dict[str, object]] = resp.json()
        assert created['provider_config']['token'] == '********'
        list_resp: Any = client.get('/api/domains')
        listed: list[dict[str, object]] = list_resp.json()
    assert listed[0]['hostname'] == 'home.example.com'


def test_hooks_and_ip_sources_endpoints(tmp_path: Path) -> None:
    """GET /api/hooks and /api/ip-sources list registered plugins."""
    with _client(tmp_path) as client:
        hooks: Any = client.get('/api/hooks')
        sources: Any = client.get('/api/ip-sources')
    hook_keys = [h['key'] for h in hooks.json()]
    source_keys = [s['key'] for s in sources.json()]
    assert 'log' in hook_keys
    assert 'ipify' in source_keys


def test_hook_config_crud_round_trip(tmp_path: Path) -> None:
    """Hook config supports create, update and delete."""
    with _client(tmp_path) as client:
        created: Any = client.post('/api/hooks-config', json={
            'hook': 'log', 'events': ['ip_changed'],
        })
        assert created.status_code == 200
        hook_id = created.json()['id']
        updated: Any = client.put(f'/api/hooks-config/{hook_id}', json={
            'hook': 'log', 'events': ['reachability_changed'],
        })
        assert updated.status_code == 200
        assert updated.json()['events'] == ['reachability_changed']
        listed: Any = client.get('/api/hooks-config')
        assert len(listed.json()) == 1
        deleted: Any = client.delete(f'/api/hooks-config/{hook_id}')
        assert deleted.status_code == 200
        assert deleted.json() == {'ok': True}
        missing: Any = client.put('/api/hooks-config/nope', json={'hook': 'log'})
        assert missing.status_code == 404
        gone: Any = client.delete('/api/hooks-config/nope')
        assert gone.status_code == 404


def test_settings_update_round_trips(tmp_path: Path) -> None:
    """PUT /api/settings validates and persists a partial update."""
    with _client(tmp_path) as client:
        resp: Any = client.put('/api/settings', json={'check_interval': 42})
        assert resp.status_code == 200
        assert resp.json()['check_interval'] == 42
        read_back: Any = client.get('/api/settings')
    assert read_back.json()['check_interval'] == 42


def test_settings_update_bad_type_returns_422(tmp_path: Path) -> None:
    """A wrong-typed settings value is rejected with 422, not 500."""
    with _client(tmp_path) as client:
        resp: Any = client.put('/api/settings', json={'check_interval': 'soon'})
    assert resp.status_code == 422


def test_about_returns_app_and_backend(tmp_path: Path) -> None:
    """GET /api/about returns app metadata and backend versions."""
    with _client(tmp_path) as client:
        resp: Any = client.get('/api/about')
    assert resp.status_code == 200
    body: dict[str, Any] = resp.json()
    assert body['app']['name'] == 'Tether'
    assert isinstance(body['app']['version'], str) and body['app']['version']
    backend: list[dict[str, str]] = body['backend']
    names = {row['name'] for row in backend}
    for name in ('Python', 'APScheduler', 'FastAPI', 'Pydantic',
                 'aiodns', 'aiohttp', 'Uvicorn', 'websockets'):
        assert name in names
    for row in backend:
        assert isinstance(row['version'], str) and row['version']


def test_about_unknown_package_falls_back(tmp_path: Path) -> None:
    """A missing distribution yields 'unknown' rather than a 500."""
    import importlib.metadata as md

    real_version = md.version

    def fake_version(dist: str) -> str:
        if dist == 'fastapi':
            raise md.PackageNotFoundError(dist)
        return real_version(dist)

    with patch('tether_ddns.api.metadata.version', side_effect=fake_version):
        with _client(tmp_path) as client:
            resp: Any = client.get('/api/about')
    assert resp.status_code == 200
    backend: list[dict[str, str]] = resp.json()['backend']
    fastapi_row = next(r for r in backend if r['name'] == 'FastAPI')
    assert fastapi_row['version'] == 'unknown'


def test_settings_update_unknown_key_returns_422(tmp_path: Path) -> None:
    """An unknown settings key is rejected with 422."""
    with _client(tmp_path) as client:
        resp: Any = client.put('/api/settings', json={'nope': 1})
    assert resp.status_code == 422


def test_sync_and_delete_domain(tmp_path: Path) -> None:
    """Sync triggers an update and delete removes the domain."""
    with _client(tmp_path) as client:
        created: Any = client.post('/api/domains', json={
            'hostname': 'home.example.com', 'provider': 'duckdns',
            'provider_config': {'token': 'realsecret', 'domain': 'home'},
        })
        domain_id = created.json()['id']
        client.app.state.runtime.public_ipv4 = '203.0.113.1'
        with patch(
            'tether_ddns.providers.ddns_providers.duckdns.DuckDNSProvider.update',
            new=AsyncMock(return_value='203.0.113.1'),
        ):
            synced: Any = client.post(f'/api/domains/{domain_id}/sync')
        assert synced.status_code == 200
        deleted: Any = client.delete(f'/api/domains/{domain_id}')
        assert deleted.json() == {'ok': True}
        missing: Any = client.delete('/api/domains/nope')
        assert missing.status_code == 404
        sync_missing: Any = client.post('/api/domains/nope/sync')
        assert sync_missing.status_code == 404


def test_manual_sync_fires_no_domain_update_events(tmp_path: Path) -> None:
    """POST /domains/{id}/sync must not fire any domain-update hook events."""
    with _client(tmp_path) as client:
        created: Any = client.post('/api/domains', json={
            'hostname': 'home.example.com', 'provider': 'duckdns',
            'provider_config': {'token': 'x', 'domain': 'home'},
        }).json()
        client.app.state.runtime.public_ipv4 = '203.0.113.1'
        captured: list[str] = []

        async def _spy(event_key: str, event: object) -> None:
            captured.append(type(event).__name__)

        with patch(
            'tether_ddns.providers.ddns_providers.duckdns.DuckDNSProvider.update',
            new=AsyncMock(return_value='203.0.113.1'),
        ), patch.object(
            client.app.state.dispatch, 'dispatch', new=_spy,
        ):
            resp: Any = client.post(f'/api/domains/{created["id"]}/sync')
        assert resp.status_code == 200
        assert captured == []


def test_sync_detects_ip_when_unknown(tmp_path: Path) -> None:
    """Forced sync with no known IP detects one, then syncs the domain."""
    with _client(tmp_path) as client:
        created: Any = client.post('/api/domains', json={
            'hostname': 'home.example.com', 'provider': 'duckdns',
            'provider_config': {'token': 'x', 'domain': 'home'},
        }).json()
        with patch(
            'tether_ddns.services.sync.detect_public_ip',
            new=AsyncMock(return_value='203.0.113.9'),
        ), patch(
            'tether_ddns.providers.ddns_providers.duckdns.DuckDNSProvider.update',
            new=AsyncMock(return_value='203.0.113.9'),
        ) as upd:
            resp: Any = client.post(f'/api/domains/{created["id"]}/sync')
        assert resp.status_code == 200
        assert upd.await_args is not None
        assert upd.await_args.args[2] == '203.0.113.9'


def test_sync_aaaa_uses_ipv6(tmp_path: Path) -> None:
    """Forced sync of an AAAA record detects and uses the IPv6 address."""
    with _client(tmp_path) as client:
        created: Any = client.post('/api/domains', json={
            'hostname': 'home.example.com', 'provider': 'duckdns', 'record_type': 'AAAA',
            'provider_config': {'token': 'x', 'domain': 'home'},
        }).json()
        with patch(
            'tether_ddns.services.sync.detect_public_ip',
            new=AsyncMock(return_value='2001:db8::9'),
        ), patch(
            'tether_ddns.providers.ddns_providers.duckdns.DuckDNSProvider.update',
            new=AsyncMock(return_value='2001:db8::9'),
        ) as upd:
            resp: Any = client.post(f'/api/domains/{created["id"]}/sync')
        assert resp.status_code == 200
        assert upd.await_args is not None
        assert upd.await_args.args[2] == '2001:db8::9'


def test_sync_returns_503_when_ip_undetectable(tmp_path: Path) -> None:
    """Forced sync returns 503 when no public IP can be determined."""
    with _client(tmp_path) as client:
        created: Any = client.post('/api/domains', json={
            'hostname': 'home.example.com', 'provider': 'duckdns',
            'provider_config': {'token': 'x', 'domain': 'home'},
        }).json()
        with patch(
            'tether_ddns.services.sync.detect_public_ip',
            new=AsyncMock(return_value=None),
        ):
            resp: Any = client.post(f'/api/domains/{created["id"]}/sync')
    assert resp.status_code == 503


def test_update_domain_round_trip(tmp_path: Path) -> None:
    """PUT /api/domains updates a known domain and 404s on unknown."""
    with _client(tmp_path) as client:
        created: Any = client.post('/api/domains', json={
            'hostname': 'home.example.com', 'provider': 'duckdns',
            'provider_config': {'token': 'realsecret', 'domain': 'home'},
        })
        domain_id = created.json()['id']
        updated: Any = client.put(f'/api/domains/{domain_id}', json={
            'hostname': 'new.example.com', 'provider': 'duckdns',
            'provider_config': {'token': '********', 'domain': 'home'},
        })
        assert updated.status_code == 200
        assert updated.json()['hostname'] == 'new.example.com'
        missing: Any = client.put('/api/domains/nope', json={
            'hostname': 'x.example.com', 'provider': 'duckdns',
        })
        assert missing.status_code == 404


def test_refresh_and_websocket(tmp_path: Path) -> None:
    """POST /api/refresh runs a check and /api/ws streams initial state."""
    reach = ReachabilityResult(online=False, successes=0, total=3)
    with patch(
        'tether_ddns.reachability.ReachabilityProbe.check',
        new=AsyncMock(return_value=reach),
    ):
        with _client(tmp_path) as client:
            refreshed: Any = client.post('/api/refresh')
            assert refreshed.status_code == 200
            with client.websocket_connect('/api/ws') as ws:
                first: dict[str, object] = ws.receive_json()
    assert first['kind'] == 'state'


def test_websocket_answers_ping_with_pong(tmp_path: Path) -> None:
    """The websocket replies to a client ping with a pong envelope."""
    kinds: list[str] = []
    with _client(tmp_path) as client:
        with client.websocket_connect('/api/ws') as ws:
            ws.send_text('ping')
            while len(kinds) < 200:
                message: dict[str, object] = ws.receive_json()
                kinds.append(str(message['kind']))
                if message['kind'] == 'pong':
                    assert message['payload'] is None
                    break
    assert 'pong' in kinds


def test_get_incidents_returns_the_window(tmp_path: Path) -> None:
    """The incidents endpoint returns the persisted window."""
    with _client(tmp_path) as client:
        res = client.get('/api/reachability/incidents')
    assert res.status_code == 200
    body = res.json()
    assert body['incidents'] == []
    assert body['ongoing'] is None
    assert 'monitoring_since' in body
    assert 'rev' in body


def test_get_incidents_filters_expired_records(
    tmp_path: Path, make_result: ResultFactory
) -> None:
    """Records outside the retention period are not served."""
    with _client(tmp_path) as client:
        recorder = client.app.state.ctx.incidents
        old = time.time() - WINDOW_SECONDS - 100
        recorder.record(make_result([False, False, False]), now=old)
        recorder.record(make_result([True, True, True]), now=old + 50)
        res = client.get('/api/reachability/incidents')
    assert res.json()['incidents'] == []
