"""Hook that updates a ZTE F6600P firewall IP-filter rule on IP change.

The ZTE F6600P web UI protects write requests with an integrity ``Check``
header: the client sends ``base64(RSA_PKCS1v1_5(sha256(body)))`` alongside the
form POST, computed with a static RSA public key embedded in the router's
JavaScript. Without a valid ``Check`` header the router answers writes with a
hidden ``SessionTimeout`` error, so the flow below reproduces it exactly.
"""
from __future__ import annotations

import hashlib
import os
import re
import urllib.parse
from base64 import b64decode, b64encode
from typing import Literal

import aiohttp

from pydantic import BaseModel, SecretStr

from tether_ddns.hooks.base import Hook, HookEvent, register_hook
from tether_ddns.logging_setup import get_logger

_log = get_logger()

_PROTOCOL_NUMBERS = {
    'any': -1, 'tcp': 6, 'udp': 17, 'icmpv6': 58, 'tcp_udp': 256,
}
_VIEW_CODES = {'lan': 'DEV.IP.IF1', 'internet': 'DEV.IP.IF4', 'dslite': 'DEV.IP.IF8'}
_IP_VERSIONS = {'ipv4': '4', 'ipv6': '6'}
_INST_ID = 'DEV.FW.CHAIN1.IPF1'

_SALT_RE = re.compile(
    r'<ajax_response_xml_root>([^<]*)</ajax_response_xml_root>')
_PUBKEY_RE = re.compile(
    r'pubKey\s*=\s*"(-----BEGIN PUBLIC KEY-----.*?-----END PUBLIC KEY-----)"',
    re.S)
_TMP_TOKEN_RE = re.compile(
    r'_sessionTmpToken\s*=\s*"((?:\\x[0-9a-fA-F]{2})+)"')
_HEX_ESCAPE_RE = re.compile(r'\\x([0-9a-fA-F]{2})')
_PARA_RE = re.compile(
    r'<ParaName>([^<]+)</ParaName>\s*<ParaValue>([^<]*)</ParaValue>')

# Ordered form fields for the IP-filter Apply POST, mirroring the browser.
_APPLY_FIELD_ORDER = (
    'IF_ACTION', 'Enable', '_InstID', 'Name', 'FilterTarget', 'FilterIndex',
    'IPVersion', 'SourceIPMask', 'DestIPMask', 'SourceIP', 'SMask', 'DestIP',
    'DMask', 'Protocol', 'hiddenProtocol', 'MinSrcPort', 'MaxSrcPort',
    'MinDstPort', 'MaxDstPort', 'INCViewName', 'OUTCViewName', 'DSCP',
    'Btn_cancel_IPFilter', 'Btn_apply_IPFilter',
)


class RouterFirewallConfig(BaseModel):
    """Configuration for the ZTE router firewall hook."""

    router_url: str = 'https://192.168.0.1'
    username: str
    password: SecretStr
    rule_name: str = 'Wireguard'
    ip_version: Literal['ipv4', 'ipv6'] = 'ipv6'
    allow_traffic: bool = True
    source_ip: str = '::'
    source_prefix: int = 0
    dest_prefix: int = 128
    protocol: Literal['any', 'tcp', 'udp', 'icmpv6', 'tcp_udp'] = 'udp'
    min_src_port: int = 1
    max_src_port: int = 65535
    min_dst_port: int = 443
    max_dst_port: int = 443
    ingress: Literal['lan', 'internet', 'dslite'] = 'internet'
    egress: Literal['lan', 'internet', 'dslite'] = 'lan'
    verify_tls: bool = False


def login_hash(password: str, salt: str) -> str:
    """Return the router login hash: sha256(password + salt) in hex."""
    return hashlib.sha256((password + salt).encode()).hexdigest()


def protocol_number(protocol: str) -> int:
    """Map a protocol name to the router's numeric protocol code."""
    return _PROTOCOL_NUMBERS.get(protocol, -1)


def family_of(ip: str) -> str:
    """Return 'ipv6' if the address contains a colon, else 'ipv4'."""
    return 'ipv6' if ':' in ip else 'ipv4'


def parse_login_salt(xml: str) -> str | None:
    """Extract the login salt from the ajax XML response."""
    match = _SALT_RE.search(xml)
    return match.group(1).strip() if match and match.group(1).strip() else None


def parse_session_token(html: str) -> str | None:
    """Extract the write token from a hex-escaped ``_sessionTmpToken`` literal.

    The router embeds the current write token in its page markup as a
    hex-escaped JavaScript string; the last occurrence is the active one.
    """
    matches = _TMP_TOKEN_RE.findall(html)
    if not matches:
        return None
    escaped = matches[-1]
    return bytes(
        int(h, 16) for h in _HEX_ESCAPE_RE.findall(escaped)
    ).decode()


def parse_rule_present(xml: str, rule_name: str) -> bool:
    """Return True when the named rule appears in the IP-filter data page."""
    for name, value in _PARA_RE.findall(xml):
        if name == 'Name' and value == rule_name:
            return True
    return False


def _read_tlv(data: bytes, index: int) -> tuple[bytes, int]:
    """Read one DER TLV; return its content bytes and the next offset."""
    length = data[index + 1]
    index += 2
    if length & 0x80:
        size = length & 0x7f
        length = int.from_bytes(data[index:index + size], 'big')
        index += size
    return data[index:index + length], index + length


def parse_public_key(html: str) -> tuple[int, int] | None:
    """Extract the router's RSA public key (modulus, exponent) from page JS.

    The key is embedded as a PEM string assigned to ``pubKey`` in the page's
    inline JavaScript; it is parsed from the SubjectPublicKeyInfo structure.
    """
    match = _PUBKEY_RE.search(html)
    if not match:
        return None
    pem = match.group(1).encode().decode('unicode_escape')
    body = ''.join(line for line in pem.splitlines() if 'KEY' not in line)
    der = b64decode(body)
    spki, _ = _read_tlv(der, 0)
    _alg, offset = _read_tlv(spki, 0)
    bitstring, _ = _read_tlv(spki, offset)
    rsa_key, _ = _read_tlv(bitstring[1:], 0)
    modulus_bytes, next_offset = _read_tlv(rsa_key, 0)
    exponent_bytes, _ = _read_tlv(rsa_key, next_offset)
    return int.from_bytes(modulus_bytes, 'big'), int.from_bytes(exponent_bytes, 'big')


def rsa_encrypt(message: bytes, modulus: int, exponent: int) -> str:
    """Encrypt ``message`` with the router key using RSA PKCS#1 v1.5 padding."""
    key_bytes = (modulus.bit_length() + 7) // 8
    padding_len = key_bytes - 3 - len(message)
    if padding_len < 8:
        raise ValueError('message too long for RSA key')
    padding = bytearray()
    while len(padding) < padding_len:
        byte = os.urandom(1)[0]
        if byte != 0:
            padding.append(byte)
    block = b'\x00\x02' + bytes(padding) + b'\x00' + message
    cipher = pow(int.from_bytes(block, 'big'), exponent, modulus)
    return b64encode(cipher.to_bytes(key_bytes, 'big')).decode()


def integrity_check(body: str, modulus: int, exponent: int) -> str:
    """Return the ``Check`` header value for a request body."""
    digest = hashlib.sha256(body.encode()).hexdigest()
    return rsa_encrypt(digest.encode(), modulus, exponent)


def build_apply_payload(
    config: RouterFirewallConfig, index: str, ip: str,
) -> dict[str, str]:
    """Assemble the IP-filter Apply form payload with the new destination IP."""
    proto = str(protocol_number(config.protocol))
    dest_mask = str(config.dest_prefix)
    return {
        'IF_ACTION': 'Apply',
        'Enable': '1',
        '_InstID': _INST_ID,
        'Name': config.rule_name,
        'FilterTarget': '1' if config.allow_traffic else '0',
        'FilterIndex': index,
        'IPVersion': _IP_VERSIONS[config.ip_version],
        'SourceIPMask': f'{config.source_ip}/{config.source_prefix}',
        'DestIPMask': f'{ip}/{dest_mask}',
        'SourceIP': config.source_ip,
        'SMask': str(config.source_prefix),
        'DestIP': ip,
        'DMask': dest_mask,
        'Protocol': proto,
        'hiddenProtocol': proto,
        'MinSrcPort': str(config.min_src_port),
        'MaxSrcPort': str(config.max_src_port),
        'MinDstPort': str(config.min_dst_port),
        'MaxDstPort': str(config.max_dst_port),
        'INCViewName': _VIEW_CODES[config.ingress],
        'OUTCViewName': _VIEW_CODES[config.egress],
        'DSCP': '-1',
        'Btn_cancel_IPFilter': '',
        'Btn_apply_IPFilter': '',
    }


def encode_apply_body(payload: dict[str, str], token: str) -> str:
    """Serialise the payload to the exact URL-encoded body the router expects.

    The body is signed by :func:`integrity_check`, so it must be built as the
    literal string that is transmitted, ending with the session token.
    """
    parts = [
        f'{key}={urllib.parse.quote(payload[key], safe="")}'
        for key in _APPLY_FIELD_ORDER
    ]
    parts.append(f'_sessionTOKEN={token}')
    return '&'.join(parts)


@register_hook
class RouterFirewallHook(Hook):
    """Updates a ZTE F6600P firewall IP-filter rule on public IP change."""

    key = 'router_firewall'
    display_name = 'Router Firewall (ZTE)'
    ConfigModel = RouterFirewallConfig

    _XHR_HEADERS = {'X-Requested-With': 'XMLHttpRequest'}
    _DATA_TAG = 'firewall_ipfilter_lua.lua'

    async def handle(self, event: HookEvent, config: BaseModel) -> None:
        """Update the configured firewall rule to the new public IP."""
        assert isinstance(config, RouterFirewallConfig)
        if event.type != 'ip_changed' or not event.new:
            return
        ip = event.new
        if family_of(ip) != config.ip_version:
            return
        base = config.router_url.rstrip('/')
        headers = {**self._XHR_HEADERS, 'Referer': f'{base}/'}
        # The router serves a self-signed certificate; verification is opt-in.
        connector = aiohttp.TCPConnector(ssl=config.verify_tls)
        # The router is reached by IP, so the cookie jar must accept those.
        jar = aiohttp.CookieJar(unsafe=True)
        async with aiohttp.ClientSession(
                connector=connector, cookie_jar=jar) as session:
            public_key = await self._login(session, base, headers, config)
            if public_key is None:
                return
            token = await self._prepare_ipfilter(session, base, headers, config)
            if token is None:
                await self._logout(session, base, headers)
                return
            await self._apply(
                session, base, headers, config, ip, token, public_key)
            await self._logout(session, base, headers)

    async def _login(
        self, session: aiohttp.ClientSession, base: str,
        headers: dict[str, str], config: RouterFirewallConfig,
    ) -> tuple[int, int] | None:
        """Log in and return the router's RSA public key, or None on failure."""
        async with session.get(f'{base}/', headers=headers) as resp:
            public_key = parse_public_key(await resp.text())
        if public_key is None:
            _log.warning('Router firewall: could not obtain public key')
            return None
        async with session.get(
                f'{base}/?_type=loginData&_tag=login_token',
                headers=headers) as resp:
            salt = parse_login_salt(await resp.text())
        if not salt:
            _log.warning('Router firewall: could not obtain login salt')
            return None
        login_data = {
            'action': 'login',
            'Username': config.username,
            'Password': login_hash(config.password.get_secret_value(), salt),
            '_sessionTOKEN': '',
        }
        async with session.post(
                f'{base}/?_type=loginData&_tag=login_entry',
                data=login_data, headers=headers) as resp:
            await resp.text()
        return public_key

    async def _prepare_ipfilter(
        self, session: aiohttp.ClientSession, base: str,
        headers: dict[str, str], config: RouterFirewallConfig,
    ) -> str | None:
        """Open the IP-filter view and return its write token when present."""
        async with session.get(f'{base}/', headers=headers) as resp:
            await resp.text()
        async with session.get(
                f'{base}/?_type=menuView&_tag=statusMgr',
                headers=headers) as resp:
            await resp.text()
        async with session.get(
                f'{base}/?_type=menuView&_tag=ipfilter&Menu3Location=0',
                headers=headers) as resp:
            token = parse_session_token(await resp.text())
        async with session.get(
                f'{base}/?_type=menuData&_tag={self._DATA_TAG}',
                headers=headers) as resp:
            data = await resp.text()
        if token is None or not parse_rule_present(data, config.rule_name):
            _log.warning(
                'Router firewall: rule %s or token not found', config.rule_name)
            return None
        return token

    async def _apply(
        self, session: aiohttp.ClientSession, base: str,
        headers: dict[str, str], config: RouterFirewallConfig, ip: str,
        token: str, public_key: tuple[int, int],
    ) -> None:
        """Send the signed Apply POST that updates the rule's destination IP."""
        payload = build_apply_payload(config, '1', ip)
        body = encode_apply_body(payload, token)
        modulus, exponent = public_key
        post_headers = {
            **headers,
            'Check': integrity_check(body, modulus, exponent),
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        }
        async with session.post(
                f'{base}/?_type=menuData&_tag={self._DATA_TAG}',
                data=body, headers=post_headers) as resp:
            result = await resp.text()
            status = resp.status
        if status == 200 and 'SessionTimeout' not in result:
            _log.info('Router firewall: applied %s -> %s', config.rule_name, ip)
        else:
            _log.warning(
                'Router firewall: apply failed (%s): %s', status, result[:200])

    async def _logout(
        self, session: aiohttp.ClientSession, base: str,
        headers: dict[str, str],
    ) -> None:
        """Best-effort logout to release the single admin session."""
        async with session.get(f'{base}/', headers=headers) as resp:
            token = parse_session_token(await resp.text())
        if not token:
            return
        async with session.post(
                f'{base}/?_type=loginData&_tag=logout_entry',
                data={'IF_LogOff': '1', '_sessionTOKEN': token},
                headers=headers) as resp:
            await resp.text()
