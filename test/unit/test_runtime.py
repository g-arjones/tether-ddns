"""Tests for the runtime state container."""
import time
from collections import deque
from typing import cast

from tether_ddns.config_store import AppConfig, DomainConfig
from tether_ddns.reachability import ReachabilityResult, ResolverProbe
from tether_ddns.runtime import (
    CheckRecord,
    REACHABILITY_HISTORY_SIZE,
    RuntimeState,
)


def test_rebuild_starts_new_domains_pending() -> None:
    """Every brand-new domain starts pending regardless of enabled flag."""
    cfg = AppConfig(
        domains=[
            DomainConfig(id='a', hostname='a.example.com', provider='duckdns', enabled=True),
            DomainConfig(id='b', hostname='b.example.com', provider='duckdns', enabled=False),
        ],
    )
    state = RuntimeState()
    state.rebuild(cfg)
    assert state.domains['a'].status == 'pending'
    assert state.domains['b'].status == 'pending'


def test_rebuild_preserves_surviving_runtime() -> None:
    """A surviving domain keeps its ip/updated/status across rebuild."""
    cfg = AppConfig(domains=[
        DomainConfig(id='a', hostname='a.example.com', provider='duckdns')])
    state = RuntimeState()
    state.rebuild(cfg)
    state.set_status('a', 'synced', ip='1.2.3.4')
    prior_updated = state.domains['a'].updated
    # Simulate a config edit adding a second domain; 'a' must survive intact.
    cfg2 = AppConfig(domains=[
        DomainConfig(id='a', hostname='a.example.com', provider='duckdns'),
        DomainConfig(id='c', hostname='c.example.com', provider='duckdns')])
    state.rebuild(cfg2)
    assert state.domains['a'].status == 'synced'
    assert state.domains['a'].ip == '1.2.3.4'
    assert state.domains['a'].updated == prior_updated
    assert state.domains['c'].status == 'pending'


def test_freshness_matches_current_ip() -> None:
    """freshness() is synced only when assigned equals current and is known."""
    from tether_ddns.runtime import freshness
    assert freshness('1.2.3.4', '1.2.3.4') == 'synced'
    assert freshness('1.2.3.4', '9.9.9.9') == 'pending'
    assert freshness(None, '1.2.3.4') == 'pending'
    assert freshness('1.2.3.4', None) == 'pending'
    assert freshness(None, None) == 'pending'


def test_set_freshness_toggles_synced_pending() -> None:
    """set_freshness flips synced<->pending based on the current IP."""
    cfg = AppConfig(domains=[
        DomainConfig(id='a', hostname='a.example.com', provider='duckdns')])
    state = RuntimeState()
    state.rebuild(cfg)
    state.set_status('a', 'synced', ip='1.2.3.4')
    state.set_freshness('a', '9.9.9.9')
    assert state.domains['a'].status == 'pending'
    state.set_freshness('a', '1.2.3.4')
    assert state.domains['a'].status == 'synced'


def test_set_freshness_preserves_error_and_updating() -> None:
    """set_freshness never overwrites error or updating."""
    cfg = AppConfig(domains=[
        DomainConfig(id='a', hostname='a.example.com', provider='duckdns'),
        DomainConfig(id='b', hostname='b.example.com', provider='duckdns')])
    state = RuntimeState()
    state.rebuild(cfg)
    state.set_status('a', 'error', message='boom')
    state.set_status('b', 'updating')
    state.set_freshness('a', '1.2.3.4')
    state.set_freshness('b', '1.2.3.4')
    assert state.domains['a'].status == 'error'
    assert state.domains['b'].status == 'updating'


def test_set_status_notifies_listeners() -> None:
    """Status changes emit a snapshot to listeners."""
    cfg = AppConfig(domains=[DomainConfig(id='a', hostname='a.example.com', provider='duckdns')])
    state = RuntimeState()
    state.rebuild(cfg)
    seen: list[dict[str, object]] = []
    state.add_listener(seen.append)
    state.set_status('a', 'synced', ip='1.2.3.4')
    assert state.domains['a'].status == 'synced'
    assert seen and seen[-1]['public_ipv4'] is None


def test_public_ip_and_online_emit_snapshots() -> None:
    """Setting public IP and online status notifies listeners."""
    state = RuntimeState()
    seen: list[dict[str, object]] = []
    state.add_listener(seen.append)
    state.set_public_ipv4('9.9.9.9')
    state.set_online(True)
    assert state.public_ipv4 == '9.9.9.9'
    assert state.online is True
    assert seen[-1]['online'] is True
    assert seen[-2]['public_ipv4'] == '9.9.9.9'


def test_set_public_ipv4_and_ipv6_emit_snapshot() -> None:
    """Setting each family updates state and emits a snapshot."""
    state = RuntimeState()
    seen: list[dict[str, object]] = []
    state.add_listener(seen.append)
    state.set_public_ipv4('203.0.113.4')
    state.set_public_ipv6('2001:db8::4')
    assert state.public_ipv4 == '203.0.113.4'
    assert state.public_ipv6 == '2001:db8::4'
    assert seen[-1]['public_ipv6'] == '2001:db8::4'
    assert 'public_ip' not in seen[-1]


def test_model_dump_excludes_ephemeral_and_reachability_series() -> None:
    """Persisted payload omits ephemerals and the reachability telemetry series."""
    state = RuntimeState()
    state.set_next_check_at(123.0)
    state.set_public_ipv4('1.2.3.4')
    state.record_reachability(
        ReachabilityResult(online=True, successes=3, total=3, probes=[]))
    dumped = state.model_dump()
    # Ephemeral / derived (pre-existing exclusions).
    assert 'reachability_latest' not in dumped
    assert 'next_check_at' not in dumped
    assert '_listeners' not in dumped
    assert '_configs' not in dumped
    # Reachability telemetry series (newly excluded).
    assert 'reachability_started_at' not in dumped
    assert 'reachability_checks' not in dumped
    assert 'reachability_online' not in dumped
    assert 'reachability_history' not in dumped
    assert 'reachability_since' not in dumped
    # Still persisted.
    assert dumped['public_ipv4'] == '1.2.3.4'
    assert dumped['online'] is True
    assert 'ipv4_changed_at' in dumped
    assert 'domains' in dumped


def test_snapshot_still_emits_full_reachability_block() -> None:
    """snapshot() (the frontend payload) keeps the whole reachability block."""
    state = RuntimeState()
    state.record_reachability(
        ReachabilityResult(online=True, successes=3, total=3, probes=[]))
    snap = state.snapshot()
    reach = snap['reachability']
    assert isinstance(reach, dict)
    reach_dict = cast('dict[str, object]', reach)
    assert set(reach_dict) == {
        'since', 'checks', 'online', 'history', 'latest'}
    assert reach_dict['checks'] == 1


def test_reachability_since_resets_on_transition() -> None:
    """reachability_since is reset only when the online state transitions."""
    state = RuntimeState()
    boot_since = state.reachability_since
    # Steady offline (starts offline): no transition, since unchanged.
    state.record_reachability(
        ReachabilityResult(online=False, successes=0, total=3, probes=[]))
    assert state.reachability_since == boot_since
    # offline -> online: transition, since advances to ~now.
    before = time.time()
    state.record_reachability(
        ReachabilityResult(online=True, successes=3, total=3, probes=[]))
    up_since = state.reachability_since
    assert up_since >= before
    assert up_since > boot_since
    # Steady online: no transition, since unchanged.
    state.record_reachability(
        ReachabilityResult(online=True, successes=3, total=3, probes=[]))
    assert state.reachability_since == up_since
    # online -> offline: transition, since resets again to ~now.
    before_down = time.time()
    state.record_reachability(
        ReachabilityResult(online=False, successes=0, total=3, probes=[]))
    assert state.reachability_since >= before_down


def test_round_trip_drops_series_keeps_status() -> None:
    """After a dump/validate round-trip the series is reset but status survives."""
    state = RuntimeState()
    state.set_public_ipv4('9.9.9.9')
    state.set_online(True)
    for _ in range(5):
        state.record_reachability(
            ReachabilityResult(online=True, successes=3, total=3, probes=[]))
    restored = RuntimeState.model_validate(state.model_dump())
    # Series rebuilds from empty.
    assert restored.reachability_checks == 0
    assert restored.reachability_online == 0
    assert len(restored.reachability_history) == 0
    # Meaningful status survives.
    assert restored.public_ipv4 == '9.9.9.9'
    assert restored.online is True


def test_history_is_bounded_deque() -> None:
    """CRITICAL: the live history deque stays capped at the history size.

    The series is not persisted, but the in-memory deque must remain bounded so
    long-running operation cannot grow it without limit.
    """
    state = RuntimeState()
    for _ in range(REACHABILITY_HISTORY_SIZE + 30):
        state.record_reachability(
            ReachabilityResult(online=True, successes=1, total=1, probes=[]))
    assert isinstance(state.reachability_history, deque)
    assert state.reachability_history.maxlen == REACHABILITY_HISTORY_SIZE
    assert len(state.reachability_history) == REACHABILITY_HISTORY_SIZE


def test_listeners_survive_model_construction() -> None:
    """Listeners still fire after the BaseModel conversion."""
    state = RuntimeState()
    seen: list[dict[str, object]] = []
    state.add_listener(seen.append)
    state.set_online(True)
    assert seen and seen[-1]['online'] is True


def test_restore_then_rebuild_preserves_domain_status() -> None:
    """Restored domain status survives rebuild against the same config.

    Config changes made while the app was down are not specially detected;
    the next scheduled sync reconciles any stale status (Option A).
    """
    cfg = AppConfig(domains=[
        DomainConfig(id='a', hostname='a.example.com', provider='duckdns')])
    saved = RuntimeState()
    saved.rebuild(cfg)
    saved.set_status('a', 'synced', ip='1.2.3.4')

    fresh = RuntimeState()
    fresh.restore(RuntimeState.model_validate(saved.model_dump()), cfg)
    fresh.rebuild(cfg)
    assert fresh.domains['a'].status == 'synced'
    assert fresh.domains['a'].ip == '1.2.3.4'


def test_restore_adds_new_domain_as_pending() -> None:
    """A domain absent from persisted state starts pending after rebuild."""
    saved_cfg = AppConfig(domains=[
        DomainConfig(id='a', hostname='a.example.com', provider='duckdns')])
    saved = RuntimeState()
    saved.rebuild(saved_cfg)
    saved.set_status('a', 'synced', ip='1.2.3.4')

    cfg2 = AppConfig(domains=[
        DomainConfig(id='a', hostname='a.example.com', provider='duckdns'),
        DomainConfig(id='b', hostname='b.example.com', provider='duckdns')])
    fresh = RuntimeState()
    fresh.restore(RuntimeState.model_validate(saved.model_dump()), cfg2)
    fresh.rebuild(cfg2)
    assert fresh.domains['a'].status == 'synced'
    assert fresh.domains['b'].status == 'pending'


def test_restore_copies_public_ips_but_not_series() -> None:
    """Restore brings over IPs and timestamps; the series is not persisted."""
    saved = RuntimeState()
    saved.set_public_ipv4('9.9.9.9')
    saved.record_reachability(
        ReachabilityResult(online=True, successes=2, total=3, probes=[]))
    cfg = AppConfig()
    fresh = RuntimeState()
    fresh.restore(RuntimeState.model_validate(saved.model_dump()), cfg)
    assert fresh.public_ipv4 == '9.9.9.9'
    assert fresh.ipv4_changed_at is not None
    # The reachability telemetry series is excluded from persistence, so a
    # dump/validate round-trip resets it; restore copies those defaults.
    assert fresh.reachability_checks == 0
    assert len(fresh.reachability_history) == 0


def test_remove_listener_and_unknown_status() -> None:
    """Removed listeners stop receiving and unknown ids are ignored."""
    state = RuntimeState()
    seen: list[dict[str, object]] = []
    state.add_listener(seen.append)
    state.remove_listener(seen.append)  # not registered: no-op
    state.remove_listener(seen.append)
    state.set_status('missing', 'synced')  # unknown id: no emit
    assert seen == []


def test_set_status_returns_transition() -> None:
    """set_status returns the new status on change and None otherwise."""
    cfg = AppConfig(domains=[
        DomainConfig(id='a', hostname='a.example.com', provider='duckdns')])
    state = RuntimeState()
    state.rebuild(cfg)  # starts 'pending'
    assert state.set_status('a', 'synced', ip='1.2.3.4') == 'synced'
    assert state.set_status('a', 'synced', ip='1.2.3.4') is None
    assert state.set_status('missing', 'synced') is None


def test_set_freshness_returns_transition() -> None:
    """set_freshness returns the new status on change and None otherwise."""
    cfg = AppConfig(domains=[
        DomainConfig(id='a', hostname='a.example.com', provider='duckdns')])
    state = RuntimeState()
    state.rebuild(cfg)
    state.set_status('a', 'synced', ip='1.2.3.4')
    assert state.set_freshness('a', '9.9.9.9') == 'pending'
    assert state.set_freshness('a', '9.9.9.9') is None
    assert state.set_freshness('a', '1.2.3.4') == 'synced'


def test_rebuild_resets_changed_hostname() -> None:
    """A domain whose hostname changed restarts at pending with ip cleared."""
    cfg = AppConfig(domains=[
        DomainConfig(id='a', hostname='a.example.com', provider='duckdns')])
    state = RuntimeState()
    state.rebuild(cfg)
    state.set_status('a', 'synced', ip='1.2.3.4')
    cfg2 = AppConfig(domains=[
        DomainConfig(id='a', hostname='b.example.com', provider='duckdns')])
    state.rebuild(cfg2)
    assert state.domains['a'].status == 'pending'
    assert state.domains['a'].ip is None


def test_rebuild_resets_changed_provider_config() -> None:
    """A domain whose provider_config changed restarts at pending."""
    cfg = AppConfig(domains=[
        DomainConfig(id='a', hostname='a.example.com', provider='duckdns',
                     provider_config={'token': 'x', 'domain': 'a'})])
    state = RuntimeState()
    state.rebuild(cfg)
    state.set_status('a', 'synced', ip='1.2.3.4')
    cfg2 = AppConfig(domains=[
        DomainConfig(id='a', hostname='a.example.com', provider='duckdns',
                     provider_config={'token': 'y', 'domain': 'a'})])
    state.rebuild(cfg2)
    assert state.domains['a'].status == 'pending'


def test_rebuild_preserves_unchanged_domain() -> None:
    """Rebuilding with identical config preserves status/ip/updated."""
    cfg = AppConfig(domains=[
        DomainConfig(id='a', hostname='a.example.com', provider='duckdns')])
    state = RuntimeState()
    state.rebuild(cfg)
    state.set_status('a', 'synced', ip='1.2.3.4')
    prior_updated = state.domains['a'].updated
    state.rebuild(AppConfig(domains=[
        DomainConfig(id='a', hostname='a.example.com', provider='duckdns')]))
    assert state.domains['a'].status == 'synced'
    assert state.domains['a'].ip == '1.2.3.4'
    assert state.domains['a'].updated == prior_updated


def test_rebuild_enable_toggle_does_not_reset() -> None:
    """Toggling enabled alone must not reset a synced domain."""
    cfg = AppConfig(domains=[
        DomainConfig(id='a', hostname='a.example.com', provider='duckdns',
                     enabled=True)])
    state = RuntimeState()
    state.rebuild(cfg)
    state.set_status('a', 'synced', ip='1.2.3.4')
    state.rebuild(AppConfig(domains=[
        DomainConfig(id='a', hostname='a.example.com', provider='duckdns',
                     enabled=False)]))
    assert state.domains['a'].status == 'synced'
    assert state.domains['a'].ip == '1.2.3.4'


def test_reachability_fields_initialised() -> None:
    """Reachability telemetry fields are set on RuntimeState init."""
    state = RuntimeState()
    assert state.reachability_checks == 0
    assert state.reachability_online == 0
    assert isinstance(state.reachability_history, deque)
    assert state.reachability_history.maxlen == REACHABILITY_HISTORY_SIZE
    assert state.reachability_latest == []
    assert state.next_check_at is None
    assert state.ipv4_changed_at is None
    assert state.ipv6_changed_at is None
    assert isinstance(state.reachability_since, float)


def test_check_record_shape() -> None:
    """Verify CheckRecord model captures ts, successes, and total."""
    rec = CheckRecord(ts=1.0, successes=3, total=3)
    assert rec.model_dump() == {'ts': 1.0, 'successes': 3, 'total': 3}


def _result(online: bool, successes: int = 3, total: int = 3) -> ReachabilityResult:
    return ReachabilityResult(
        online=online, successes=successes, total=total,
        probes=[ResolverProbe(ip='1.1.1.1', ok=online, latency_ms=5.0)])


def test_record_reachability_accumulates() -> None:
    """record_reachability counts checks, tracks latest probes, and detects transitions."""
    state = RuntimeState()
    assert state.record_reachability(_result(True)) is True   # False -> True
    assert state.record_reachability(_result(True)) is False  # no transition
    assert state.reachability_checks == 2
    assert state.reachability_online == 2
    assert state.online is True
    assert len(state.reachability_history) == 2
    assert state.reachability_latest[0].ip == '1.1.1.1'


def test_record_reachability_counts_only_online() -> None:
    """reachability_online only increments for successful results."""
    state = RuntimeState()
    state.record_reachability(_result(True))
    state.record_reachability(_result(False, successes=0))
    assert state.reachability_checks == 2
    assert state.reachability_online == 1


def test_record_reachability_history_caps_at_size() -> None:
    """reachability_history deque caps at REACHABILITY_HISTORY_SIZE."""
    state = RuntimeState()
    for _ in range(REACHABILITY_HISTORY_SIZE + 5):
        state.record_reachability(_result(True))
    assert len(state.reachability_history) == REACHABILITY_HISTORY_SIZE


def test_set_next_check_at() -> None:
    """set_next_check_at records the timestamp for the next reachability check."""
    state = RuntimeState()
    state.set_next_check_at(123.0)
    assert state.next_check_at == 123.0


def test_ip_changed_at_only_moves_on_change() -> None:
    """ipv4_changed_at only updates when the IP actually changes."""
    state = RuntimeState()
    state.set_public_ipv4('203.0.113.1')
    first = state.ipv4_changed_at
    assert first is not None
    state.set_public_ipv4('203.0.113.1')  # unchanged
    assert state.ipv4_changed_at == first
    state.set_public_ipv4('203.0.113.2')  # changed
    assert state.ipv4_changed_at is not None
    assert state.ipv4_changed_at >= first


def test_snapshot_includes_reachability_block() -> None:
    """snapshot() includes the reachability block with checks, online count, and latest probes."""
    state = RuntimeState()
    state.record_reachability(_result(True))
    state.set_next_check_at(999.0)
    state.set_public_ipv4('203.0.113.9')
    snap = state.snapshot()
    assert snap['next_check_at'] == 999.0
    assert snap['ipv4_changed_at'] is not None
    assert snap['ipv6_changed_at'] is None
    reach = snap['reachability']
    assert isinstance(reach, dict)
    assert reach['checks'] == 1
    assert reach['online'] == 1
    assert isinstance(reach['since'], float)
    assert reach['history'] == [
        {'ts': reach['history'][0]['ts'], 'successes': 3, 'total': 3}]
    assert reach['latest'] == [
        {'ip': '1.1.1.1', 'ok': True, 'latency_ms': 5.0}]
