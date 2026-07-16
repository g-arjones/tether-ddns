"""Tests for the shared plugin-config reflection helpers."""
from pydantic import BaseModel

from tether_ddns.plugin_config import (
    ConfigModelMixin,
    EmptyConfig,
    derive_config_model,
)


class _CfgA(BaseModel):
    """A config."""

    x: int = 1


class _Base[C: BaseModel](ConfigModelMixin):  # noqa: D101
    """A generic base using the mixin."""


class _PlainBase(ConfigModelMixin):
    """A non-generic base using the mixin."""


def test_specialized_subclass_derives_config_model() -> None:
    """A subclass specializing the generic gets that model as ConfigModel."""
    class _Impl(_Base[_CfgA]):
        """Impl."""

    assert _Impl.ConfigModel is _CfgA


def test_empty_specialization_resolves_empty_config() -> None:
    """Specializing with EmptyConfig resolves to EmptyConfig."""
    class _Impl(_Base[EmptyConfig]):
        """Impl."""

    assert _Impl.ConfigModel is EmptyConfig


def test_non_generic_subclass_falls_back_to_default() -> None:
    """A subclass that does not specialize keeps the inherited default."""
    class _Impl(_PlainBase):
        """Impl."""

    assert _Impl.ConfigModel is EmptyConfig


def test_inheritance_chain_preserves_derived_model() -> None:
    """A subclass of a concrete class inherits its derived ConfigModel."""
    class _Impl(_Base[_CfgA]):
        """Impl."""

    class _Sub(_Impl):
        """Sub."""

    assert _Sub.ConfigModel is _CfgA


def test_derive_config_model_returns_default_without_orig_bases() -> None:
    """derive_config_model returns the default for a plain class."""
    class _Plain:
        """Plain."""

    assert derive_config_model(_Plain, EmptyConfig) is EmptyConfig
