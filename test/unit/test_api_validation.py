"""Save-time validation of domain and hook payloads."""
from collections.abc import Iterator
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient

import pytest

from tether_ddns.app import create_app
from tether_ddns.config_store import AppConfig, ConfigStore
from tether_ddns.incident_store import IncidentStore
from tether_ddns.state_store import StateStore

DUCK: dict[str, Any] = {
    'hostname': 'home.example.com', 'provider': 'duckdns',
    'provider_config': {'token': 'realsecret'},
}


@pytest.fixture
def client(tmp_path: Path) -> Iterator[Any]:
    """Yield a started app with hermetic stores and no startup check."""
    store = ConfigStore(tmp_path / 'cfg.json')
    config = AppConfig()
    config.settings.update_on_startup = False
    store.save(config)
    app = create_app(
        store, StateStore(tmp_path / 'state.json'), IncidentStore(tmp_path / 'inc.json'))
    with TestClient(app) as c:
        yield c


def _errors(resp: Any) -> dict[str, str]:
    """Map a 422 body to {dotted loc without 'body': msg}."""
    assert resp.status_code == 422, resp.text
    return {
        '.'.join(str(p) for p in e['loc'][1:]): e['msg'] for e in resp.json()['detail']}


@pytest.mark.parametrize('config', [{}, {'token': ''}])
def test_create_domain_requires_the_provider_token(
    client: Any, config: dict[str, str],
) -> None:
    """A missing or empty DuckDNS token is a Required error on that field."""
    resp = client.post('/api/domains', json={**DUCK, 'provider_config': config})
    assert _errors(resp) == {'provider_config.token': 'Required'}
    assert client.get('/api/domains').json() == []


@pytest.mark.parametrize('body', [
    {k: v for k, v in DUCK.items() if k != 'hostname'},
    {**DUCK, 'hostname': '   '},
])
def test_create_domain_requires_a_hostname(client: Any, body: dict[str, Any]) -> None:
    """A missing or blank hostname is rejected as Required before the handler runs."""
    assert _errors(client.post('/api/domains', json=body)) == {'hostname': 'Required'}


def test_create_domain_rejects_an_unknown_provider(client: Any) -> None:
    """An unregistered provider is reported on the provider field."""
    resp = client.post('/api/domains', json={**DUCK, 'provider': 'nope'})
    assert _errors(resp) == {'provider': 'Unknown provider'}


def test_create_domain_rejects_other_record_types(client: Any) -> None:
    """Only A and AAAA are accepted; pydantic's message passes through."""
    resp = client.post('/api/domains', json={**DUCK, 'record_type': 'MX'})
    assert _errors(resp) == {'record_type': "Input should be 'A' or 'AAAA'"}


def test_create_domain_reports_a_bad_cloudflare_ttl(client: Any) -> None:
    """A plugin-specific constraint lands on its provider_config field."""
    resp = client.post('/api/domains', json={
        **DUCK, 'provider': 'cloudflare',
        'provider_config': {'api_token': 't', 'ttl': 30}})
    assert _errors(resp) == {
        'provider_config.ttl': 'Must be 1 (auto) or between 60 and 86400'}


def test_created_domain_persists_the_raw_secret(client: Any) -> None:
    """The stored config keeps the real token, not a dumped SecretStr mask."""
    assert client.post('/api/domains', json=DUCK).status_code == 200
    stored = client.app.state.store.load()
    assert stored.domains[0].provider_config['token'] == 'realsecret'


@pytest.mark.parametrize('token', ['********', ''])
def test_update_domain_keeps_the_stored_secret(client: Any, token: str) -> None:
    """A masked or blank secret on edit means 'keep', so validation passes."""
    domain_id = client.post('/api/domains', json=DUCK).json()['id']
    resp = client.put(f'/api/domains/{domain_id}', json={
        **DUCK, 'hostname': 'new.example.com', 'provider_config': {'token': token}})
    assert resp.status_code == 200, resp.text
    stored = client.app.state.store.load()
    assert stored.domains[0].provider_config['token'] == 'realsecret'


def test_rejected_update_leaves_the_domain_untouched(client: Any) -> None:
    """Switching to a provider without its secret fails and changes nothing."""
    domain_id = client.post('/api/domains', json=DUCK).json()['id']
    resp = client.put(f'/api/domains/{domain_id}', json={
        **DUCK, 'hostname': 'new.example.com', 'provider': 'cloudflare',
        'provider_config': {}})
    assert _errors(resp) == {'provider_config.api_token': 'Required'}
    assert client.get('/api/domains').json()[0]['hostname'] == 'home.example.com'


def test_update_unknown_domain_is_still_404(client: Any) -> None:
    """Lookup happens before plugin validation."""
    assert client.put('/api/domains/nope', json=DUCK).status_code == 404


def test_create_hook_requires_its_config(client: Any) -> None:
    """A Pushover hook without a user key is rejected on config.user."""
    resp = client.post('/api/hooks-config', json={
        'hook': 'pushover', 'events': [], 'config': {'token': 't'}})
    assert _errors(resp) == {'config.user': 'Required'}


def test_create_hook_rejects_an_unknown_hook(client: Any) -> None:
    """An unregistered hook fails on hook only; events are not checked."""
    resp = client.post('/api/hooks-config', json={
        'hook': 'nope', 'events': ['ip_changed']})
    assert _errors(resp) == {'hook': 'Unknown hook'}


def test_create_hook_rejects_an_unsupported_event(client: Any) -> None:
    """Events the hook does not support are reported on events."""
    resp = client.post('/api/hooks-config', json={
        'hook': 'router_firewall', 'events': ['reachability_changed'],
        'config': {'username': 'u', 'password': 'p'}})
    assert _errors(resp) == {'events': 'Unsupported event reachability_changed'}


def test_create_hook_reports_typed_router_fields(client: Any) -> None:
    """Bad URL and IP values land on their config fields."""
    resp = client.post('/api/hooks-config', json={
        'hook': 'router_firewall', 'events': ['ip_changed'],
        'config': {'username': 'u', 'password': 'p',
                   'router_url': 'not a url', 'source_ip': '999.1.1.1'}})
    assert set(_errors(resp)) == {'config.router_url', 'config.source_ip'}


def test_update_hook_validates_the_merged_config(client: Any) -> None:
    """A masked password on edit is restored before validation."""
    created = client.post('/api/hooks-config', json={
        'hook': 'router_firewall', 'events': ['ip_changed'],
        'config': {'username': 'u', 'password': 'p'}}).json()
    ok = client.put(f"/api/hooks-config/{created['id']}", json={
        'hook': 'router_firewall', 'events': ['ip_changed'],
        'config': {'username': 'u', 'password': '********'}})
    assert ok.status_code == 200, ok.text
    bad = client.put(f"/api/hooks-config/{created['id']}", json={
        'hook': 'router_firewall', 'events': ['ip_changed'],
        'config': {'username': ' ', 'password': '********'}})
    assert _errors(bad) == {'config.username': 'Required'}


def test_other_endpoints_share_the_required_message(client: Any) -> None:
    """Healthchecks min-length fields also read Required."""
    resp = client.post('/api/healthchecks', json={'name': '', 'api_key': ''})
    assert _errors(resp) == {'name': 'Required', 'api_key': 'Required'}


def test_update_hook_422_never_echoes_the_stored_secret(client: Any) -> None:
    """A rejected update does not leak the merged config's stored password."""
    created = client.post('/api/hooks-config', json={
        'hook': 'router_firewall', 'events': ['ip_changed'],
        'config': {'username': 'u', 'password': 'STORED-ROUTER-PW'}}).json()
    resp = client.put(f"/api/hooks-config/{created['id']}", json={
        'hook': 'router_firewall', 'events': ['ip_changed'],
        'config': {'password': '********'}})
    assert resp.status_code == 422, resp.text
    assert 'STORED-ROUTER-PW' not in resp.text
    assert all('input' not in e for e in resp.json()['detail'])


def test_create_hook_422_never_echoes_the_submitted_secret(client: Any) -> None:
    """A rejected create does not leak the submitted token back to the client."""
    resp = client.post('/api/hooks-config', json={
        'hook': 'pushover', 'events': [], 'config': {'token': 'SUBMITTED-TOKEN'}})
    assert resp.status_code == 422, resp.text
    assert 'SUBMITTED-TOKEN' not in resp.text
