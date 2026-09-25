"""Tests for the heartbeat service."""
import logging
from unittest.mock import AsyncMock, MagicMock, patch

import aiohttp

import pytest

from tether_ddns.config_store import AppConfig
from tether_ddns.context import AppContext
from tether_ddns.runtime import RuntimeState
from tether_ddns.services.heartbeat import HeartbeatService

URL = 'https://hc-ping.com/5b1c7f0a'


def _service(
    url: str | None = URL, online: bool = True,
) -> tuple[HeartbeatService, RuntimeState]:
    """Build a service over a config with the given URL and link state."""
    cfg = AppConfig.model_validate({'settings': {'heartbeat_url': url}})
    state = RuntimeState()
    state.online = online
    ctx = AppContext(cfg, state, MagicMock(), MagicMock(), MagicMock(), MagicMock())
    return HeartbeatService(ctx), state


def _session(resp: MagicMock) -> MagicMock:
    """Build a ClientSession double whose GET yields resp."""
    session = MagicMock()
    session.get.return_value.__aenter__ = AsyncMock(return_value=resp)
    session.get.return_value.__aexit__ = AsyncMock(return_value=False)
    return session


@pytest.mark.asyncio
async def test_run_without_url_does_nothing() -> None:
    """With no URL configured, run sends nothing and records nothing."""
    service, state = _service(url=None)
    with patch.object(service, '_ping', new=AsyncMock()) as ping:
        assert await service.run() is None
    ping.assert_not_awaited()
    assert state.heartbeat is None


@pytest.mark.asyncio
async def test_run_offline_is_skipped() -> None:
    """A scheduled run while offline records a skip and sends nothing."""
    service, state = _service(online=False)
    with patch.object(service, '_ping', new=AsyncMock()) as ping:
        status = await service.run()
    ping.assert_not_awaited()
    assert status is not None
    assert status.skipped is True and status.ok is False and status.error is None
    assert state.heartbeat == status


@pytest.mark.asyncio
async def test_forced_run_ignores_offline() -> None:
    """A forced run pings even while offline."""
    service, _ = _service(online=False)
    with patch.object(service, '_ping', new=AsyncMock()) as ping:
        status = await service.run(force=True)
    ping.assert_awaited_once_with(URL)
    assert status is not None and status.ok is True and status.skipped is False


@pytest.mark.asyncio
async def test_success_is_recorded_and_not_logged(caplog: pytest.LogCaptureFixture) -> None:
    """A successful ping updates state and emits no log records."""
    service, state = _service()
    with caplog.at_level(logging.DEBUG, logger='tether_ddns'):
        with patch.object(service, '_ping', new=AsyncMock()):
            status = await service.run()
    assert status is not None and status.ok is True and status.error is None
    assert state.heartbeat == status
    assert caplog.records == []


@pytest.mark.asyncio
async def test_failure_is_recorded_and_logged_with_traceback(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """An HTTP error is logged once with exc_info and recorded as the message."""
    service, _ = _service()
    error = aiohttp.ClientResponseError(
        MagicMock(), (), status=404, message='Not Found')
    with caplog.at_level(logging.DEBUG, logger='tether_ddns'):
        with patch.object(service, '_ping', new=AsyncMock(side_effect=error)):
            status = await service.run()
    assert status is not None and status.ok is False and status.skipped is False
    assert status.error is not None
    assert status.error.startswith("ClientResponseError: 404, message='Not Found'")
    [record] = caplog.records
    assert record.levelno == logging.ERROR
    assert record.getMessage() == f'Heartbeat to {URL} failed'
    assert record.exc_info is not None


@pytest.mark.asyncio
async def test_timeout_error_is_the_bare_type_name() -> None:
    """A message-less TimeoutError is recorded as just its type name."""
    service, _ = _service()
    with patch.object(service, '_ping', new=AsyncMock(side_effect=TimeoutError())):
        status = await service.run()
    assert status is not None and status.error == 'TimeoutError'


@pytest.mark.asyncio
async def test_ping_gets_the_url_with_a_timeout() -> None:
    """The HTTP layer GETs the URL with a 10 s total timeout and checks status."""
    service, _ = _service()
    resp = MagicMock()
    session = _session(resp)
    with patch('tether_ddns.services.heartbeat.aiohttp.ClientSession') as cs:
        cs.return_value.__aenter__ = AsyncMock(return_value=session)
        cs.return_value.__aexit__ = AsyncMock(return_value=False)
        status = await service.run()
    assert status is not None and status.ok is True
    session.get.assert_called_once_with(URL)
    resp.raise_for_status.assert_called_once_with()
    assert cs.call_args.kwargs['timeout'].total == 10


@pytest.mark.asyncio
async def test_ping_http_error_propagates_to_run() -> None:
    """raise_for_status failures surface as a recorded failure."""
    service, _ = _service()
    resp = MagicMock()
    resp.raise_for_status.side_effect = aiohttp.ClientResponseError(
        MagicMock(), (), status=503, message='Service Unavailable')
    session = _session(resp)
    with patch('tether_ddns.services.heartbeat.aiohttp.ClientSession') as cs:
        cs.return_value.__aenter__ = AsyncMock(return_value=session)
        cs.return_value.__aexit__ = AsyncMock(return_value=False)
        status = await service.run()
    assert status is not None and status.ok is False
    assert status.error is not None and status.error.startswith('ClientResponseError: 503')
