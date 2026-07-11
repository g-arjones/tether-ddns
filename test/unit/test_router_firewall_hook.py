"""Tests for the ZTE router firewall hook."""
import hashlib
from base64 import b64decode
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

from pydantic import BaseModel, SecretStr

import pytest

from tether_ddns.hooks.base import HookEvent
from tether_ddns.hooks.registered_hooks.router_firewall import (
    RouterFirewallConfig,
    RouterFirewallHook,
    build_apply_payload,
    encode_apply_body,
    family_of,
    integrity_check,
    login_hash,
    parse_login_salt,
    parse_public_key,
    parse_rule_present,
    parse_session_token,
    protocol_number,
)

# The router's real (public) RSA key, as embedded in its page JavaScript.
_PUBKEY_B64 = (
    'MIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEAwlo/vZBnSJ2MyJ0dbNcwDvzPqBN+'
    'O/BPvLX93GIJVSZmquJHD9X6Xn6VYeM9mRKzjEbXPlv73Dj/gjjtNj9jTq2QVyW2Sd4ZkY9e'
    '3h1ALCCCfkbjnmSqedyrcvXriTeW+J65jhBje6lTJbafmC5qbGiItjt0OeOkT+Vb4S7hYPSW'
    'IjeYYBh+7Y/fg25Rt2a+RgC8dahvJ3ttB1LHXADroCm6q7G+lpbRAlpC8jjc0rZdS0c6HcBo'
    'YgzW8vxjj2fTuFy3CZZTrpPyTv/C8K6BhjTnjRe6ocgFVyQ0RIYfx2hxSJcuauR57OzfMzlg'
    'FQv3RAXguDZtuVUFLO2sAiwLELph3Acfy9Eh58SHcswZvsOSXY0JNb0XeRM9gxpntLRfM6TB'
    '7f9hYtYTDw5oKdyNBY+nnEa/IpBUjndGDrSs3Z4BxRbYcJEwkKQZkvw/5TpQYbkD6sTRVSlZ'
    'PaXSjeCl0hsLCttqwJqRZcjbWXrINBYFw8PYE14Xr9BCyPgqocdQh7FgvasVgG6u5mLR1PBZ'
    'o4EFF/LdY0yvMG5rl9egBk1XD/UMayhRtmSQEUzYt3eEWLBbqJB6MbVJ2ygcv5ELReDY0SWX'
    'w1PIEbHeP51A/MyB6kwSgZwdoQW3JiaPnGHMaE0NqfAYPNiGJLMsmvT/rNUI/8iSCW+WvSzx'
    '9tByUxsCAwEAAQ==')
_PUBKEY_HTML = (
    'var pubKey = "-----BEGIN PUBLIC KEY-----\\n'
    + _PUBKEY_B64 + '\\n-----END PUBLIC KEY-----";')
_TEST_KEY_OPT = parse_public_key(_PUBKEY_HTML)
assert _TEST_KEY_OPT is not None
_TEST_KEY: tuple[int, int] = _TEST_KEY_OPT


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


def test_parse_login_salt() -> None:
    """The login salt is extracted from the ajax XML response."""
    xml = '<ajax_response_xml_root>RqMbcSnG</ajax_response_xml_root>'
    assert parse_login_salt(xml) == 'RqMbcSnG'
    assert parse_login_salt('nope') is None


def test_parse_session_token_decodes_hex_escaped_literal() -> None:
    """The write token is decoded from a hex-escaped _sessionTmpToken literal."""
    token = 'AbC012token'
    escaped = ''.join(f'\\x{ord(c):02x}' for c in token)
    html = f'var _sessionTmpToken = "{escaped}";'
    assert parse_session_token(html) == token
    assert parse_session_token('<html>no token</html>') is None


def test_parse_session_token_uses_last_occurrence() -> None:
    """When several tokens are present, the last (active) one is returned."""
    first = ''.join(f'\\x{ord(c):02x}' for c in 'oldtoken1')
    last = ''.join(f'\\x{ord(c):02x}' for c in 'newtoken2')
    html = f'_sessionTmpToken = "{first}"; _sessionTmpToken = "{last}";'
    assert parse_session_token(html) == 'newtoken2'


def test_parse_rule_present() -> None:
    """The rule is detected by its Name para in the IP-filter data page."""
    xml = (
        '<ParaName>Name</ParaName><ParaValue>Wireguard</ParaValue>'
        '<ParaName>DestIP</ParaName><ParaValue>2001:db8::1</ParaValue>')
    assert parse_rule_present(xml, 'Wireguard') is True
    assert parse_rule_present(xml, 'Missing') is False
    assert parse_rule_present('<no/>', 'Wireguard') is False


def test_parse_public_key_extracts_modulus_and_exponent() -> None:
    """The RSA public key is parsed from the embedded PEM literal."""
    key = parse_public_key(_PUBKEY_HTML)
    assert key is not None
    modulus, exponent = key
    assert modulus.bit_length() == 4096
    assert exponent == 65537
    assert parse_public_key('<html>no key</html>') is None


def test_integrity_check_is_random_rsa_block() -> None:
    """The Check header is a fresh RSA block of the key size for each call."""
    modulus, exponent = _TEST_KEY
    body = 'IF_ACTION=Apply&DestIP=2001:db8::9&_sessionTOKEN=tok'
    check = integrity_check(body, modulus, exponent)
    # A 4096-bit RSA ciphertext is 512 bytes.
    assert len(b64decode(check)) == 512
    # PKCS#1 v1.5 padding is randomised, so repeated calls differ.
    assert integrity_check(body, modulus, exponent) != check


def test_config_schema_has_friendly_labels_and_titles() -> None:
    """The config schema carries friendly enum labels and field titles."""
    schema = RouterFirewallConfig.model_json_schema()
    props = schema['properties']
    assert props['protocol']['x-enum-labels']['tcp_udp'] == 'TCP + UDP'
    assert props['protocol']['x-enum-labels']['icmpv6'] == 'ICMPv6'
    assert props['ingress']['x-enum-labels']['dslite'] == 'DS-Lite'
    assert props['egress']['x-enum-labels']['internet'] == 'Internet'
    assert props['ip_version']['x-enum-labels']['ipv6'] == 'IPv6'
    assert props['router_url']['title'] == 'Router URL'


def _cfg(**over: Any) -> BaseModel:
    base: dict[str, Any] = {
        'username': 'admin', 'password': SecretStr('secret'), 'ip_version': 'ipv6'}
    base.update(over)
    return RouterFirewallHook.ConfigModel(**base)


def test_build_apply_payload_maps_toggle_and_views() -> None:
    """allow_traffic and friendly views map to router codes."""
    cfg = RouterFirewallHook.ConfigModel(
        username='u', password=SecretStr('p'), ip_version='ipv6',
        allow_traffic=False, ingress='dslite', egress='internet')
    assert isinstance(cfg, RouterFirewallConfig)
    payload = build_apply_payload(cfg, '1', '2001:db8::9')
    assert payload['FilterTarget'] == '0'
    assert payload['INCViewName'] == 'DEV.IP.IF8'
    assert payload['OUTCViewName'] == 'DEV.IP.IF4'


def test_encode_apply_body_orders_and_encodes_fields() -> None:
    """The body is URL-encoded in the router's field order, ending with token."""
    cfg = RouterFirewallHook.ConfigModel(
        username='u', password=SecretStr('p'), ip_version='ipv6')
    assert isinstance(cfg, RouterFirewallConfig)
    payload = build_apply_payload(cfg, '1', '2001:db8::9')
    body = encode_apply_body(payload, 'TOKEN9')
    assert body.startswith('IF_ACTION=Apply&Enable=1&')
    assert 'DestIP=2001%3Adb8%3A%3A9' in body
    assert body.endswith('&_sessionTOKEN=TOKEN9')


def _text_cm(text: str, status: int = 200) -> MagicMock:
    resp = MagicMock()
    resp.status = status
    resp.text = AsyncMock(return_value=text)
    cm = MagicMock()
    cm.__aenter__ = AsyncMock(return_value=resp)
    cm.__aexit__ = AsyncMock(return_value=False)
    return cm


_SALT_XML = '<ajax_response_xml_root>SALT1234</ajax_response_xml_root>'


def _token_html(token: str) -> str:
    escaped = ''.join(f'\\x{ord(c):02x}' for c in token)
    return f'_sessionTmpToken = "{escaped}";'


_IPFILTER_DATA = (
    '<ParaName>Name</ParaName><ParaValue>Wireguard</ParaValue>'
    '<ParaName>FilterIndex</ParaName><ParaValue>1</ParaValue>')


def _flow_session() -> MagicMock:
    session = MagicMock()
    session.get = MagicMock(side_effect=[
        _text_cm(_PUBKEY_HTML),             # GET / (login, carries pubkey)
        _text_cm(_SALT_XML),                # login_token salt
        _text_cm('<html></html>'),          # GET / (post-login)
        _text_cm('<html></html>'),          # menuView statusMgr
        _text_cm(_token_html('APPLYTOK2')),  # menuView ipfilter -> token
        _text_cm(_IPFILTER_DATA),           # menuData ipfilter
        _text_cm(_token_html('LOGOUTTOK')),  # GET / for logout token
    ])
    session.post = MagicMock(side_effect=[
        _text_cm('{"sess_token": "x", "login_need_refresh": true}'),  # login
        _text_cm('<ajax_response_xml_root><INSTIDENTITY/></ajax_response_xml_root>'),
        _text_cm('{}'),                     # logout
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
    """An IPv6 change logs in and applies the rule with a signed Apply POST."""
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
    assert login_call.kwargs['data']['_sessionTOKEN'] == ''
    apply_call = session.post.call_args_list[1]
    body = apply_call.kwargs['data']
    assert 'DestIP=2001%3Adb8%3A%3A9' in body
    assert body.endswith('&_sessionTOKEN=APPLYTOK2')
    headers = apply_call.kwargs['headers']
    assert len(b64decode(headers['Check'])) == 512


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
        _text_cm(_PUBKEY_HTML),
        _text_cm(_SALT_XML),
        _text_cm('<html></html>'),
        _text_cm('<html></html>'),
        _text_cm(_token_html('APPLYTOK2')),
        _text_cm('<ParaName>Name</ParaName><ParaValue>Other</ParaValue>'),
        _text_cm(_token_html('LOGOUTTOK')),
    ])
    session.post = MagicMock(side_effect=[
        _text_cm('{"sess_token": "x"}'),
        _text_cm('{}'),
    ])
    cs = _patch_session(session)
    try:
        await RouterFirewallHook().handle(
            HookEvent(type='ip_changed', old=None, new='2001:db8::9'),
            _cfg(rule_name='Wireguard'))
    finally:
        cs.stop()
    # Only login + logout POSTs; no apply POST.
    assert session.post.call_count == 2


@pytest.mark.asyncio
async def test_handle_aborts_without_salt() -> None:
    """A missing login salt aborts before attempting login."""
    session = MagicMock()
    session.get = MagicMock(side_effect=[
        _text_cm(_PUBKEY_HTML),
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
