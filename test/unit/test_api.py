"""Tests for the REST API."""
from pathlib import Path

from fastapi.testclient import TestClient

from tether_ddns.app import create_app
from tether_ddns.config import ConfigStore


def _client(tmp_path: Path) -> TestClient:
    return TestClient(create_app(ConfigStore(tmp_path / 'cfg.json')))


def test_state_endpoint_returns_snapshot(tmp_path: Path) -> None:
    """GET /api/state returns settings, domains and logs."""
    with _client(tmp_path) as client:
        resp = client.get('/api/state')
    assert resp.status_code == 200
    body = resp.json()
    assert 'settings' in body and 'domains' in body and 'logs' in body


def test_providers_endpoint_lists_duckdns(tmp_path: Path) -> None:
    """GET /api/providers includes DuckDNS with a schema."""
    with _client(tmp_path) as client:
        resp = client.get('/api/providers')
    keys = [p['key'] for p in resp.json()]
    assert 'duckdns' in keys


def test_create_domain_masks_secret(tmp_path: Path) -> None:
    """Creating a domain stores it and masks secrets on read-back."""
    with _client(tmp_path) as client:
        resp = client.post('/api/domains', json={
            'hostname': 'home.example.com', 'provider': 'duckdns',
            'provider_config': {'token': 'realsecret', 'domain': 'home'},
        })
        assert resp.status_code == 200
        created = resp.json()
        assert created['provider_config']['token'] == '********'
        listed = client.get('/api/domains').json()
    assert listed[0]['hostname'] == 'home.example.com'
