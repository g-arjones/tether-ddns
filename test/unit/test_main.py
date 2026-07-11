"""Tests for the CLI entrypoint bind-address resolution."""
import pytest

from tether_ddns.__main__ import resolve_bind


def test_defaults_when_no_cli_or_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Falls back to 0.0.0.0:8000 when nothing is set."""
    monkeypatch.delenv('TETHER_DDNS_HOST', raising=False)
    monkeypatch.delenv('TETHER_DDNS_PORT', raising=False)
    assert resolve_bind(None, None) == ('0.0.0.0', 8000)


def test_env_overrides_defaults(monkeypatch: pytest.MonkeyPatch) -> None:
    """Env vars take precedence over defaults."""
    monkeypatch.setenv('TETHER_DDNS_HOST', '127.0.0.1')
    monkeypatch.setenv('TETHER_DDNS_PORT', '9000')
    assert resolve_bind(None, None) == ('127.0.0.1', 9000)


def test_cli_overrides_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """CLI values take precedence over env vars."""
    monkeypatch.setenv('TETHER_DDNS_HOST', '127.0.0.1')
    monkeypatch.setenv('TETHER_DDNS_PORT', '9000')
    assert resolve_bind('10.0.0.1', 7000) == ('10.0.0.1', 7000)


def test_invalid_env_port_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    """A non-numeric env port fails fast."""
    monkeypatch.delenv('TETHER_DDNS_HOST', raising=False)
    monkeypatch.setenv('TETHER_DDNS_PORT', 'abc')
    with pytest.raises(ValueError):
        resolve_bind(None, None)
