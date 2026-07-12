# Error Reporting Standardization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make entity failures visible in the UI log and standardize error handling on "success returns data, failure raises", with the scheduler/detect layer catching all exceptions and logging a clear message.

**Architecture:** The log ring buffer folds exception detail into each record's message so the UI shows the cause. A shared `TetherError` marks expected, operator-facing failures. DNS providers return the assigned IP (`str`) and raise on failure (drop `UpdateResult`); IP sources return `str` and raise (the caller downgrades detection failures to DEBUG + `None`); the router-firewall hook raises instead of silently returning `None`. Catch sites use broad `except Exception` and always log.

**Tech Stack:** Python 3, Pydantic v2, aiohttp, pytest, pytest-asyncio.

## Global Constraints

- New exception: `tether_ddns/errors.py` → `class TetherError(Exception)`. Catch sites use broad `except Exception` (NOT filtered to `TetherError`) and always log the message.
- Providers: `update(...) -> str` (assigned IP) on success; raise on failure. `UpdateResult` is removed from `tether_ddns/providers/base.py`.
- IP sources: `detect(family) -> str` on success; raise on failure. `detect_public_ip` catches, logs at DEBUG, returns `None`.
- Router-firewall hook: raise `TetherError` on real failures; keep the family-mismatch guard a silent `return`; run `_logout` in a `finally`.
- Ring buffer: append exception `type + message` (one line) to the record message when `exc_info` is present; stdout keeps full traceback; no frontend change.
- Python style: `from __future__ import annotations`, single-quoted strings, existing noqa conventions.
- Run `pytest test/unit -q` before each commit.

---

### Task 1: `TetherError` and ring-buffer visibility

**Files:**
- Create: `tether_ddns/errors.py`
- Modify: `tether_ddns/logging_setup.py`
- Test: `test/unit/test_logging_setup.py`

**Interfaces:**
- Produces: `tether_ddns.errors.TetherError`; `LogRingHandler.emit` now includes exception detail in the stored message.

- [ ] **Step 1: Write the failing test**

Append to `test/unit/test_logging_setup.py`:
```python
def test_ring_handler_includes_exception_detail() -> None:
    """A record logged with exc_info stores the exception type and message."""
    import logging
    from tether_ddns.logging_setup import LogRingHandler

    handler = LogRingHandler()
    logger = logging.getLogger('tether_ddns.test.exc')
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)
    try:
        raise ValueError('kaboom')
    except ValueError:
        logger.exception('operation failed')
    logger.removeHandler(handler)
    messages = [r['message'] for r in handler.snapshot()]
    assert any(
        'operation failed' in m and 'ValueError' in m and 'kaboom' in m
        for m in messages)
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pytest test/unit/test_logging_setup.py::test_ring_handler_includes_exception_detail -v`
Expected: FAIL (message is just 'operation failed').

- [ ] **Step 3: Create `tether_ddns/errors.py`**

```python
"""Shared error types."""
from __future__ import annotations


class TetherError(Exception):
    """An expected, operator-facing failure with a clean message."""
```

- [ ] **Step 4: Update `LogRingHandler.emit` in `tether_ddns/logging_setup.py`**

Replace the body of `emit` that builds `entry`:
```python
    def emit(self, record: logging.LogRecord) -> None:
        """Store the record and notify listeners (never raises)."""
        try:
            entry: LogRecordDict = {
                'time': record.created,
                'level': record.levelname,
                'logger': record.name,
                'message': record.getMessage(),
            }
            self.records.append(entry)
            for cb in list(self._listeners):
                cb(entry)
        except Exception:  # noqa: BLE001 - logging must not raise
            self.handleError(record)
```
with:
```python
    def emit(self, record: logging.LogRecord) -> None:
        """Store the record and notify listeners (never raises)."""
        try:
            message = record.getMessage()
            if record.exc_info and record.exc_info[1] is not None:
                exc = record.exc_info[1]
                message = f'{message}: {type(exc).__name__}: {exc}'
            entry: LogRecordDict = {
                'time': record.created,
                'level': record.levelname,
                'logger': record.name,
                'message': message,
            }
            self.records.append(entry)
            for cb in list(self._listeners):
                cb(entry)
        except Exception:  # noqa: BLE001 - logging must not raise
            self.handleError(record)
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pytest test/unit/test_logging_setup.py -q`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add tether_ddns/errors.py tether_ddns/logging_setup.py test/unit/test_logging_setup.py
git commit -m "feat(logging): surface exception detail in the log ring buffer"
```

---

### Task 2: Provider contract (return IP, raise on failure)

**Files:**
- Modify: `tether_ddns/providers/base.py`, `tether_ddns/providers/ddns_providers/duckdns.py`, `tether_ddns/providers/ddns_providers/cloudflare.py`, `tether_ddns/scheduler.py`
- Test: `test/unit/test_duckdns.py`, `test/unit/test_cloudflare.py`, `test/unit/test_provider_registry.py`, `test/unit/test_scheduler.py`, `test/unit/test_api.py`

**Interfaces:**
- Consumes: `TetherError` (Task 1).
- Produces: `DDNSProvider.update(...) -> str`; `UpdateResult` removed; `sync_domain` unchanged signature (`-> Status`) but reads a returned IP string.

- [ ] **Step 1: Update the provider tests to the new contract**

In `test/unit/test_duckdns.py`, replace the two assertions:
```python
    assert result.success is True
    assert result.ip == '1.2.3.4'
```
with:
```python
    assert result == '1.2.3.4'
```
and replace `test_update_failure` so a `'KO'` body raises:
```python
@pytest.mark.asyncio
async def test_update_failure() -> None:
    """A non-OK body raises a TetherError."""
    from tether_ddns.errors import TetherError
    provider = DuckDNSProvider()
    resp = MagicMock()
    resp.text = AsyncMock(return_value='KO')
    session = MagicMock()
    session.get.return_value.__aenter__ = AsyncMock(return_value=resp)
    session.get.return_value.__aexit__ = AsyncMock(return_value=False)
    with patch('tether_ddns.providers.ddns_providers.duckdns.aiohttp.ClientSession') as cs:
        cs.return_value.__aenter__ = AsyncMock(return_value=session)
        cs.return_value.__aexit__ = AsyncMock(return_value=False)
        with pytest.raises(TetherError):
            await provider.update('myhost', 'A', '1.2.3.4', _cfg())
```

In `test/unit/test_provider_registry.py`, change both stub providers' return type and body from `-> base.UpdateResult` / `return base.UpdateResult(success=True, ip=ip)` to `-> str` / `return ip`.

In `test/unit/test_cloudflare.py`, update each success assertion to expect the returned IP string and each failure case to `pytest.raises(TetherError)`. (Read the file first; mirror the existing structure — success returns `ip`, and the no-zone / record-not-found / update-failed branches raise.)

- [ ] **Step 2: Run the provider tests to verify they fail**

Run: `pytest test/unit/test_duckdns.py test/unit/test_cloudflare.py test/unit/test_provider_registry.py -q`
Expected: FAIL (`update` still returns `UpdateResult`).

- [ ] **Step 3: Update `tether_ddns/providers/base.py`**

Remove the `UpdateResult` class and change the abstract method:
```python
class UpdateResult(BaseModel):
    """Outcome of a provider update attempt."""

    success: bool
    ip: str | None = None
    message: str = ''
```
Delete that class. Change:
```python
    @abstractmethod
    async def update(
        self, hostname: str, record_type: str, ip: str, config: BaseModel,
    ) -> UpdateResult:
        """Update the DNS record and return the result."""
```
to:
```python
    @abstractmethod
    async def update(
        self, hostname: str, record_type: str, ip: str, config: BaseModel,
    ) -> str:
        """Update the DNS record and return the assigned IP; raise on failure."""
```

- [ ] **Step 4: Update `duckdns.py`**

Replace the import `UpdateResult,` with nothing (remove that line from the `from tether_ddns.providers.base import (...)` group) and add `from tether_ddns.errors import TetherError`. Change the return:
```python
        async with aiohttp.ClientSession() as session:
            async with session.get(url, params=params) as resp:
                body = (await resp.text()).strip()
        return UpdateResult(success=body == 'OK', ip=ip, message=body)
```
to:
```python
        async with aiohttp.ClientSession() as session:
            async with session.get(url, params=params) as resp:
                body = (await resp.text()).strip()
        if body != 'OK':
            raise TetherError(f'DuckDNS returned {body}')
        return ip
```
Change the method signature `-> UpdateResult:` to `-> str:`.

- [ ] **Step 5: Update `cloudflare.py`**

Remove `UpdateResult,` from the base import; add `from tether_ddns.errors import TetherError`. Change `update`'s return type to `-> str`. Replace each failure return and the success return:
```python
            if zone is None:
                return UpdateResult(
                    success=False, ip=ip,
                    message=f'no matching Cloudflare zone for {hostname}')
```
→ `raise TetherError(f'no matching Cloudflare zone for {hostname}')`
```python
            if not records:
                return UpdateResult(
                    success=False, ip=ip,
                    message=f'record {hostname} ({record_type}) not found')
```
→ `raise TetherError(f'record {hostname} ({record_type}) not found')`
```python
        if _is_success(payload):
            return UpdateResult(success=True, ip=ip, message='updated')
        errors = _error_messages(payload)
        return UpdateResult(
            success=False, ip=ip, message=errors or 'Cloudflare update failed')
```
→
```python
        if _is_success(payload):
            return ip
        errors = _error_messages(payload)
        raise TetherError(errors or 'Cloudflare update failed')
```

- [ ] **Step 6: Update `sync_domain` in `scheduler.py`**

Replace:
```python
    state.set_status(domain.id, 'updating')
    try:
        config = provider_cls.ConfigModel.model_validate(domain.provider_config)
        result = await provider_cls().update(domain.hostname, domain.record_type, ip, config)
    except Exception as exc:  # noqa: BLE001 - provider errors must be contained
        _log.exception('Provider %s failed for %s', domain.provider, domain.hostname)
        state.set_status(domain.id, 'error', message=str(exc))
        return 'error'
    if result.success:
        state.set_status(domain.id, 'synced', ip=result.ip or ip, message=result.message)
        return 'synced'
    state.set_status(domain.id, 'error', message=result.message)
    return 'error'
```
with:
```python
    state.set_status(domain.id, 'updating')
    try:
        config = provider_cls.ConfigModel.model_validate(domain.provider_config)
        assigned = await provider_cls().update(
            domain.hostname, domain.record_type, ip, config)
    except Exception as exc:  # noqa: BLE001 - provider errors must be contained
        _log.exception('Provider %s failed for %s', domain.provider, domain.hostname)
        state.set_status(domain.id, 'error', message=str(exc))
        return 'error'
    state.set_status(domain.id, 'synced', ip=assigned or ip, message='')
    return 'synced'
```

- [ ] **Step 7: Update the scheduler and api test mocks**

In `test/unit/test_scheduler.py`, replace the `_ok_result` helper:
```python
def _ok_result(ip: str) -> object:
    from tether_ddns.providers.base import UpdateResult
    return UpdateResult(success=True, ip=ip, message='ok')
```
with:
```python
def _ok_result(ip: str) -> str:
    return ip
```
and change every `AsyncMock(return_value=UpdateResult(success=True, ip='...'))` in that file to `AsyncMock(return_value='...')` (the same IP string); remove the now-unused `from tether_ddns.providers.base import UpdateResult` lines.

In `test/unit/test_api.py`, remove `from tether_ddns.providers.base import UpdateResult`, and change each `AsyncMock(return_value=UpdateResult(success=True, ip='<ip>'))` to `AsyncMock(return_value='<ip>')`.

- [ ] **Step 8: Run the full unit suite**

Run: `pytest test/unit -q`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add tether_ddns/providers test/unit/test_duckdns.py test/unit/test_cloudflare.py test/unit/test_provider_registry.py test/unit/test_scheduler.py test/unit/test_api.py tether_ddns/scheduler.py
git commit -m "refactor(providers): update() returns assigned IP and raises on failure"
```

---

### Task 3: IP sources raise; caller downgrades to DEBUG

**Files:**
- Modify: `tether_ddns/ip_sources/base.py`, `tether_ddns/ip_sources/registered_sources/http_sources.py`
- Test: `test/unit/test_ip_sources.py`

**Interfaces:**
- Consumes: nothing new.
- Produces: `IPSource.detect(family) -> str`; `_fetch` raises on HTTP error; `detect_public_ip` logs at DEBUG and returns `None` on failure.

- [ ] **Step 1: Update/add tests**

Read `test/unit/test_ip_sources.py` first. Update it so:
- a source whose `detect` succeeds returns the IP through `detect_public_ip`;
- a source whose `detect` raises causes `detect_public_ip` to return `None` and log at DEBUG. Add:
```python
@pytest.mark.asyncio
async def test_detect_public_ip_returns_none_and_logs_debug_on_error(caplog) -> None:
    """A raising source yields None and a DEBUG log, not an error."""
    import logging
    from tether_ddns.ip_sources import base

    @base.register_ip_source
    class _Boom(base.IPSource):
        key = '_boom'
        display_name = 'Boom'

        async def detect(self, family: base.IPFamily) -> str:
            raise RuntimeError('no route')

    try:
        with caplog.at_level(logging.DEBUG, logger='tether_ddns'):
            result = await base.detect_public_ip('_boom', 'ipv6')
        assert result is None
        assert any(r.levelno == logging.DEBUG for r in caplog.records)
    finally:
        base.IP_SOURCE_REGISTRY.pop('_boom', None)
```
Adjust any existing test that returned `None` from a stub `detect` to instead raise (since `detect` now returns `str`).

- [ ] **Step 2: Run to verify the new test fails**

Run: `pytest test/unit/test_ip_sources.py -q`
Expected: FAIL (`detect_public_ip` currently logs at `exception`/`warning`, not DEBUG; or the stub signature mismatch).

- [ ] **Step 3: Update `ip_sources/base.py`**

Change the abstract method return type:
```python
    @abstractmethod
    async def detect(self, family: 'IPFamily') -> str | None:
        """Return the detected public IP for the family, or None on failure."""
        raise NotImplementedError
```
to:
```python
    @abstractmethod
    async def detect(self, family: 'IPFamily') -> str:
        """Return the detected public IP for the family; raise on failure."""
        raise NotImplementedError
```
Change `detect_public_ip`'s except branch:
```python
    try:
        return await cls().detect(family)
    except Exception:  # noqa: BLE001 - detection failure must not raise
        _log.exception('IP source %s failed for %s', source_key, family)
        return None
```
to:
```python
    try:
        return await cls().detect(family)
    except Exception:  # noqa: BLE001 - detection failure must not raise
        _log.debug(
            'IP source %s failed for %s', source_key, family, exc_info=True)
        return None
```

- [ ] **Step 4: Update `http_sources.py`**

Make `_fetch` raise on HTTP error:
```python
async def _fetch(url: str) -> str | None:
    async with aiohttp.ClientSession() as session:
        async with session.get(url) as resp:
            return (await resp.text()).strip()
```
→
```python
async def _fetch(url: str) -> str:
    async with aiohttp.ClientSession() as session:
        async with session.get(url) as resp:
            resp.raise_for_status()
            return (await resp.text()).strip()
```
Change both `detect` methods' return annotations from `-> str | None:` to `-> str:`.

- [ ] **Step 5: Run the full unit suite**

Run: `pytest test/unit -q`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add tether_ddns/ip_sources test/unit/test_ip_sources.py
git commit -m "refactor(ip-sources): detect() raises; caller logs at DEBUG"
```

---

### Task 4: Router-firewall hook raises on failure

**Files:**
- Modify: `tether_ddns/hooks/registered_hooks/router_firewall.py`
- Test: `test/unit/test_router_firewall_hook.py`

**Interfaces:**
- Consumes: `TetherError` (Task 1).
- Produces: `_login -> tuple[int, int]`, `_prepare_ipfilter -> str`, `_apply` raises on failure; `on_ip_changed` runs `_logout` in `finally`.

- [ ] **Step 1: Update the failing tests**

In `test/unit/test_router_firewall_hook.py`, add `from tether_ddns.errors import TetherError`. Change `test_handle_rule_not_found_does_not_apply` and `test_handle_aborts_without_salt` to expect a raise and still-performed logout. For the rule-not-found case:
```python
@pytest.mark.asyncio
async def test_handle_rule_not_found_raises() -> None:
    """When the named rule is absent, the hook raises and still logs out."""
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
        with pytest.raises(TetherError):
            await RouterFirewallHook().on_ip_changed(
                IpChangedEvent(new_ip='2001:db8::9', family='ipv6'),
                _cfg(rule_name='Wireguard'))
    finally:
        cs.stop()
    # login (1) + logout (1) POSTs; no apply POST.
    assert session.post.call_count == 2
```
For the aborts-without-salt case, wrap the call in `with pytest.raises(TetherError):` and keep `session.post.assert_not_called()`.

(Read the current bodies first to preserve the exact mock sequencing; only the assertions/`raises` wrapper change.)

- [ ] **Step 2: Run to verify failure**

Run: `pytest test/unit/test_router_firewall_hook.py -q`
Expected: FAIL (hook currently returns None instead of raising).

- [ ] **Step 3: Update `router_firewall.py`**

Add `from tether_ddns.errors import TetherError` (below the `hooks.base` import).

Rewrite `on_ip_changed`'s session block:
```python
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
```
→
```python
        async with aiohttp.ClientSession(
                connector=connector, cookie_jar=jar) as session:
            public_key = await self._login(session, base, headers, config)
            try:
                token = await self._prepare_ipfilter(
                    session, base, headers, config)
                await self._apply(
                    session, base, headers, config, ip, token, public_key)
            finally:
                await self._logout(session, base, headers)
```

`_login`: change return type to `-> tuple[int, int]:` and replace the two guards:
```python
        if public_key is None:
            _log.warning('Router firewall: could not obtain public key')
            return None
```
→
```python
        if public_key is None:
            raise TetherError('Router firewall: could not obtain public key')
```
```python
        if not salt:
            _log.warning('Router firewall: could not obtain login salt')
            return None
```
→
```python
        if not salt:
            raise TetherError('Router firewall: could not obtain login salt')
```
and change the docstring to "Log in and return the router's RSA public key; raise on failure."

`_prepare_ipfilter`: change return type to `-> str:` and:
```python
        if token is None or not parse_rule_present(data, config.rule_name):
            _log.warning(
                'Router firewall: rule %s or token not found', config.rule_name)
            return None
        return token
```
→
```python
        if token is None or not parse_rule_present(data, config.rule_name):
            raise TetherError(
                f'Router firewall: rule {config.rule_name} or token not found')
        return token
```

`_apply`: replace the tail:
```python
        if status == 200 and 'SessionTimeout' not in result:
            _log.info('Router firewall: applied %s -> %s', config.rule_name, ip)
        else:
            _log.warning(
                'Router firewall: apply failed (%s): %s', status, result[:200])
```
→
```python
        if status == 200 and 'SessionTimeout' not in result:
            _log.info('Router firewall: applied %s -> %s', config.rule_name, ip)
            return
        raise TetherError(
            f'Router firewall: apply failed ({status}): {result[:200]}')
```

- [ ] **Step 4: Run the full unit suite**

Run: `pytest test/unit -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tether_ddns/hooks/registered_hooks/router_firewall.py test/unit/test_router_firewall_hook.py
git commit -m "refactor(router-firewall): raise TetherError on failures; logout in finally"
```

---

### Task 5: README and static checks

**Files:**
- Modify: `README.md`
- Verify: `tether_ddns/`, `test/`.

- [ ] **Step 1: Update the README "Add a provider" / plugin-authoring guidance**

Read the README's "Extending: providers, hooks, and IP sources" section. Update the provider and IP-source examples to the new contracts:
- Provider `update()` returns the assigned IP (`str`) and raises on failure (show `raise TetherError('...')`), instead of returning `UpdateResult`.
- IP source `detect()` returns the IP (`str`) and raises on failure.
- Add a short sentence noting that entities should raise `tether_ddns.errors.TetherError` (or any exception) on failure; the scheduler/detect layer logs the message, now visible in the in-app log viewer.

(Match the file's existing example style; replace the `UpdateResult` usage in the provider snippet with a returned string + raise.)

- [ ] **Step 2: Run the lint/type gate**

Run: `pytest test/test_ruff.py test/test_mypy.py test/test_pyright.py test/test_flake8.py -q`
Expected: PASS. Fix any findings inline (e.g. an unused `BaseModel` import in `providers/base.py` if `UpdateResult` removal leaves it unused — check before removing) and re-run.

- [ ] **Step 3: Run the full suite once more**

Run: `pytest test/unit -q`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "docs: document raise-on-failure entity contracts"
```

---

## Self-Review

- **Spec coverage:** ring-buffer visibility + `TetherError` (Task 1) ✓; provider contract + `sync_domain` + all `UpdateResult` test call sites (Task 2) ✓; IP sources raise + DEBUG downgrade (Task 3) ✓; router-firewall raises + logout-in-finally (Task 4) ✓; README + lint gate (Task 5) ✓.
- **Placeholder scan:** code steps show complete code; the two "read the file first" notes (cloudflare test, router-firewall test bodies) are for preserving exact mock sequencing, with the concrete change spelled out.
- **Type consistency:** `update(...) -> str`, `detect(...) -> str`, `_login -> tuple[int, int]`, `_prepare_ipfilter -> str`, `TetherError`, `sync_domain -> Status` used consistently across tasks.
