"""Tests for Healthchecks polling and manual fetch."""
import logging
from typing import cast
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from tether_ddns.config_store import AppConfig, HealthcheckRef, HealthchecksProject
from tether_ddns.context import AppContext
from tether_ddns.healthchecks import HealthchecksError, RemoteCheck
from tether_ddns.runtime import CheckState, RuntimeState
from tether_ddns.services.healthchecks import HealthchecksService, merge_refs

LIST = 'tether_ddns.services.healthchecks.list_checks'


def _remote(key: str, status: CheckState = 'up', name: str | None = None) -> RemoteCheck:
    """Build an upstream check keyed by key."""
    return RemoteCheck(
        key=key, name=name or key.upper(), slug=key, status=status, last_ping=1.0,
        next_ping=None, timeout=86400, schedule=None, tz=None, grace=3600)


def _ref(key: str, visible: bool = True) -> HealthcheckRef:
    """Build a fetched check reference."""
    return HealthcheckRef(key=key, name=key.upper(), slug=key, visible=visible)


def _setup(
    *refs: HealthcheckRef, online: bool = True,
) -> tuple[HealthchecksService, AppContext, HealthchecksProject]:
    """Build a service over one project whose fetched checks are refs."""
    project = HealthchecksProject(id='p1', name='Homelab', api_key='k', checks=list(refs))
    state = RuntimeState()
    state.online = online
    ctx = AppContext(
        AppConfig(healthchecks=[project]), state, MagicMock(), MagicMock(), MagicMock(),
        MagicMock())
    return HealthchecksService(ctx), ctx, project


def test_merge_refs_keeps_visibility_adds_new_and_drops_removed() -> None:
    """Merging keeps surviving settings, shows new checks and forgets removed ones."""
    merged = merge_refs(
        [_ref('k1', visible=False), _ref('k2')], [_remote('k3'), _remote('k1', name='Renamed')])
    assert merged == [
        HealthcheckRef(key='k3', name='K3', slug='k3', visible=True),
        HealthcheckRef(key='k1', name='Renamed', slug='k1', visible=False),
    ]


@pytest.mark.asyncio
async def test_poll_records_only_fetched_checks() -> None:
    """A poll updates fetched checks and silently ignores unfetched upstream ones."""
    service, ctx, _ = _setup(_ref('k1'), _ref('k2'))
    upstream = [_remote('k1'), _remote('k2', 'down'), _remote('k3')]
    with patch(LIST, new=AsyncMock(return_value=upstream)) as list_checks:
        await service.poll('p1')
    list_checks.assert_awaited_once_with('https://healthchecks.io/', 'k')
    rt = ctx.runtime.healthchecks['p1']
    assert rt.ok is True and rt.error is None and rt.offline is False
    assert rt.polled_at is not None
    assert set(rt.checks) == {'k1', 'k2'}
    assert rt.checks['k2'].status == 'down'


@pytest.mark.asyncio
async def test_poll_leaves_a_missing_check_out_of_runtime() -> None:
    """A fetched check absent upstream is simply missing from the poll result."""
    service, ctx, _ = _setup(_ref('k1'), _ref('k2'))
    with patch(LIST, new=AsyncMock(return_value=[_remote('k1')])):
        await service.poll('p1')
    assert set(ctx.runtime.healthchecks['p1'].checks) == {'k1'}


@pytest.mark.asyncio
async def test_poll_offline_sends_nothing() -> None:
    """A scheduled poll while offline flags the project and makes no request."""
    service, ctx, _ = _setup(_ref('k1'), online=False)
    with patch(LIST, new=AsyncMock()) as list_checks:
        await service.poll('p1')
    list_checks.assert_not_awaited()
    assert ctx.runtime.healthchecks['p1'].offline is True


@pytest.mark.asyncio
async def test_poll_failure_keeps_the_last_good_checks() -> None:
    """A failed poll records the error and keeps the previous check data."""
    service, ctx, _ = _setup(_ref('k1'))
    with patch(LIST, new=AsyncMock(return_value=[_remote('k1')])):
        await service.poll('p1')
    with patch(LIST, new=AsyncMock(side_effect=HealthchecksError('429 Rate limited'))):
        await service.poll('p1')
    rt = ctx.runtime.healthchecks['p1']
    assert rt.ok is False and rt.error == '429 Rate limited'
    assert set(rt.checks) == {'k1'}


@pytest.mark.asyncio
async def test_poll_logs_the_failure_once_and_the_recovery(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Repeated failures log one warning; the next success logs one info line."""
    service, _, _ = _setup(_ref('k1'))
    failing = AsyncMock(side_effect=HealthchecksError('429 Rate limited'))
    with caplog.at_level(logging.DEBUG, logger='tether_ddns'):
        with patch(LIST, new=failing):
            await service.poll('p1')
            await service.poll('p1')
        with patch(LIST, new=AsyncMock(return_value=[_remote('k1')])):
            await service.poll('p1')
            await service.poll('p1')
    assert [(r.levelno, r.getMessage()) for r in caplog.records] == [
        (logging.WARNING, 'Healthchecks "Homelab": 429 Rate limited'),
        (logging.INFO, 'Healthchecks "Homelab": polling recovered'),
    ]


@pytest.mark.asyncio
async def test_poll_unknown_project_is_a_noop() -> None:
    """Polling a deleted project id does nothing."""
    service, ctx, _ = _setup()
    with patch(LIST, new=AsyncMock()) as list_checks:
        await service.poll('gone')
    list_checks.assert_not_awaited()
    assert 'gone' not in ctx.runtime.healthchecks


@pytest.mark.asyncio
async def test_fetch_rebuilds_membership_and_persists() -> None:
    """A fetch merges upstream checks, stamps fetched_at, persists and records status."""
    service, ctx, project = _setup(_ref('k1', visible=False), _ref('k2'))
    with patch(LIST, new=AsyncMock(return_value=[_remote('k1'), _remote('k3')])):
        result = await service.fetch('p1')
    assert result is project
    assert [(c.key, c.visible) for c in project.checks] == [('k1', False), ('k3', True)]
    assert project.fetched_at is not None
    cast(MagicMock, ctx.config_store).save.assert_called_once_with(ctx.config)
    assert set(ctx.runtime.healthchecks['p1'].checks) == {'k1', 'k3'}


@pytest.mark.asyncio
async def test_fetch_runs_while_offline() -> None:
    """A manual fetch is attempted even when the link is offline."""
    service, _, _ = _setup(online=False)
    with patch(LIST, new=AsyncMock(return_value=[])) as list_checks:
        await service.fetch('p1')
    list_checks.assert_awaited_once()


@pytest.mark.asyncio
async def test_failed_fetch_changes_nothing() -> None:
    """A failed fetch leaves config and runtime untouched and re-raises."""
    service, ctx, project = _setup(_ref('k1'))
    with patch(LIST, new=AsyncMock(side_effect=HealthchecksError('HTTP 503'))):
        with pytest.raises(HealthchecksError):
            await service.fetch('p1')
    assert [c.key for c in project.checks] == ['k1']
    assert project.fetched_at is None
    cast(MagicMock, ctx.config_store).save.assert_not_called()
    assert 'p1' not in ctx.runtime.healthchecks


@pytest.mark.asyncio
async def test_fetch_unknown_project_raises_lookup_error() -> None:
    """Fetching an unknown id raises LookupError."""
    service, _, _ = _setup()
    with pytest.raises(LookupError):
        await service.fetch('gone')


def test_mark_offline_flags_every_project() -> None:
    """Going offline flags all configured projects in one emit."""
    service, ctx, _ = _setup()
    ctx.config.healthchecks.append(HealthchecksProject(id='p2', name='VPS', api_key='k'))
    seen: list[dict[str, object]] = []
    ctx.runtime.add_listener(seen.append)
    service.mark_offline()
    assert ctx.runtime.healthchecks['p1'].offline is True
    assert ctx.runtime.healthchecks['p2'].offline is True
    assert len(seen) == 1


@pytest.mark.asyncio
async def test_poll_all_polls_every_project() -> None:
    """poll_all polls each configured project once."""
    service, ctx, _ = _setup()
    ctx.config.healthchecks.append(HealthchecksProject(id='p2', name='VPS', api_key='k'))
    with patch.object(service, 'poll', new=AsyncMock()) as poll:
        await service.poll_all()
    assert [c.args[0] for c in poll.await_args_list] == ['p1', 'p2']
