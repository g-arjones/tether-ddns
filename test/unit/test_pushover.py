"""Tests for the Pushover hook."""
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

from pydantic import SecretStr

import pytest

from tether_ddns.hooks.base import (
    DomainUpdateErrorEvent,
    DomainUpdatePendingEvent,
    DomainUpdateSuccessEvent,
    ReachabilityChangedEvent,
)
from tether_ddns.hooks.registered_hooks.pushover import (
    PushoverConfig,
    PushoverHook,
)


def _cfg() -> PushoverConfig:
    return PushoverConfig(token=SecretStr('tok123'), user=SecretStr('usr456'))


def _session_returning(status: int, body: dict[str, object]) -> MagicMock:
    resp = MagicMock()
    resp.status = status
    resp.json = AsyncMock(return_value=body)
    session = MagicMock()
    session.post.return_value.__aenter__ = AsyncMock(return_value=resp)
    session.post.return_value.__aexit__ = AsyncMock(return_value=False)
    return session


def _patch_session(session: MagicMock) -> Any:
    cs = patch(
        'tether_ddns.hooks.registered_hooks.pushover.aiohttp.ClientSession')
    mock = cs.start()
    mock.return_value.__aenter__ = AsyncMock(return_value=session)
    mock.return_value.__aexit__ = AsyncMock(return_value=False)
    return cs


def test_supported_events() -> None:
    """The hook supports exactly the three domain-update events."""
    assert set(PushoverHook.supported_events()) == {
        'domain_update_pending', 'domain_update_success',
        'domain_update_error', 'reachability_changed'}


@pytest.mark.asyncio
async def test_success_posts_message() -> None:
    """A success event posts a normal-priority message with token/user."""
    session = _session_returning(200, {'status': 1})
    cs = _patch_session(session)
    try:
        await PushoverHook().on_domain_update_success(
            DomainUpdateSuccessEvent(
                domain_id='a', hostname='home.example.com',
                record_type='A', family='ipv4', ip='1.2.3.4'),
            _cfg())
    finally:
        cs.stop()
    call = session.post.call_args
    assert call.args[0] == 'https://api.pushover.net/1/messages.json'
    data = call.kwargs['data']
    assert data['token'] == 'tok123'
    assert data['user'] == 'usr456'
    assert data['title'] == 'home.example.com'
    assert data['message'] == 'Updated home.example.com A -> 1.2.3.4'
    assert data['priority'] == 0


@pytest.mark.asyncio
async def test_pending_posts_message() -> None:
    """A pending event posts a normal-priority staleness message."""
    session = _session_returning(200, {'status': 1})
    cs = _patch_session(session)
    try:
        await PushoverHook().on_domain_update_pending(
            DomainUpdatePendingEvent(
                domain_id='a', hostname='home.example.com',
                record_type='AAAA', family='ipv6', current_ip='2001:db8::9'),
            _cfg())
    finally:
        cs.stop()
    data = session.post.call_args.kwargs['data']
    assert data['message'] == (
        'home.example.com AAAA is stale (current IP 2001:db8::9)')
    assert data['priority'] == 0


@pytest.mark.asyncio
async def test_reachability_changed_posts_message() -> None:
    """A reachability-changed event posts a high-priority message."""
    session = _session_returning(200, {'status': 1})
    cs = _patch_session(session)
    try:
        await PushoverHook().on_reachability_changed(ReachabilityChangedEvent(online=True), _cfg())
    finally:
        cs.stop()
    data = session.post.call_args.kwargs['data']
    assert data['message'] == 'Reachability changed to online'
    assert data['priority'] == 1


@pytest.mark.asyncio
async def test_error_posts_high_priority() -> None:
    """An error event posts a high-priority failure message."""
    session = _session_returning(200, {'status': 1})
    cs = _patch_session(session)
    try:
        await PushoverHook().on_domain_update_error(
            DomainUpdateErrorEvent(
                domain_id='a', hostname='home.example.com',
                record_type='A', family='ipv4', ip='1.2.3.4',
                message='provider down'),
            _cfg())
    finally:
        cs.stop()
    data = session.post.call_args.kwargs['data']
    assert data['message'] == (
        'Failed to update home.example.com A: provider down')
    assert data['priority'] == 1


@pytest.mark.asyncio
async def test_api_error_raises_without_secrets() -> None:
    """A status!=1 response raises and does not leak token or user."""
    session = _session_returning(
        400, {'status': 0, 'errors': ['user identifier is invalid']})
    cs = _patch_session(session)
    try:
        with pytest.raises(RuntimeError) as exc:
            await PushoverHook().on_domain_update_success(
                DomainUpdateSuccessEvent(
                    domain_id='a', hostname='home.example.com',
                    record_type='A', family='ipv4', ip='1.2.3.4'),
                _cfg())
    finally:
        cs.stop()
    text = str(exc.value)
    assert 'user identifier is invalid' in text
    assert 'tok123' not in text
    assert 'usr456' not in text


@pytest.mark.asyncio
async def test_non_200_raises() -> None:
    """A non-200 HTTP status raises even when body status is 1."""
    session = _session_returning(500, {'status': 1})
    cs = _patch_session(session)
    try:
        with pytest.raises(RuntimeError):
            await PushoverHook().on_domain_update_success(
                DomainUpdateSuccessEvent(
                    domain_id='a', hostname='home.example.com',
                    record_type='A', family='ipv4', ip='1.2.3.4'),
                _cfg())
    finally:
        cs.stop()


@pytest.mark.asyncio
async def test_non_json_body_on_error_raises() -> None:
    """A non-200 with a non-JSON body still raises a clear RuntimeError."""
    resp = MagicMock()
    resp.status = 500
    resp.json = AsyncMock(side_effect=ValueError('not json'))
    session = MagicMock()
    session.post.return_value.__aenter__ = AsyncMock(return_value=resp)
    session.post.return_value.__aexit__ = AsyncMock(return_value=False)
    cs = _patch_session(session)
    try:
        with pytest.raises(RuntimeError) as exc:
            await PushoverHook().on_domain_update_success(
                DomainUpdateSuccessEvent(
                    domain_id='a', hostname='home.example.com',
                    record_type='A', family='ipv4', ip='1.2.3.4'),
                _cfg())
    finally:
        cs.stop()
    assert 'HTTP 500' in str(exc.value)
