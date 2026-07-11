"""Helpers for declaring UI-friendly config-model fields."""
from __future__ import annotations

from typing import Any, cast

from pydantic import Field


def labeled_field(
    *,
    title: str | None = None,
    description: str | None = None,
    labels: dict[str, str] | None = None,
    **kwargs: Any,
) -> Any:
    """Build a pydantic Field with a title and optional enum-value labels.

    ``labels`` maps enum/Literal values to human labels and is emitted under the
    schema key ``x-enum-labels`` (merged with any ``json_schema_extra`` passed in
    ``kwargs``). Intended for use in ``Annotated[T, labeled_field(...)]`` so the
    field default stays on the model attribute.
    """
    field_kwargs: dict[str, Any] = dict(kwargs)
    if title is not None:
        field_kwargs['title'] = title
    if description is not None:
        field_kwargs['description'] = description
    if labels is not None:
        extra = field_kwargs.get('json_schema_extra')
        merged: dict[str, Any] = (
            dict(cast('dict[str, Any]', extra)) if isinstance(extra, dict) else {})
        merged['x-enum-labels'] = labels
        field_kwargs['json_schema_extra'] = merged
    return Field(**field_kwargs)
