"""Tests for the DDNS provider registry and auto-loader."""
from pydantic import BaseModel

import pytest

from tether_ddns.providers import base


def test_register_provider_adds_to_registry() -> None:
    """The decorator registers a provider by its key."""
    @base.register_provider
    class _Dummy(base.DDNSProvider):
        key = 'dummy'
        display_name = 'Dummy'

        async def update(
            self, hostname: str, record_type: str, ip: str, config: BaseModel,
        ) -> base.UpdateResult:
            return base.UpdateResult(success=True, ip=ip)

    assert base.PROVIDER_REGISTRY['dummy'] is _Dummy


def test_load_providers_imports_builtin_duckdns() -> None:
    """Auto-loading discovers the shipped DuckDNS provider."""
    base.load_providers()
    assert 'duckdns' in base.PROVIDER_REGISTRY


@pytest.mark.asyncio
async def test_config_schema_returns_json_schema() -> None:
    """config_schema exposes the provider's pydantic schema."""
    base.load_providers()
    provider_cls = base.PROVIDER_REGISTRY['duckdns']
    schema = provider_cls.config_schema()
    assert 'properties' in schema


def test_default_config_model_is_empty_config() -> None:
    """Providers that omit ConfigModel default to EmptyConfig, not bare BaseModel."""
    @base.register_provider
    class _NoConfig(base.DDNSProvider):
        key = 'noconfig'
        display_name = 'NoConfig'

        async def update(
            self, hostname: str, record_type: str, ip: str, config: BaseModel,
        ) -> base.UpdateResult:
            return base.UpdateResult(success=True, ip=ip)

    assert _NoConfig.ConfigModel is base.EmptyConfig
    validated = _NoConfig.ConfigModel.model_validate({})
    assert isinstance(validated, base.EmptyConfig)
