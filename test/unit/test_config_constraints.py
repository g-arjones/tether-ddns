"""Save-time constraints on provider and hook config models."""
from typing import Any

from pydantic import BaseModel, ValidationError

import pytest

from tether_ddns.hooks.registered_hooks.pushover import PushoverConfig
from tether_ddns.providers.ddns_providers.cloudflare import CloudflareConfig
from tether_ddns.providers.ddns_providers.duckdns import DuckDNSConfig


def _error_types(model: type[BaseModel], data: dict[str, Any]) -> dict[str, str]:
    """Validate data and return {first loc part: error type} for every failure."""
    with pytest.raises(ValidationError) as info:
        model.model_validate(data)
    return {str(e['loc'][0]): e['type'] for e in info.value.errors()}


SECRETS: list[tuple[type[BaseModel], str, dict[str, str]]] = [
    (DuckDNSConfig, 'token', {}),
    (CloudflareConfig, 'api_token', {}),
    (PushoverConfig, 'token', {'user': 'u'}),
    (PushoverConfig, 'user', {'token': 't'}),
]


@pytest.mark.parametrize(('model', 'field', 'others'), SECRETS)
def test_empty_secret_is_rejected(
    model: type[BaseModel], field: str, others: dict[str, str],
) -> None:
    """An empty secret fails with a min-length error on that field only."""
    assert _error_types(model, {**others, field: ''}) == {field: 'too_short'}


@pytest.mark.parametrize(('model', 'field', 'others'), SECRETS)
def test_missing_secret_is_rejected(
    model: type[BaseModel], field: str, others: dict[str, str],
) -> None:
    """A missing secret fails as 'missing' on that field only."""
    assert _error_types(model, others) == {field: 'missing'}


def test_required_secret_keeps_password_format_and_title() -> None:
    """The schema still marks the secret as a titled, required password field."""
    schema = CloudflareConfig.model_json_schema()
    token = schema['properties']['api_token']
    assert token['format'] == 'password'
    assert token['minLength'] == 1
    assert token['title'] == 'API Token'
    assert schema['required'] == ['api_token']


@pytest.mark.parametrize('ttl', [1, 60, 300, 86400])
def test_cloudflare_accepts_auto_and_explicit_ttl(ttl: int) -> None:
    """TTL 1 (automatic) and 60..86400 seconds are accepted."""
    assert CloudflareConfig.model_validate({'api_token': 't', 'ttl': ttl}).ttl == ttl


@pytest.mark.parametrize('ttl', [0, 2, 59, 86401])
def test_cloudflare_rejects_out_of_range_ttl(ttl: int) -> None:
    """Any other TTL fails with the ttl_range error."""
    assert _error_types(CloudflareConfig, {'api_token': 't', 'ttl': ttl}) == {
        'ttl': 'ttl_range'}


def test_cloudflare_ttl_message_names_the_valid_range() -> None:
    """The TTL error reads as a sentence an operator can act on."""
    with pytest.raises(ValidationError) as info:
        CloudflareConfig.model_validate({'api_token': 't', 'ttl': 30})
    assert info.value.errors()[0]['msg'] == 'Must be 1 (auto) or between 60 and 86400'
