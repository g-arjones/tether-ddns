"""Tests for secret masking/merging helpers."""
from tether_ddns.config_store import MASK, mask_secrets, merge_secrets

SCHEMA: dict[str, object] = {'properties': {'token': {'format': 'password'}, 'domain': {}}}


def test_mask_secrets_masks_password_fields() -> None:
    """Password fields are replaced with the mask."""
    out = mask_secrets(SCHEMA, {'token': 'real', 'domain': 'host'})
    assert out['token'] == MASK
    assert out['domain'] == 'host'


def test_merge_secrets_keeps_existing_when_masked() -> None:
    """A masked incoming secret retains the stored value."""
    out = merge_secrets(
        SCHEMA,
        {'token': MASK, 'domain': 'host2'},
        {'token': 'real', 'domain': 'host'},
    )
    assert out['token'] == 'real'
    assert out['domain'] == 'host2'
