"""Shared config-model reflection for plugin base classes."""
from __future__ import annotations

from typing import get_args, get_origin

from pydantic import BaseModel


class EmptyConfig(BaseModel):
    """Default config model for plugins without configuration."""


def derive_config_model(
        cls: type, default: type[BaseModel]) -> type[BaseModel]:
    """Return the model named as `Base[Model]` in cls.__orig_bases__.

    Falls back to `default` when the subclass does not specialize the base.
    """
    for base in getattr(cls, '__orig_bases__', ()):
        origin = get_origin(base)
        if (origin is not None and isinstance(origin, type)
                and issubclass(origin, ConfigModelMixin)):
            args = get_args(base)
            if (args and isinstance(args[0], type)
                    and issubclass(args[0], BaseModel)):
                return args[0]
    return default


class ConfigModelMixin:
    """Auto-populate `ConfigModel` from the generic argument on subclassing."""

    ConfigModel: type[BaseModel] = EmptyConfig

    def __init_subclass__(cls, **kwargs: object) -> None:
        """Derive ConfigModel from the specialized generic base, if any."""
        super().__init_subclass__(**kwargs)
        cls.ConfigModel = derive_config_model(cls, cls.ConfigModel)
