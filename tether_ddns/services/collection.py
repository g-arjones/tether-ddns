"""Generic helpers for id-keyed configuration collections."""
from __future__ import annotations

from typing import Protocol, TypeVar

from fastapi import HTTPException


class _HasId(Protocol):
    """Structural type for objects carrying a string id."""

    id: str  # noqa: A003


T = TypeVar('T', bound=_HasId)


def find_or_404(items: list[T], item_id: str, detail: str) -> tuple[int, T]:
    """Return (index, item) for a matching id, or raise HTTPException(404)."""
    for i, item in enumerate(items):
        if item.id == item_id:
            return i, item
    raise HTTPException(status_code=404, detail=detail)
