"""Hook that updates a ZTE F6600P firewall IP-filter rule on IP change."""
from __future__ import annotations

import hashlib
import re
from typing import Literal

import aiohttp

from pydantic import BaseModel, SecretStr

from tether_ddns.hooks.base import Hook, HookEvent, register_hook
from tether_ddns.logging_setup import get_logger

_log = get_logger()

_PROTOCOL_NUMBERS = {
    'any': -1, 'tcp': 6, 'udp': 17, 'icmpv6': 58, 'tcp_udp': 256,
}
_FILTER_TARGETS = {'allow': '1', 'drop': '0'}
_IP_VERSIONS = {'ipv4': '4', 'ipv6': '6'}
_INST_ID = 'DEV.FW.CHAIN1.IPF1'
_SESSION_TOKEN_RE = re.compile(
    r'id=["\']_sessionTOKEN["\'][^>]*value=["\']([^"\']+)["\']')
_SALT_RE = re.compile(
    r'<ajax_response_xml_root>([^<]*)</ajax_response_xml_root>')
_FILTER_INDEX_RE = re.compile(r'FilterIndex[=\"\'>: ]+(\d+)')


class RouterFirewallConfig(BaseModel):
    """Configuration for the ZTE router firewall hook."""

    router_url: str = 'https://192.168.0.1'
    username: str
    password: SecretStr
    rule_name: str = 'Wireguard'
    ip_version: Literal['ipv4', 'ipv6'] = 'ipv6'
    filter_target: Literal['allow', 'drop'] = 'allow'
    source_ip: str = '::'
    source_prefix: int = 0
    dest_prefix: int = 128
    protocol: Literal['any', 'tcp', 'udp', 'icmpv6', 'tcp_udp'] = 'udp'
    min_src_port: int = 1
    max_src_port: int = 65535
    min_dst_port: int = 443
    max_dst_port: int = 443
    ingress_view: str = 'DEV.IP.IF4'
    egress_view: str = 'DEV.IP.IF1'
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


def parse_session_token(html: str) -> str | None:
    """Extract the hidden _sessionTOKEN value from page HTML."""
    match = _SESSION_TOKEN_RE.search(html)
    return match.group(1) if match else None


def parse_login_salt(xml: str) -> str | None:
    """Extract the login salt from the ajax XML response."""
    match = _SALT_RE.search(xml)
    return match.group(1).strip() if match and match.group(1).strip() else None


def parse_rule_index(html: str, rule_name: str) -> str | None:
    """Return the FilterIndex for the named rule, or None if absent.

    The index is searched in the window of markup following the rule name so
    that, with multiple rules present, the correct row's index is chosen.
    """
    pos = html.find(rule_name)
    if pos < 0:
        return None
    match = _FILTER_INDEX_RE.search(html, pos)
    return match.group(1) if match else '1'


def _build_apply_payload(
    config: RouterFirewallConfig, index: str, ip: str,
) -> dict[str, str]:
    """Assemble the IP-filter Apply form payload with the new destination IP."""
    proto = str(protocol_number(config.protocol))
    dest_mask = str(config.dest_prefix)
    return {
        'IF_ACTION': 'Apply',
        '_InstID': _INST_ID,
        'FilterIndex': index,
        'Enable': '1',
        'Name': config.rule_name,
        'FilterTarget': _FILTER_TARGETS[config.filter_target],
        'IPVersion': _IP_VERSIONS[config.ip_version],
        'SourceIP': config.source_ip,
        'SMask': str(config.source_prefix),
        'SourceIPMask': f'{config.source_ip}/{config.source_prefix}',
        'DestIP': ip,
        'DMask': dest_mask,
        'DestIPMask': f'{ip}/{dest_mask}',
        'Protocol': proto,
        'hiddenProtocol': proto,
        'MinSrcPort': str(config.min_src_port),
        'MaxSrcPort': str(config.max_src_port),
        'MinDstPort': str(config.min_dst_port),
        'MaxDstPort': str(config.max_dst_port),
        'INCViewName': config.ingress_view,
        'OUTCViewName': config.egress_view,
        'DSCP': '-1',
        'Btn_apply_IPFilter': '',
    }


@register_hook
class RouterFirewallHook(Hook):
    """Updates a ZTE F6600P firewall IP-filter rule on public IP change."""

    key = 'router_firewall'
    display_name = 'Router Firewall (ZTE)'
    ConfigModel = RouterFirewallConfig

    async def handle(self, event: HookEvent, config: BaseModel) -> None:
        """Update the configured firewall rule to the new public IP."""
        assert isinstance(config, RouterFirewallConfig)
        if event.type != 'ip_changed' or not event.new:
            return
        ip = event.new
        if family_of(ip) != config.ip_version:
            return
        base = config.router_url.rstrip('/')
        # The router serves a self-signed certificate; verification is opt-in.
        connector = aiohttp.TCPConnector(ssl=config.verify_tls)
        async with aiohttp.ClientSession(connector=connector) as session:
            async with session.get(f'{base}/') as resp:
                login_token = parse_session_token(await resp.text())
            async with session.get(
                    f'{base}/?_type=loginData&_tag=login_token') as resp:
                salt = parse_login_salt(await resp.text())
            if not login_token or not salt:
                _log.warning('Router firewall: could not obtain login token/salt')
                return
            login_data = {
                'action': 'login',
                'Username': config.username,
                'Password': login_hash(config.password.get_secret_value(), salt),
                '_sessionTOKEN': login_token,
            }
            async with session.post(
                    f'{base}/?_type=loginData&_tag=login_entry',
                    data=login_data) as resp:
                await resp.text()

            tag = 'firewall_ipfilter_lua.lua'
            async with session.get(
                    f'{base}/?_type=menuData&_tag={tag}') as resp:
                page = await resp.text()
            apply_token = parse_session_token(page)
            index = parse_rule_index(page, config.rule_name)
            if index is None or apply_token is None:
                _log.warning(
                    'Router firewall: rule %s or token not found', config.rule_name)
                await self._logout(session, base, apply_token)
                return

            payload = _build_apply_payload(config, index, ip)
            payload['_sessionTOKEN'] = apply_token
            async with session.post(
                    f'{base}/?_type=menuData&_tag={tag}', data=payload) as resp:
                result = await resp.text()
            if 'IF_ERRORID=0' in result or 'success' in result.lower():
                _log.info('Router firewall: applied %s -> %s', config.rule_name, ip)
            else:
                _log.warning('Router firewall: apply response: %s', result[:200])
            await self._logout(session, base, apply_token)

    async def _logout(
        self, session: aiohttp.ClientSession, base: str, token: str | None,
    ) -> None:
        """Best-effort logout to release the single admin session."""
        if not token:
            return
        async with session.post(
                f'{base}/?_type=loginData&_tag=logout_entry',
                data={'IF_LogOff': '1', '_sessionTOKEN': token}) as resp:
            await resp.text()
