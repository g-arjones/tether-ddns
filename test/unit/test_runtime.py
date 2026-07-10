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
    assert seen and seen[-1]['public_ip'] is None
