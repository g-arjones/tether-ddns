"""Tests for the /api/healthchecks routes."""
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient

import pytest

from tether_ddns.app import create_app
from tether_ddns.config_store import (
    AppConfig, ConfigStore, HealthcheckRef, HealthchecksProject, MASK)
from tether_ddns.healthchecks import HealthchecksError, RemoteCheck
from tether_ddns.incident_store import IncidentStore
from tether_ddns.state_store import StateStore

LIST = 'tether_ddns.services.healthchecks.list_checks'
NEW = {'name': 'Homelab', 'api_key': 'secret', 'poll_interval': 120}


def _remote(key: str) -> RemoteCheck:
    """Build an upstream check keyed by key."""
    return RemoteCheck(
        key=key, name=key.upper(), slug=key, status='up', last_ping=1.0, next_ping=None,
        timeout=86400, schedule=None, tz=None, grace=3600)


def _seed() -> HealthchecksProject:
    """Return a stored project with one fetched check."""
    return HealthchecksProject(
        id='p1', name='Homelab', api_key='secret', fetched_at=1.0,
        checks=[HealthcheckRef(key='k1', name='K1', slug='k1')])


def _client(tmp_path: Path, *projects: HealthchecksProject) -> Any:
    """Build a hermetic TestClient seeded with projects."""
    store = ConfigStore(tmp_path / 'cfg.json')
    config = AppConfig(healthchecks=list(projects))
    config.settings.update_on_startup = False
    store.save(config)
    return TestClient(create_app(
        store, StateStore(tmp_path / 'state.json'), IncidentStore(tmp_path / 'incidents.json')))


def _saved(tmp_path: Path) -> list[HealthchecksProject]:
    """Read the projects persisted to disk."""
    return ConfigStore(tmp_path / 'cfg.json').load().healthchecks


def test_list_masks_the_api_key(tmp_path: Path) -> None:
    """Listing projects never reveals the key."""
    with _client(tmp_path, _seed()) as client:
        body: list[dict[str, Any]] = client.get('/api/healthchecks').json()
    assert body[0]['api_key'] == MASK
    assert body[0]['base_url'] == 'https://healthchecks.io/'
    assert body[0]['checks'] == [{'key': 'k1', 'name': 'K1', 'slug': 'k1', 'visible': True}]


def test_create_fetches_persists_and_schedules(tmp_path: Path) -> None:
    """Creating a project validates it by fetching, then saves and schedules it."""
    with _client(tmp_path) as client:
        with patch(LIST, new=AsyncMock(return_value=[_remote('k1'), _remote('k2')])), \
                patch.object(client.app.state.scheduler, 'schedule_healthchecks') as sched:
            resp: Any = client.post('/api/healthchecks', json=NEW)
        runtime = client.app.state.runtime.healthchecks
    assert resp.status_code == 200
    body: dict[str, Any] = resp.json()
    assert body['api_key'] == MASK
    assert [c['key'] for c in body['checks']] == ['k1', 'k2']
    assert body['fetched_at'] is not None
    [saved] = _saved(tmp_path)
    assert saved.api_key == 'secret' and saved.poll_interval == 120
    sched.assert_called_once()
    assert sched.call_args.kwargs == {}
    assert runtime[body['id']].ok is True


@pytest.mark.parametrize(('error', 'field'), [
    (HealthchecksError('401 Unauthorized — API key invalid or revoked', 'api_key'), 'api_key'),
    (HealthchecksError('Use a read-only API key', 'api_key'), 'api_key'),
    (HealthchecksError('Unreachable: TimeoutError'), 'base_url'),
])
def test_create_upstream_failure_is_a_field_422(
    tmp_path: Path, error: HealthchecksError, field: str,
) -> None:
    """Upstream failures become an inline 422 on the right field; nothing is saved."""
    with _client(tmp_path) as client:
        with patch(LIST, new=AsyncMock(side_effect=error)):
            resp: Any = client.post('/api/healthchecks', json=NEW)
    assert resp.status_code == 422
    [detail] = resp.json()['detail']
    assert detail['loc'] == ['body', field]
    assert detail['msg'] == str(error)
    assert _saved(tmp_path) == []


@pytest.mark.parametrize('patch_body', [
    {'base_url': 'ftp://hc.lan'}, {'name': ''}, {'api_key': ''}, {'poll_interval': 30},
    {'unknown': 1},
])
def test_create_rejects_bad_bodies_without_calling_upstream(
    tmp_path: Path, patch_body: dict[str, object],
) -> None:
    """Invalid input is rejected before any upstream request."""
    with _client(tmp_path) as client:
        with patch(LIST, new=AsyncMock()) as list_checks:
            resp: Any = client.post('/api/healthchecks', json={**NEW, **patch_body})
    assert resp.status_code == 422
    list_checks.assert_not_awaited()


def test_update_masked_key_skips_validation(tmp_path: Path) -> None:
    """Renaming with the masked key keeps the key and makes no upstream call."""
    with _client(tmp_path, _seed()) as client:
        with patch(LIST, new=AsyncMock()) as list_checks, \
                patch.object(client.app.state.scheduler, 'schedule_healthchecks') as sched:
            resp: Any = client.put('/api/healthchecks/p1', json={'name': 'Lab', 'api_key': MASK})
    assert resp.status_code == 200
    list_checks.assert_not_awaited()
    sched.assert_not_called()
    [saved] = _saved(tmp_path)
    assert saved.name == 'Lab' and saved.api_key == 'secret'
    assert [c.key for c in saved.checks] == ['k1']


def test_update_new_key_validates_and_reschedules_now(tmp_path: Path) -> None:
    """A new key is validated with a poll and the job reruns at once; checks stay."""
    with _client(tmp_path, _seed()) as client:
        with patch(LIST, new=AsyncMock(return_value=[])) as list_checks, \
                patch.object(client.app.state.scheduler, 'schedule_healthchecks') as sched:
            resp: Any = client.put('/api/healthchecks/p1', json={'api_key': 'fresh'})
    assert resp.status_code == 200
    list_checks.assert_awaited_once_with('https://healthchecks.io/', 'fresh')
    assert sched.call_args.kwargs == {'run_now': True}
    [saved] = _saved(tmp_path)
    assert saved.api_key == 'fresh' and [c.key for c in saved.checks] == ['k1']


def test_update_failed_validation_saves_nothing(tmp_path: Path) -> None:
    """A new base URL that fails validation is a 422 and is not stored."""
    error = HealthchecksError('HTTP 404')
    with _client(tmp_path, _seed()) as client:
        with patch(LIST, new=AsyncMock(side_effect=error)):
            resp: Any = client.put(
                '/api/healthchecks/p1', json={'base_url': 'https://hc.lan'})
    assert resp.status_code == 422
    assert resp.json()['detail'][0]['loc'] == ['body', 'base_url']
    assert str(_saved(tmp_path)[0].base_url) == 'https://healthchecks.io/'


def test_update_interval_reschedules_without_validation(tmp_path: Path) -> None:
    """Changing only the interval reschedules at once without an upstream call."""
    with _client(tmp_path, _seed()) as client:
        with patch(LIST, new=AsyncMock()) as list_checks, \
                patch.object(client.app.state.scheduler, 'schedule_healthchecks') as sched:
            client.put('/api/healthchecks/p1', json={'poll_interval': 900})
    list_checks.assert_not_awaited()
    assert sched.call_args.kwargs == {'run_now': True}


@pytest.mark.parametrize('body', [
    {'poll_interval': None}, {'show_on_overview': None}, {'api_key': None}, {'checks': []},
])
def test_update_rejects_nulls_and_unknown_keys(tmp_path: Path, body: dict[str, object]) -> None:
    """Explicit nulls and unknown keys are a 422, never a 500."""
    with _client(tmp_path, _seed()) as client:
        resp: Any = client.put('/api/healthchecks/p1', json=body)
    assert resp.status_code == 422


def test_delete_removes_project_job_and_runtime(tmp_path: Path) -> None:
    """Deleting forgets the project, its job and its live state."""
    with _client(tmp_path, _seed()) as client:
        with patch.object(client.app.state.scheduler, 'unschedule_healthchecks') as unsched:
            resp: Any = client.delete('/api/healthchecks/p1')
        runtime = client.app.state.runtime.healthchecks
    assert resp.json() == {'ok': True}
    unsched.assert_called_once_with('p1')
    assert 'p1' not in runtime
    assert _saved(tmp_path) == []


def test_fetch_returns_the_updated_project(tmp_path: Path) -> None:
    """A manual fetch returns the rebuilt, masked project."""
    with _client(tmp_path, _seed()) as client:
        with patch(LIST, new=AsyncMock(return_value=[_remote('k2')])):
            resp: Any = client.post('/api/healthchecks/p1/fetch')
    assert resp.status_code == 200
    assert [c['key'] for c in resp.json()['checks']] == ['k2']
    assert resp.json()['api_key'] == MASK


def test_fetch_upstream_error_is_a_502(tmp_path: Path) -> None:
    """A failed fetch reports the upstream message as a 502."""
    with _client(tmp_path, _seed()) as client:
        with patch(LIST, new=AsyncMock(side_effect=HealthchecksError('429 Rate limited'))):
            resp: Any = client.post('/api/healthchecks/p1/fetch')
    assert resp.status_code == 502
    assert resp.json() == {'detail': '429 Rate limited'}


def test_set_check_visibility_persists(tmp_path: Path) -> None:
    """Toggling a check's Overview visibility is saved."""
    with _client(tmp_path, _seed()) as client:
        resp: Any = client.put('/api/healthchecks/p1/checks/k1', json={'visible': False})
    assert resp.json()['checks'][0]['visible'] is False
    assert _saved(tmp_path)[0].checks[0].visible is False


@pytest.mark.parametrize(('method', 'url', 'body'), [
    ('put', '/api/healthchecks/nope', {'name': 'x'}),
    ('delete', '/api/healthchecks/nope', None),
    ('post', '/api/healthchecks/nope/fetch', None),
    ('put', '/api/healthchecks/nope/checks/k1', {'visible': True}),
    ('put', '/api/healthchecks/p1/checks/nope', {'visible': True}),
])
def test_unknown_project_or_check_is_404(
    tmp_path: Path, method: str, url: str, body: dict[str, object] | None,
) -> None:
    """Unknown project ids and check keys return 404."""
    with _client(tmp_path, _seed()) as client:
        resp: Any = client.request(method.upper(), url, json=body)
    assert resp.status_code == 404
