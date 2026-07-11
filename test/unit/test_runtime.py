"""Tests for the runtime state container."""
from tether_ddns.config import AppConfig, DomainConfig
from tether_ddns.runtime import RuntimeState


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
