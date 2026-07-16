"""Cloudflare dynamic DNS provider."""
from __future__ import annotations

from typing import Annotated, Any, cast

import aiohttp

from pydantic import BaseModel, SecretStr

from tether_ddns.errors import TetherError
from tether_ddns.providers.base import (
    DDNSProvider,
    register_provider,
)
from tether_ddns.schema_fields import labeled_field

_API = 'https://api.cloudflare.com/client/v4'


class CloudflareConfig(BaseModel):
    """Configuration for the Cloudflare provider."""

    api_token: Annotated[SecretStr, labeled_field(title='API Token')]
    proxied: bool = False
    ttl: Annotated[int, labeled_field(title='TTL')] = 1


def zone_matches(zone_name: str, hostname: str) -> bool:
    """Return True if the zone is a label-boundary suffix of the hostname."""
    return hostname == zone_name or hostname.endswith('.' + zone_name)


def _result_list(payload: object) -> list[dict[str, Any]]:
    """Extract the Cloudflare 'result' list from a response payload."""
    if not isinstance(payload, dict):
        return []
    result = cast('dict[str, Any]', payload).get('result')
    if not isinstance(result, list):
        return []
    items = cast('list[Any]', result)
    return [item for item in items if isinstance(item, dict)]


def _is_success(payload: object) -> bool:
    """Return True if the Cloudflare payload reports success."""
    if not isinstance(payload, dict):
        return False
    return cast('dict[str, Any]', payload).get('success') is True


def _error_messages(payload: object) -> str:
    """Join the Cloudflare error messages from a response payload."""
    if not isinstance(payload, dict):
        return ''
    errors = cast('dict[str, Any]', payload).get('errors')
    if not isinstance(errors, list):
        return ''
    items = cast('list[Any]', errors)
    return '; '.join(
        str(cast('dict[str, Any]', e).get('message', ''))
        for e in items if isinstance(e, dict))


@register_provider
class CloudflareProvider(DDNSProvider[CloudflareConfig]):
    """Updates a Cloudflare DNS record, resolving zone and record by name."""

    key = 'cloudflare'
    display_name = 'Cloudflare'
    ConfigModel = CloudflareConfig

    async def _send(
        self, session: aiohttp.ClientSession, method: str, url: str,
        **kwargs: Any,
    ) -> dict[str, Any]:
        """Send a request, verify Cloudflare success, and return the payload."""
        async with getattr(session, method)(url, **kwargs) as resp:
            payload: object = await resp.json()
        if not _is_success(payload):
            raise TetherError(
                _error_messages(payload) or 'Cloudflare request failed')
        return cast('dict[str, Any]', payload)

    async def update(
        self, hostname: str, record_type: str, ip: str, config: CloudflareConfig,
    ) -> str:
        """Resolve the zone and record for hostname and update it to ip."""
        headers = {
            'Authorization': f'Bearer {config.api_token.get_secret_value()}',
            'Content-Type': 'application/json',
        }
        async with aiohttp.ClientSession(headers=headers) as session:
            zones = _result_list(await self._send(session, 'get', f'{_API}/zones'))
            matches = [
                z for z in zones if zone_matches(str(z.get('name', '')), hostname)]
            zone = max(matches, key=lambda z: len(str(z.get('name', ''))), default=None)
            if zone is None:
                raise TetherError(f'no matching Cloudflare zone for {hostname}')
            zone_id = str(zone.get('id', ''))

            params = {'type': record_type, 'name': hostname}
            records = _result_list(await self._send(
                session, 'get', f'{_API}/zones/{zone_id}/dns_records',
                params=params))
            if not records:
                raise TetherError(f'record {hostname} ({record_type}) not found')
            record_id = str(records[0].get('id', ''))

            body = {
                'type': record_type,
                'name': hostname,
                'content': ip,
                'proxied': config.proxied,
                'ttl': config.ttl,
            }
            await self._send(
                session, 'put',
                f'{_API}/zones/{zone_id}/dns_records/{record_id}', json=body)
        return ip
