"""Tests for the read-only Healthchecks Management API client."""
from datetime import datetime, timezone
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import aiohttp

import pytest

from tether_ddns.healthchecks import HealthchecksError, RemoteCheck, checks_url, list_checks

BASE = 'https://healthchecks.io/'
KEY = 'ro-key'


def _raw(**overrides: Any) -> dict[str, Any]:
    """Return a read-only check payload, as the v3 API sends it."""
    check: dict[str, Any] = {
        'name': 'Backup', 'slug': 'backup', 'tags': 'nas', 'desc': '', 'grace': 3600,
        'n_pings': 3, 'status': 'up', 'started': False,
        'last_ping': '2026-09-25T12:00:00+00:00', 'next_ping': None,
        'manual_resume': False, 'methods': '', 'timeout': 86400,
        'badge_url': 'https://healthchecks.io/b/2/x.svg', 'unique_key': 'abc123'}
    check.update(overrides)
    return check


def _session(
    status: int = 200, body: object = None, json_error: Exception | None = None,
) -> MagicMock:
    """Build a ClientSession double whose GET answers with status and body."""
    resp = MagicMock()
    resp.status = status
    resp.json = AsyncMock(return_value=body, side_effect=json_error)
    session = MagicMock()
    session.get.return_value.__aenter__ = AsyncMock(return_value=resp)
    session.get.return_value.__aexit__ = AsyncMock(return_value=False)
    return session


async def _call(session: MagicMock) -> tuple[list[RemoteCheck], MagicMock]:
    """Run list_checks against a patched ClientSession; return result and the class mock."""
    with patch('tether_ddns.healthchecks.aiohttp.ClientSession') as cs:
        cs.return_value.__aenter__ = AsyncMock(return_value=session)
        cs.return_value.__aexit__ = AsyncMock(return_value=False)
        return await list_checks(BASE, KEY), cs


def test_checks_url_joins_after_stripping_the_trailing_slash() -> None:
    """The endpoint is joined onto the base URL, sub-paths included."""
    assert checks_url('https://healthchecks.io/') == 'https://healthchecks.io/api/v3/checks/'
    assert checks_url('https://hc.lan/sub/') == 'https://hc.lan/sub/api/v3/checks/'


@pytest.mark.asyncio
async def test_list_checks_sends_the_key_header_with_a_timeout() -> None:
    """The request carries X-Api-Key and a 10 s total timeout."""
    session = _session(body={'checks': []})
    _, cs = await _call(session)
    session.get.assert_called_once_with(
        'https://healthchecks.io/api/v3/checks/', headers={'X-Api-Key': KEY})
    assert cs.call_args.kwargs['timeout'].total == 10


@pytest.mark.asyncio
async def test_list_checks_parses_simple_checks() -> None:
    """A simple check is keyed by unique_key with epoch-second timestamps."""
    checks, _ = await _call(_session(body={'checks': [_raw()]}))
    [check] = checks
    assert check.key == 'abc123'
    assert check.name == 'Backup' and check.slug == 'backup' and check.status == 'up'
    assert check.last_ping == datetime(2026, 9, 25, 12, tzinfo=timezone.utc).timestamp()
    assert check.next_ping is None
    assert check.timeout == 86400 and check.grace == 3600 and check.schedule is None


@pytest.mark.asyncio
async def test_list_checks_parses_cron_checks() -> None:
    """A cron check carries schedule and tz and no timeout."""
    raw = _raw(schedule='15 5 * * *', tz='UTC')
    del raw['timeout']
    [check], _ = await _call(_session(body={'checks': [raw]}))
    assert check.schedule == '15 5 * * *' and check.tz == 'UTC' and check.timeout is None


@pytest.mark.asyncio
async def test_list_checks_accepts_an_empty_project() -> None:
    """A project with no checks yields an empty list."""
    checks, _ = await _call(_session(body={'checks': []}))
    assert checks == []


@pytest.mark.asyncio
@pytest.mark.parametrize(('status', 'message', 'field'), [
    (401, '401 Unauthorized — API key invalid or revoked', 'api_key'),
    (429, '429 Rate limited', 'base_url'),
    (404, 'HTTP 404', 'base_url'),
    (503, 'HTTP 503', 'base_url'),
])
async def test_list_checks_maps_http_errors(status: int, message: str, field: str) -> None:
    """Non-2xx responses raise operator-worded errors on the right field."""
    with pytest.raises(HealthchecksError) as info:
        await _call(_session(status=status))
    assert str(info.value) == message
    assert info.value.field == field


@pytest.mark.asyncio
async def test_list_checks_rejects_read_write_keys() -> None:
    """A response that exposes uuid came from a read-write key and is refused."""
    with pytest.raises(HealthchecksError) as info:
        await _call(_session(body={'checks': [_raw(uuid='31365bce')]}))
    assert str(info.value) == 'Use a read-only API key'
    assert info.value.field == 'api_key'


@pytest.mark.asyncio
@pytest.mark.parametrize('body', [{'nope': 1}, {'checks': [_raw(unique_key=None)]}])
async def test_list_checks_rejects_unexpected_shapes(body: object) -> None:
    """A body that is not a read-only checks list is an unexpected response."""
    with pytest.raises(HealthchecksError, match='^Unexpected response$'):
        await _call(_session(body=body))


@pytest.mark.asyncio
async def test_list_checks_rejects_non_json() -> None:
    """A body that does not decode as JSON is an unexpected response."""
    with pytest.raises(HealthchecksError, match='^Unexpected response$'):
        await _call(_session(json_error=ValueError('bad json')))


@pytest.mark.asyncio
@pytest.mark.parametrize(('error', 'message'), [
    (aiohttp.ClientConnectionError('connection refused'),
     'Unreachable: ClientConnectionError: connection refused'),
    (TimeoutError(), 'Unreachable: TimeoutError'),
])
async def test_list_checks_maps_transport_errors(error: Exception, message: str) -> None:
    """Connection failures and timeouts are reported as unreachable."""
    session = _session()
    session.get.side_effect = error
    with pytest.raises(HealthchecksError) as info:
        await _call(session)
    assert str(info.value) == message
    assert info.value.field == 'base_url'
