"""Tests for the Cloudflare provider."""
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

from pydantic import BaseModel, SecretStr

import pytest

from tether_ddns.providers.ddns_providers.cloudflare import (
    CloudflareProvider,
    zone_matches,
)


def _cfg(proxied: bool = False, ttl: int = 1) -> BaseModel:
    return CloudflareProvider.ConfigModel(
        api_token=SecretStr('tok'), proxied=proxied, ttl=ttl)


def _json_cm(payload: dict[str, Any]) -> MagicMock:
    """Build an async context manager whose response.json() returns payload."""
    resp = MagicMock()
    resp.json = AsyncMock(return_value=payload)
    cm = MagicMock()
    cm.__aenter__ = AsyncMock(return_value=resp)
    cm.__aexit__ = AsyncMock(return_value=False)
    return cm


def _session(
    get_payloads: list[dict[str, Any]], put_payload: dict[str, Any],
) -> MagicMock:
    session = MagicMock()
    session.get = MagicMock(side_effect=[_json_cm(p) for p in get_payloads])
    session.put = MagicMock(return_value=_json_cm(put_payload))
    return session


def _patch_session(session: MagicMock) -> Any:
    cs = patch(
        'tether_ddns.providers.ddns_providers.cloudflare.aiohttp.ClientSession')
    mock = cs.start()
    mock.return_value.__aenter__ = AsyncMock(return_value=session)
    mock.return_value.__aexit__ = AsyncMock(return_value=False)
    return cs


def testzone_matches_label_boundary() -> None:
    """Zone match is on a label boundary, not a bare substring."""
    assert zone_matches('arjones.com', 'box.arjones.com') is True
    assert zone_matches('arjones.com', 'arjones.com') is True
    assert zone_matches('jones.com', 'box.arjones.com') is False


@pytest.mark.asyncio
async def test_update_success() -> None:
    """Zone + record resolve and the PUT succeeds."""
    session = _session(
        get_payloads=[
            {'result': [{'id': 'z1', 'name': 'arjones.com'}]},
            {'result': [{'id': 'r1', 'name': 'box.arjones.com'}]},
        ],
        put_payload={'success': True, 'result': {'id': 'r1'}, 'errors': []},
    )
    cs = _patch_session(session)
    try:
        result = await CloudflareProvider().update(
            'box.arjones.com', 'AAAA', '2001:db8::1', _cfg())
    finally:
        cs.stop()
    assert result == '2001:db8::1'
    _, kwargs = session.put.call_args
    assert kwargs['json']['type'] == 'AAAA'
    assert kwargs['json']['content'] == '2001:db8::1'


@pytest.mark.asyncio
async def test_update_zone_not_found() -> None:
    """No matching zone raises TetherError."""
    from tether_ddns.errors import TetherError
    session = _session(get_payloads=[{'result': []}], put_payload={})
    cs = _patch_session(session)
    try:
        with pytest.raises(TetherError, match='zone'):
            await CloudflareProvider().update(
                'box.arjones.com', 'A', '1.2.3.4', _cfg())
    finally:
        cs.stop()


@pytest.mark.asyncio
async def test_update_record_not_found() -> None:
    """Zone matched but no record raises TetherError."""
    from tether_ddns.errors import TetherError
    session = _session(
        get_payloads=[
            {'result': [{'id': 'z1', 'name': 'arjones.com'}]},
            {'result': []},
        ],
        put_payload={},
    )
    cs = _patch_session(session)
    try:
        with pytest.raises(TetherError, match='not found'):
            await CloudflareProvider().update(
                'box.arjones.com', 'A', '1.2.3.4', _cfg())
    finally:
        cs.stop()


@pytest.mark.asyncio
async def test_update_api_error() -> None:
    """A Cloudflare error response raises TetherError with the error message."""
    from tether_ddns.errors import TetherError
    session = _session(
        get_payloads=[
            {'result': [{'id': 'z1', 'name': 'arjones.com'}]},
            {'result': [{'id': 'r1', 'name': 'box.arjones.com'}]},
        ],
        put_payload={'success': False, 'errors': [{'message': 'bad token'}]},
    )
    cs = _patch_session(session)
    try:
        with pytest.raises(TetherError, match='bad token'):
            await CloudflareProvider().update(
                'box.arjones.com', 'A', '1.2.3.4', _cfg())
    finally:
        cs.stop()


@pytest.mark.asyncio
async def test_update_picks_longest_matching_zone() -> None:
    """When multiple zones match, the most specific (longest) one wins."""
    session = _session(
        get_payloads=[
            {'result': [
                {'id': 'z1', 'name': 'arjones.com'},
                {'id': 'z2', 'name': 'sub.arjones.com'},
            ]},
            {'result': [{'id': 'r1', 'name': 'box.sub.arjones.com'}]},
        ],
        put_payload={'success': True, 'errors': []},
    )
    cs = _patch_session(session)
    try:
        result = await CloudflareProvider().update(
            'box.sub.arjones.com', 'A', '1.2.3.4', _cfg())
    finally:
        cs.stop()
    assert result == '1.2.3.4'
    # the record lookup used the longest zone id (z2)
    record_call = session.get.call_args_list[1]
    assert '/zones/z2/dns_records' in record_call.args[0]
