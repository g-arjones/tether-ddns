"""Tests for the REST API."""
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient

from tether_ddns.app import create_app
from tether_ddns.config import AppConfig, ConfigStore
from tether_ddns.providers.base import UpdateResult
from tether_ddns.reachability import ReachabilityResult


def _client(tmp_path: Path) -> Any:
    """Build a TestClient with startup checks disabled for hermetic tests."""
    store = ConfigStore(tmp_path / 'cfg.json')
    config = AppConfig()
    config.settings.update_on_startup = False
    store.save(config)
    return TestClient(create_app(store))


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
    payload = {
        'hook': 'router_firewall', 'enabled': True,
        'events': ['reachability_changed'], 'config': {},
    }
    with _client(tmp_path) as client:
        resp: Any = client.post('/api/hooks-config', json=payload)
    assert resp.status_code == 400


def test_create_hook_accepts_supported_event(tmp_path: Path) -> None:
    """Saving a hook with a supported event succeeds."""
    payload = {
        'hook': 'router_firewall', 'enabled': True,
        'events': ['ip_changed'],
        'config': {'username': 'u', 'password': 'p'},
    }
    with _client(tmp_path) as client:
        resp: Any = client.post('/api/hooks-config', json=payload)
    assert resp.status_code == 200


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
            new=AsyncMock(return_value=UpdateResult(success=True, ip='203.0.113.1')),
        ):
            synced: Any = client.post(f'/api/domains/{domain_id}/sync')
        assert synced.status_code == 200
        deleted: Any = client.delete(f'/api/domains/{domain_id}')
        assert deleted.json() == {'ok': True}
        missing: Any = client.delete('/api/domains/nope')
        assert missing.status_code == 404
        sync_missing: Any = client.post('/api/domains/nope/sync')
        assert sync_missing.status_code == 404


def test_sync_detects_ip_when_unknown(tmp_path: Path) -> None:
    """Forced sync with no known IP detects one, then syncs the domain."""
    with _client(tmp_path) as client:
        created: Any = client.post('/api/domains', json={
            'hostname': 'home.example.com', 'provider': 'duckdns',
            'provider_config': {'token': 'x', 'domain': 'home'},
        }).json()
        with patch(
            'tether_ddns.ip_sources.base.detect_public_ip',
            new=AsyncMock(return_value='203.0.113.9'),
        ), patch(
            'tether_ddns.providers.ddns_providers.duckdns.DuckDNSProvider.update',
            new=AsyncMock(return_value=UpdateResult(success=True, ip='203.0.113.9')),
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
            'tether_ddns.ip_sources.base.detect_public_ip',
            new=AsyncMock(return_value='2001:db8::9'),
        ), patch(
            'tether_ddns.providers.ddns_providers.duckdns.DuckDNSProvider.update',
            new=AsyncMock(return_value=UpdateResult(success=True, ip='2001:db8::9')),
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
            'tether_ddns.ip_sources.base.detect_public_ip',
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
        'tether_ddns.scheduler.ReachabilityService.check',
        new=AsyncMock(return_value=reach),
    ):
        with _client(tmp_path) as client:
            refreshed: Any = client.post('/api/refresh')
            assert refreshed.status_code == 200
            with client.websocket_connect('/api/ws') as ws:
                first: dict[str, object] = ws.receive_json()
    assert first['kind'] == 'state'
