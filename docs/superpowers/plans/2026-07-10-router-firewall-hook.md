# Router Firewall Hook — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an auto-loaded hook that updates a ZTE F6600P firewall IP-filter rule's destination IP when the public IP changes.

**Architecture:** One hook module (subclass `Hook`, `@register_hook`) with pure helpers (login hash, protocol/view mapping, token/rule parsing) and the async HTTP flow via aiohttp, plus unit tests. No other wiring — the registry auto-loads it and the UI renders the form from the schema.

**Tech Stack:** Python 3.12 (aiohttp, pydantic, hashlib).

## Global Constraints

- Python `>=3.12`. Strict gates: flake8 (pep257 docstrings, alphabetical import order, single quotes, naming), mypy (`mypy .`), pyright strict (`pyright tether_ddns`), ruff. Docstrings + full annotations.
- Backend coverage gate: `pytest test/` must pass with `--cov-fail-under=90`.
- Secrets use `pydantic.SecretStr`; the password is used only to compute `sha256(password + salt)` and is never logged.
- The hook does NOT need its own broad try/except (the hook dispatcher wraps each hook with exception isolation). Use `# noqa: BLE001` only if a genuinely defensive broad catch is needed inside a parse helper.
- TLS verification is disabled by default (self-signed router cert), controlled by `verify_tls`, scoped to the hook's aiohttp connector, with an explanatory comment.
- No changes outside the new hook file + its test (registry auto-loads it).
- Venv at `.venv` (`source .venv/bin/activate`; project uses `uv`). Backend unit tests in `test/unit/`.

## File Structure

- Create `tether_ddns/hooks/registered_hooks/router_firewall.py` — config model, pure helpers, and `RouterFirewallHook`.
- Create `test/unit/test_router_firewall_hook.py`.

---

## Task 1: Config model + pure helpers

**Files:**
- Create: `tether_ddns/hooks/registered_hooks/router_firewall.py` (helpers + config; hook class added in Task 2)
- Test: `test/unit/test_router_firewall_hook.py` (helper tests)

**Interfaces:**
- `RouterFirewallConfig(BaseModel)` with the fields from the spec.
- `def _login_hash(password: str, salt: str) -> str` → `sha256((password + salt).encode()).hexdigest()`.
- `def _protocol_number(protocol: str) -> int` → any=-1, tcp=6, udp=17, icmpv6=58, tcp_udp=256.
- `def _family_of(ip: str) -> str` → `'ipv6' if ':' in ip else 'ipv4'`.
- `def _parse_session_token(html: str) -> str | None` — extract the hidden `_sessionTOKEN` value from page HTML.
- `def _parse_login_salt(xml: str) -> str | None` — extract text between `<ajax_response_xml_root>` and `</ajax_response_xml_root>`.

- [ ] **Step 1: Write the failing helper tests**

Create `test/unit/test_router_firewall_hook.py`:
```python
"""Tests for the ZTE router firewall hook."""
import hashlib
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

from pydantic import BaseModel, SecretStr

import pytest

from tether_ddns.hooks.base import HookEvent
from tether_ddns.hooks.registered_hooks.router_firewall import (
    RouterFirewallHook,
    _family_of,
    _login_hash,
    _parse_login_salt,
    _parse_session_token,
    _protocol_number,
)


def test_login_hash_matches_sha256_of_password_plus_salt() -> None:
    """The login hash is sha256(password + salt) in hex."""
    expected = hashlib.sha256(('pw' + 'SALT1234').encode()).hexdigest()
    assert _login_hash('pw', 'SALT1234') == expected


def test_protocol_number_mapping() -> None:
    """Protocol names map to the router's numeric codes."""
    assert _protocol_number('any') == -1
    assert _protocol_number('tcp') == 6
    assert _protocol_number('udp') == 17
    assert _protocol_number('icmpv6') == 58
    assert _protocol_number('tcp_udp') == 256


def test_family_of() -> None:
    """IPv6 addresses contain a colon; IPv4 do not."""
    assert _family_of('2001:db8::1') == 'ipv6'
    assert _family_of('203.0.113.4') == 'ipv4'


def test_parse_session_token() -> None:
    """The hidden _sessionTOKEN value is extracted from page HTML."""
    html = '<input type="hidden" id="_sessionTOKEN" value="ABC123token" />'
    assert _parse_session_token(html) == 'ABC123token'
    assert _parse_session_token('<html>no token</html>') is None


def test_parse_login_salt() -> None:
    """The login salt is extracted from the ajax XML response."""
    xml = '<ajax_response_xml_root>RqMbcSnG</ajax_response_xml_root>'
    assert _parse_login_salt(xml) == 'RqMbcSnG'
    assert _parse_login_salt('nope') is None
```

- [ ] **Step 2: Run to verify it fails**

Run: `python -m pytest test/unit/test_router_firewall_hook.py -v`
Expected: FAIL (module not found).

- [ ] **Step 3: Write the config + helpers**

Create `tether_ddns/hooks/registered_hooks/router_firewall.py`:
```python
"""Hook that updates a ZTE F6600P firewall IP-filter rule on IP change."""
from __future__ import annotations

import hashlib
import re
from typing import Literal

from pydantic import BaseModel, SecretStr

_PROTOCOL_NUMBERS = {
    'any': -1, 'tcp': 6, 'udp': 17, 'icmpv6': 58, 'tcp_udp': 256,
}
_SESSION_TOKEN_RE = re.compile(
    r'id=["\']_sessionTOKEN["\'][^>]*value=["\']([^"\']+)["\']')
_SALT_RE = re.compile(
    r'<ajax_response_xml_root>([^<]*)</ajax_response_xml_root>')


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


def _login_hash(password: str, salt: str) -> str:
    """Return the router login hash: sha256(password + salt) in hex."""
    return hashlib.sha256((password + salt).encode()).hexdigest()


def _protocol_number(protocol: str) -> int:
    """Map a protocol name to the router's numeric protocol code."""
    return _PROTOCOL_NUMBERS.get(protocol, -1)


def _family_of(ip: str) -> str:
    """Return 'ipv6' if the address contains a colon, else 'ipv4'."""
    return 'ipv6' if ':' in ip else 'ipv4'


def _parse_session_token(html: str) -> str | None:
    """Extract the hidden _sessionTOKEN value from page HTML."""
    match = _SESSION_TOKEN_RE.search(html)
    return match.group(1) if match else None


def _parse_login_salt(xml: str) -> str | None:
    """Extract the login salt from the ajax XML response."""
    match = _SALT_RE.search(xml)
    return match.group(1).strip() if match and match.group(1).strip() else None
```

- [ ] **Step 4: Run to verify it passes**

Run: `python -m pytest test/unit/test_router_firewall_hook.py -v` → the 5 helper tests PASS (the hook-import in the test file will fail until Task 2 adds `RouterFirewallHook`; for THIS task, temporarily import only the helpers, OR add the hook class in Task 2 before running the whole file. Recommended: implement Task 2 in the same session and run the file once at the end of Task 2.)

Practical approach: keep the test file's import of `RouterFirewallHook` and implement Task 2 immediately; run the full file at Task 2 Step 4. If you want a green checkpoint now, comment the `RouterFirewallHook` import and the hook tests, run the 5 helper tests, then restore in Task 2.

Lint the file: `ruff check`, `flake8`, `mypy tether_ddns/hooks/registered_hooks/router_firewall.py`, `pyright tether_ddns/hooks/registered_hooks/router_firewall.py`.

- [ ] **Step 5: Commit** (after Task 2 if you kept the combined import)

```bash
git add tether_ddns/hooks/registered_hooks/router_firewall.py test/unit/test_router_firewall_hook.py
git commit -m "feat: router firewall hook config and pure helpers"
```

---

## Task 2: RouterFirewallHook (HTTP flow)

**Files:**
- Modify: `tether_ddns/hooks/registered_hooks/router_firewall.py` (add the hook class)
- Test: `test/unit/test_router_firewall_hook.py` (add flow tests)

**Interfaces:**
- `@register_hook class RouterFirewallHook(Hook)`: `key = 'router_firewall'`, `display_name = 'Router Firewall (ZTE)'`, `ConfigModel = RouterFirewallConfig`, `async def handle(self, event, config) -> None`.
- Helper `def _parse_rule_index(html: str, rule_name: str) -> str | None` — find the `FilterIndex`/instance for the named rule from the ipfilter page. Because the exact page markup varies, implement a tolerant parse: look for the rule name and the nearest `FilterIndex`/`_InstID` value; default to `'1'` when the page clearly has a single rule matching the name. Keep it small and covered by a test with a representative HTML fragment.
- Helper `def _build_apply_payload(config, index, ip) -> dict[str, str]` — assemble the form fields per the spec (with `DestIP`/`DMask`/`DestIPMask` from `ip`/`dest_prefix`, `Protocol`/`hiddenProtocol` from `_protocol_number`, `FilterTarget` 1/0, ports, views, `IF_ACTION=Apply`, `_InstID`, `Enable=1`, `DSCP=-1`, `Btn_apply_IPFilter=''`). The `_sessionTOKEN` is added by `handle` from the fetched page.

- [ ] **Step 1: Write the failing flow tests**

Add to `test/unit/test_router_firewall_hook.py`. Build a fake session whose `get`/`post` return async context managers with `.text()` (for HTML/XML) and accept `data=`/`params=`. Script the sequence: GET `/` (login HTML with token) → GET login_token (salt XML) → POST login_entry → GET ipfilter page (HTML with token + rule) → POST apply → POST logout.
```python
def _cfg(**over: Any) -> BaseModel:
    base: dict[str, Any] = dict(
        username='admin', password=SecretStr('secret'), ip_version='ipv6')
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
        _text_cm(_LOGIN_HTML),      # GET /
        _text_cm(_SALT_XML),        # GET login_token
        _text_cm(_IPFILTER_HTML),   # GET ipfilter page
    ])
    session.post = MagicMock(side_effect=[
        _text_cm('{"sess_token": "APPLYTOKEN2"}'),   # POST login_entry
        _text_cm('IF_ERRORID=0'),                    # POST apply (success marker)
        _text_cm('{}'),                              # POST logout
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
    # login password = sha256(password + salt)
    login_call = session.post.call_args_list[0]
    assert login_call.kwargs['data']['Password'] == _login_hash('secret', 'SALT1234')
    # apply payload carries the new dest IP and fresh token
    apply_call = session.post.call_args_list[1]
    payload = apply_call.kwargs['data']
    assert payload['DestIP'] == '2001:db8::9'
    assert payload['DestIPMask'] == '2001:db8::9/128'
    assert payload['_sessionTOKEN'] == 'APPLYTOKEN2'
    assert payload['IF_ACTION'] == 'Apply'


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
async def test_handle_rule_not_found_does_not_apply() -> None:
    """When the named rule is absent, no apply POST is sent."""
    session = MagicMock()
    session.get = MagicMock(side_effect=[
        _text_cm(_LOGIN_HTML),
        _text_cm(_SALT_XML),
        _text_cm('<input id="_sessionTOKEN" value="APPLYTOKEN2" />no rules here'),
    ])
    session.post = MagicMock(side_effect=[
        _text_cm('{"sess_token": "APPLYTOKEN2"}'),   # login
        _text_cm('{}'),                              # logout
    ])
    cs = _patch_session(session)
    try:
        await RouterFirewallHook().handle(
            HookEvent(type='ip_changed', old=None, new='2001:db8::9'),
            _cfg(rule_name='Wireguard'))
    finally:
        cs.stop()
    # only login + logout posted; no apply
    assert session.post.call_count == 2
```
(Adapt the success marker `IF_ERRORID=0` and the rule-parse fragment to whatever `_parse_rule_index` / the success check actually look for — keep the test and the implementation consistent. The key assertions are: login hash correctness, DestIP/DestIPMask/token in the apply payload, family-mismatch no-op, and rule-not-found no-apply.)

- [ ] **Step 2: Run to verify it fails**

Run: `python -m pytest test/unit/test_router_firewall_hook.py -v`
Expected: FAIL (hook class / helpers not present).

- [ ] **Step 3: Implement the hook**

Append to `tether_ddns/hooks/registered_hooks/router_firewall.py` (add imports `aiohttp`, and from base `Hook`, `HookEvent`, `register_hook`; add `get_logger`):
```python
import aiohttp

from tether_ddns.hooks.base import Hook, HookEvent, register_hook
from tether_ddns.logging_setup import get_logger

_log = get_logger()

_FILTER_TARGETS = {'allow': '1', 'drop': '0'}
_IP_VERSIONS = {'ipv4': '4', 'ipv6': '6'}
_INST_ID = 'DEV.FW.CHAIN1.IPF1'


def _parse_rule_index(html: str, rule_name: str) -> str | None:
    """Return the FilterIndex for the named rule, or None if absent."""
    if rule_name not in html:
        return None
    match = re.search(r'FilterIndex[=\"\'>: ]+(\d+)', html)
    return match.group(1) if match else '1'


def _build_apply_payload(
    config: RouterFirewallConfig, index: str, ip: str,
) -> dict[str, str]:
    """Assemble the IP-filter Apply form payload with the new destination IP."""
    proto = str(_protocol_number(config.protocol))
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
        if _family_of(ip) != config.ip_version:
            return
        base = config.router_url.rstrip('/')
        connector = aiohttp.TCPConnector(ssl=config.verify_tls)
        async with aiohttp.ClientSession(connector=connector) as session:
            async with session.get(f'{base}/') as resp:
                login_token = _parse_session_token(await resp.text())
            async with session.get(
                    f'{base}/?_type=loginData&_tag=login_token') as resp:
                salt = _parse_login_salt(await resp.text())
            if not login_token or not salt:
                _log.warning('Router firewall: could not obtain login token/salt')
                return
            login_data = {
                'action': 'login',
                'Username': config.username,
                'Password': _login_hash(config.password.get_secret_value(), salt),
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
            apply_token = _parse_session_token(page)
            index = _parse_rule_index(page, config.rule_name)
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
            _log.info('Router firewall: applied %s -> %s', config.rule_name, ip)
            if 'IF_ERRORID=0' not in result and 'success' not in result.lower():
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
```
Notes: keep `_build_apply_payload`/`_parse_rule_index` covered. The success check for the apply is tolerant (`IF_ERRORID=0` or `success`); align the test's apply-response marker with whatever you check.

- [ ] **Step 4: Run to verify it passes**

Run: `python -m pytest test/unit/test_router_firewall_hook.py -v` → all PASS.
Then: `python -m pytest test/ -q` → all pass, coverage ≥ 90.
Lint: `ruff check`, `flake8`, `mypy tether_ddns/hooks/registered_hooks/router_firewall.py`, `pyright tether_ddns/hooks/registered_hooks/router_firewall.py`. Fix violations. (For the untyped aiohttp connector `ssl=` bool, keep it as-is; if pyright flags anything, scope a narrow ignore.)

- [ ] **Step 5: Commit**

```bash
git add tether_ddns/hooks/registered_hooks/router_firewall.py test/unit/test_router_firewall_hook.py
git commit -m "feat: ZTE router firewall hook updates IP-filter rule on IP change"
```

---

## Task 3: Verify registration + gates

**Files:** none new.

- [ ] **Step 1: Confirm auto-registration**

Run: `python -c "from tether_ddns.hooks.base import load_hooks, HOOK_REGISTRY; load_hooks(); print('router_firewall' in HOOK_REGISTRY)"` → `True`.
It will appear in `GET /api/hooks` with its schema (no code change).

- [ ] **Step 2: Full gate**

Run: `source .venv/bin/activate && pytest test/ -q` → all pass, coverage ≥ 90, flake8/mypy/pyright/ruff linter tests green.

- [ ] **Step 3: (Optional) UI smoke**

Build the frontend and confirm the hook appears in the Add Hook modal with its schema-rendered form (password field masked). No code change expected.

---

## Self-Review Notes

- **Spec coverage:** config model with all fields (T1), login hash sha256(pw+salt), protocol/family/token/salt parsing (T1), full login→fetch→apply→logout flow with DestIP tracking + family gating + rule-not-found handling (T2), registration + gates (T3). All spec points mapped.
- **Type consistency:** `RouterFirewallConfig`, `_login_hash`, `_protocol_number`, `_family_of`, `_parse_session_token`, `_parse_login_salt`, `_parse_rule_index`, `_build_apply_payload` used consistently; `handle()` matches the `Hook` signature (`event: HookEvent, config: BaseModel`).
- **Secret safety:** password only feeds `_login_hash` via `get_secret_value()`; never logged. TLS off by default with `verify_tls`, scoped to the connector, commented.
- **Placeholders:** none — full config, helpers, hook, and tests provided. The implementer is directed to keep the apply success marker and rule-parse fragment consistent between test and code.
- **Live verification:** real-router correctness is a separate manual pass (needs credentials); unit tests fully mock the HTTP flow.
