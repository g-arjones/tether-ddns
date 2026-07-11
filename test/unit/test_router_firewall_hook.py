"""Tests for the ZTE router firewall hook."""
import hashlib
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

from pydantic import BaseModel, SecretStr

import pytest

from tether_ddns.hooks.base import HookEvent
from tether_ddns.hooks.registered_hooks.router_firewall import (
    RouterFirewallHook,
    family_of,
    login_hash,
    parse_login_salt,
    parse_rule_index,
    parse_session_token,
    protocol_number,
)


def test_login_hash_matches_sha256_of_password_plus_salt() -> None:
    """The login hash is sha256(password + salt) in hex."""
    expected = hashlib.sha256(('pw' + 'SALT1234').encode()).hexdigest()
    assert login_hash('pw', 'SALT1234') == expected


def test_protocol_number_mapping() -> None:
    """Protocol names map to the router's numeric codes."""
    assert protocol_number('any') == -1
    assert protocol_number('tcp') == 6
    assert protocol_number('udp') == 17
    assert protocol_number('icmpv6') == 58
    assert protocol_number('tcp_udp') == 256


def test_family_of() -> None:
    """IPv6 addresses contain a colon; IPv4 do not."""
    assert family_of('2001:db8::1') == 'ipv6'
    assert family_of('203.0.113.4') == 'ipv4'


def test_parse_session_token() -> None:
    """The hidden _sessionTOKEN value is extracted from page HTML."""
    html = '<input type="hidden" id="_sessionTOKEN" value="ABC123token" />'
    assert parse_session_token(html) == 'ABC123token'
    assert parse_session_token('<html>no token</html>') is None


def test_parse_login_salt() -> None:
    """The login salt is extracted from the ajax XML response."""
    xml = '<ajax_response_xml_root>RqMbcSnG</ajax_response_xml_root>'
    assert parse_login_salt(xml) == 'RqMbcSnG'
    assert parse_login_salt('nope') is None


def test_parse_rule_index() -> None:
    """The FilterIndex for the named rule is found; absent rule yields None."""
    html = '<tr><td>Wireguard</td><td>FilterIndex=3</td></tr>'
    assert parse_rule_index(html, 'Wireguard') == '3'
    assert parse_rule_index('<tr><td>Wireguard</td></tr>', 'Wireguard') == '1'
    assert parse_rule_index(html, 'Missing') is None


def test_parse_rule_index_anchors_to_named_row() -> None:
    """With multiple rules, the index following the named rule is chosen."""
    html = (
        '<tr><td>Other</td><td>FilterIndex=1</td></tr>'
        '<tr><td>Wireguard</td><td>FilterIndex=2</td></tr>')
    assert parse_rule_index(html, 'Wireguard') == '2'


def _cfg(**over: Any) -> BaseModel:
    base: dict[str, Any] = {
        'username': 'admin', 'password': SecretStr('secret'), 'ip_version': 'ipv6'}
    base.update(over)
    return RouterFirewallHook.ConfigModel(**base)


def _text_cm(text: str) -> MagicMock:
    resp = MagicMock()
    resp.text = AsyncMock(return_value=text)
    cm = MagicMock()
    cm.__aenter__ = AsyncMock(return_value=resp)
    cm.__aexit__ = AsyncMock(return_value=False)
    return cm


_LOGIN_HTML = '<input id="_sessionTOKEN" value="LOGINTOKEN1" />'
_SALT_XML = '<ajax_response_xml_root>SALT1234</ajax_response_xml_root>'
_IPFILTER_HTML = (
    '<input id="_sessionTOKEN" value="APPLYTOKEN2" />'
    '<tr><td>Wireguard</td><td>FilterIndex=1</td></tr>')


def _flow_session() -> MagicMock:
    session = MagicMock()
    session.get = MagicMock(side_effect=[
        _text_cm(_LOGIN_HTML),
        _text_cm(_SALT_XML),
        _text_cm(_IPFILTER_HTML),
    ])
    session.post = MagicMock(side_effect=[
        _text_cm('{"sess_token": "APPLYTOKEN2"}'),
        _text_cm('IF_ERRORID=0'),
        _text_cm('{}'),
    ])
    return session


def _patch_session(session: MagicMock) -> Any:
    cs = patch(
        'tether_ddns.hooks.registered_hooks.router_firewall.aiohttp.ClientSession')
    mock = cs.start()
    mock.return_value.__aenter__ = AsyncMock(return_value=session)
    mock.return_value.__aexit__ = AsyncMock(return_value=False)
    return cs


@pytest.mark.asyncio
async def test_handle_updates_dest_ip() -> None:
    """An IPv6 change logs in and applies the rule with the new DestIP."""
    session = _flow_session()
    cs = _patch_session(session)
    try:
        await RouterFirewallHook().handle(
            HookEvent(type='ip_changed', old='2001:db8::1', new='2001:db8::9'),
            _cfg())
    finally:
        cs.stop()
    login_call = session.post.call_args_list[0]
    assert login_call.kwargs['data']['Password'] == login_hash('secret', 'SALT1234')
    apply_call = session.post.call_args_list[1]
    payload = apply_call.kwargs['data']
    assert payload['DestIP'] == '2001:db8::9'
    assert payload['DestIPMask'] == '2001:db8::9/128'
    assert payload['_sessionTOKEN'] == 'APPLYTOKEN2'
    assert payload['IF_ACTION'] == 'Apply'
    assert payload['Protocol'] == '17'


@pytest.mark.asyncio
async def test_handle_skips_family_mismatch() -> None:
    """An IPv4 change with an ipv6 rule does nothing (no requests)."""
    session = _flow_session()
    cs = _patch_session(session)
    try:
        await RouterFirewallHook().handle(
            HookEvent(type='ip_changed', old='203.0.113.1', new='203.0.113.9'),
            _cfg(ip_version='ipv6'))
    finally:
        cs.stop()
    session.get.assert_not_called()
    session.post.assert_not_called()


@pytest.mark.asyncio
async def test_handle_ignores_non_ip_event() -> None:
    """A reachability_changed event does nothing."""
    session = _flow_session()
    cs = _patch_session(session)
    try:
        await RouterFirewallHook().handle(
            HookEvent(type='reachability_changed', old='offline', new='online'),
            _cfg())
    finally:
        cs.stop()
    session.get.assert_not_called()


@pytest.mark.asyncio
async def test_handle_rule_not_found_does_not_apply() -> None:
    """When the named rule is absent, no apply POST is sent."""
    session = MagicMock()
    session.get = MagicMock(side_effect=[
        _text_cm(_LOGIN_HTML),
        _text_cm(_SALT_XML),
        _text_cm('<input id="_sessionTOKEN" value="APPLYTOKEN2" />no rules here'),
    ])
    session.post = MagicMock(side_effect=[
        _text_cm('{"sess_token": "APPLYTOKEN2"}'),
        _text_cm('{}'),
    ])
    cs = _patch_session(session)
    try:
        await RouterFirewallHook().handle(
            HookEvent(type='ip_changed', old=None, new='2001:db8::9'),
            _cfg(rule_name='Wireguard'))
    finally:
        cs.stop()
    assert session.post.call_count == 2


@pytest.mark.asyncio
async def test_handle_aborts_without_token_or_salt() -> None:
    """Missing login token/salt aborts before attempting login."""
    session = MagicMock()
    session.get = MagicMock(side_effect=[
        _text_cm('<html>no token</html>'),
        _text_cm('nope'),
    ])
    session.post = MagicMock()
    cs = _patch_session(session)
    try:
        await RouterFirewallHook().handle(
            HookEvent(type='ip_changed', old=None, new='2001:db8::9'), _cfg())
    finally:
        cs.stop()
    session.post.assert_not_called()
