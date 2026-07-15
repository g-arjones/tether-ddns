"""Tests for event.from_context current-state synthesis."""
from tether_ddns.config import AppConfig, DomainConfig
from tether_ddns.context import AppContext
from tether_ddns.hooks.base import (
    DomainUpdateErrorEvent, DomainUpdatePendingEvent,
    DomainUpdateSuccessEvent, IpChangedEvent, ReachabilityChangedEvent)
from tether_ddns.runtime import DomainRuntime, RuntimeState


def _ctx(cfg: AppConfig, runtime: RuntimeState) -> AppContext:
    """Build an AppContext from config and runtime (store/manager unused here)."""
    return AppContext(cfg, runtime, store=None, manager=None)  # type: ignore[arg-type]


def test_reachability_from_context_snapshots_online() -> None:
    """Reachability synthesis mirrors current online with no transition."""
    rt = RuntimeState()
    rt.online = True
    events = ReachabilityChangedEvent.from_context(_ctx(AppConfig(), rt))
    assert len(events) == 1
    assert events[0].online is True
    assert events[0].was_online is True


def test_ip_changed_from_context_one_per_known_family() -> None:
    """Only families with a known IP produce an event."""
    rt = RuntimeState()
    rt.public_ipv4 = '1.2.3.4'
    events = IpChangedEvent.from_context(_ctx(AppConfig(), rt))
    assert [(e.family, e.new_ip) for e in events] == [('ipv4', '1.2.3.4')]
    assert events[0].old_ip == '1.2.3.4'


def test_ip_changed_from_context_empty_when_no_ip() -> None:
    """No known IP yields an empty list (skipped)."""
    assert IpChangedEvent.from_context(_ctx(AppConfig(), RuntimeState())) == []


def test_domain_success_from_context_matches_synced_domains() -> None:
    """Only synced domains with a known ip produce success events."""
    cfg = AppConfig(domains=[DomainConfig(id='d1', hostname='h', provider='duckdns')])
    rt = RuntimeState()
    rt.domains['d1'] = DomainRuntime(id='d1', status='synced', ip='9.9.9.9')
    events = DomainUpdateSuccessEvent.from_context(_ctx(cfg, rt))
    assert len(events) == 1
    assert events[0].domain_id == 'd1'
    assert events[0].ip == '9.9.9.9'


def test_domain_error_from_context_matches_error_domains() -> None:
    """Only error domains produce error events, carrying the message."""
    cfg = AppConfig(domains=[DomainConfig(id='d1', hostname='h', provider='duckdns')])
    rt = RuntimeState()
    rt.domains['d1'] = DomainRuntime(id='d1', status='error', message='boom')
    events = DomainUpdateErrorEvent.from_context(_ctx(cfg, rt))
    assert len(events) == 1
    assert events[0].message == 'boom'


def test_domain_pending_from_context_matches_pending_domains() -> None:
    """Only pending domains produce pending events."""
    cfg = AppConfig(domains=[DomainConfig(id='d1', hostname='h', provider='duckdns')])
    rt = RuntimeState()
    rt.domains['d1'] = DomainRuntime(id='d1', status='pending')
    rt.public_ipv4 = '1.2.3.4'
    events = DomainUpdatePendingEvent.from_context(_ctx(cfg, rt))
    assert len(events) == 1
    assert events[0].current_ip == '1.2.3.4'
