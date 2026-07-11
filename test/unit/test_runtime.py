"""Tests for the runtime state container."""
from tether_ddns.config import AppConfig, DomainConfig
from tether_ddns.runtime import RuntimeState


def test_rebuild_initialises_domain_statuses() -> None:
    """Disabled domains start paused; enabled domains start pending."""
    cfg = AppConfig(
        domains=[
            DomainConfig(id='a', hostname='a.example.com', provider='duckdns', enabled=True),
            DomainConfig(id='b', hostname='b.example.com', provider='duckdns', enabled=False),
        ],
    )
    state = RuntimeState()
    state.rebuild(cfg)
    assert state.domains['a'].status == 'pending'
    assert state.domains['b'].status == 'paused'


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
