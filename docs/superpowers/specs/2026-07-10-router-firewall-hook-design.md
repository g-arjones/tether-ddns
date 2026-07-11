# Router Firewall Hook (ZTE F6600P) — Design Spec

**Date:** 2026-07-10
**Status:** Approved

## Overview

A hook that updates an IP-filter rule on a ZTE F6600P ISP router when the public IP
changes, so a firewall rule (e.g. the "Wireguard" allow rule) keeps pointing at the
current address. It replicates the router's web-UI requests over raw HTTP (aiohttp),
following the reverse-engineered protocol below. Fires on `ip_changed`. Delivered on
`feat/router-firewall-hook`.

## Reverse-engineered router protocol (confirmed from the live device + HAR)

Base: `https://<router>` (self-signed TLS — the client disables certificate verification).

**Login:**
1. `GET /` → the login HTML embeds a hidden input `#_sessionTOKEN` (24 chars). Scrape it.
2. `GET /?_type=loginData&_tag=login_token` → body
   `<ajax_response_xml_root>SALT</ajax_response_xml_root>` (8-char salt).
3. `POST /?_type=loginData&_tag=login_entry` (form-encoded):
   `action=login`, `Username=<user>`, `Password=sha256(<plaintext_password> + SALT)` (hex),
   `_sessionTOKEN=<token from step 1>`. Response is JSON `{sess_token, login_need_refresh, ...}`
   and sets the session cookie. (No RSA for login; the page's JSEncrypt is used elsewhere.)

**Read current rule + fresh CSRF token:**
4. `GET /?_type=menuData&_tag=firewall_ipfilter_lua.lua` → HTML page listing the IP-filter
   rules and embedding a fresh `_sessionTOKEN` (24 chars) used for the apply POST.

**Apply the rule:**
5. `POST /?_type=menuData&_tag=firewall_ipfilter_lua.lua` (form-encoded) with the full rule
   payload:
   `IF_ACTION=Apply`, `_InstID=DEV.FW.CHAIN1.IPF1`, `FilterIndex=<n>`, `Enable=1`,
   `Name=<rule>`, `FilterTarget=<1 allow|0 drop>`, `IPVersion=<4|6>`,
   `SourceIP`, `SMask`, `SourceIPMask` (=`SourceIP/SMask`),
   **`DestIP`, `DMask`, `DestIPMask` (=`DestIP/DMask`)** ← set to the new public IP,
   `Protocol=<num>`, `hiddenProtocol=<num>`, `MinSrcPort`, `MaxSrcPort`, `MinDstPort`,
   `MaxDstPort`, `INCViewName` (ingress), `OUTCViewName` (egress), `DSCP=-1`,
   `Btn_apply_IPFilter=`, `_sessionTOKEN=<token from step 4>`.

**Logout (best effort):**
6. `POST /?_type=loginData&_tag=logout_entry` with `{IF_LogOff:1, _sessionTOKEN:<token>}`.

**Protocol number mapping:** Any→`-1`, TCP→`6`, UDP→`17`, ICMPv6→`58`, TCP+UDP→`256`
(the UI's "TCP e UDP" value). `INCViewName`/`OUTCViewName` map LAN→`DEV.IP.IF1`,
Internet→`DEV.IP.IF4` (as observed); these are exposed as raw config values with those
defaults so they can be corrected without a code change if a unit differs.

## Hook behavior

`RouterFirewallHook` (key `router_firewall`, auto-loaded), `handle(event, config)`:
1. Only acts on `event.type == 'ip_changed'` (the registry/scheduler already filters by the
   hook's configured events, but guard anyway). The new IP is `event.new`.
2. Infer family from `event.new`: `':' in new` → IPv6 else IPv4. Skip (return) if it does not
   match `config.ip_version` — so an IPv6 rule reacts only to IPv6 changes.
3. Run the protocol: login → fetch ipfilter page → build the Apply payload from config with
   `DestIP`/`DMask`/`DestIPMask` set to the new IP (DMask from `config.dest_prefix`) → POST
   apply → logout.
4. On any non-success response, log a warning with the router's message. Exceptions propagate
   to the existing hook exception isolation (each hook is wrapped; a failure is logged and
   does not affect other hooks). The hook does not need its own broad try/except.

**Rule identification:** the ipfilter page is parsed to find the rule whose `Name` matches
`config.rule_name`, to recover its `FilterIndex`/`_InstID`. If not found, log a warning and
return without applying (do not create a rule).

## Config model (`RouterFirewallConfig`, rendered as the hook form)

- `router_url: str = 'https://192.168.0.1'`
- `username: str`
- `password: SecretStr` (masked/write-only)
- `rule_name: str = 'Wireguard'`
- `ip_version: Literal['ipv4', 'ipv6'] = 'ipv6'`
- `filter_target: Literal['allow', 'drop'] = 'allow'`
- `source_ip: str = '::'`, `source_prefix: int = 0`
- `dest_prefix: int = 128`
- `protocol: Literal['any', 'tcp', 'udp', 'icmpv6', 'tcp_udp'] = 'udp'`
- `min_src_port: int = 1`, `max_src_port: int = 65535`
- `min_dst_port: int = 443`, `max_dst_port: int = 443`
- `ingress_view: str = 'DEV.IP.IF4'`, `egress_view: str = 'DEV.IP.IF1'`
- `verify_tls: bool = False` (router uses a self-signed cert; default off, exposed so a
  user with a proper cert can enable it)

## Security & operational notes

- **TLS verification disabled by default** (self-signed router cert). Scoped to this hook's
  aiohttp connector only, controlled by `verify_tls`, and explicit in code with a comment.
- **Single admin session:** ZTE routers typically allow one admin session, so the hook's
  login may invalidate a browser session (and vice versa). The hook logs out after applying
  to release the session promptly.
- **Secret handling:** `password` is `SecretStr`, masked/write-only via existing hook secret
  handling; the plaintext is only used to compute the SHA-256 login hash and is never logged.
- **Firmware fragility:** this mimics a specific firmware's private web API; a firmware update
  can change field names/tokens. The hook fails safe (logs, no crash) and the raw view/config
  values are exposed so minor differences can be corrected via config.

## Testing

`test/unit/test_router_firewall_hook.py` with mocked aiohttp (a fake session scripted through
GET `/` → GET login_token → POST login → GET ipfilter → POST apply → POST logout):
- happy path: asserts the login `Password` equals `sha256(password + salt)`, and the apply
  payload carries `DestIP`/`DestIPMask` set to the new IP with the configured prefix, correct
  `Protocol`/ports/target/views.
- family gating: an IPv4 `ip_changed` with an `ip_version='ipv6'` config performs no requests.
- rule-not-found: apply is not sent; a warning path is exercised.
- protocol/target/view mapping helpers unit-tested directly.
Keeps strict gates green (flake8, mypy, pyright strict, ruff) and backend coverage ≥ 90.
Correctness against the real router is confirmed in a separate live pass (needs real
credentials; user can rotate afterward).

## Out of scope

- Creating a firewall rule that doesn't exist.
- Updating the Source IP (only Dest IP tracks the public IP, per the current setup).
- Non-ZTE routers / other firmware families (this hook is F6600P-specific).
- Caching the session between IP changes (each change logs in fresh; acceptable cadence).
