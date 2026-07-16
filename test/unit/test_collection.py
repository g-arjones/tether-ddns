"""Tests for the find_or_404 collection helper."""
from fastapi import HTTPException

import pytest

from tether_ddns.config_store import DomainConfig
from tether_ddns.services.collection import find_or_404


def test_find_or_404_returns_index_and_item() -> None:
    """A matching id returns its index and the item."""
    a = DomainConfig(id='a', hostname='h1', provider='duckdns')
    b = DomainConfig(id='b', hostname='h2', provider='duckdns')
    idx, item = find_or_404([a, b], 'b', 'not found')
    assert idx == 1
    assert item is b


def test_find_or_404_raises_on_miss() -> None:
    """A missing id raises HTTPException(404) with the given detail."""
    with pytest.raises(HTTPException) as exc:
        find_or_404([], 'x', 'domain not found')
    assert exc.value.status_code == 404
    assert exc.value.detail == 'domain not found'
