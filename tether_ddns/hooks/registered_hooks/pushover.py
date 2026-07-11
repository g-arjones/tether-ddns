"""Hook that sends Pushover notifications for domain-update events."""
from __future__ import annotations

from typing import Annotated

import aiohttp

from pydantic import BaseModel, SecretStr

from tether_ddns.hooks.base import (
    DomainUpdateErrorEvent,
    DomainUpdatePendingEvent,
    DomainUpdateSuccessEvent,
    Hook,
    register_hook,
)
from tether_ddns.schema_fields import labeled_field

API_URL = 'https://api.pushover.net/1/messages.json'


class PushoverConfig(BaseModel):
    """Configuration for the Pushover hook."""

    token: Annotated[SecretStr, labeled_field(title='API Token')]
    user: Annotated[SecretStr, labeled_field(title='User Key')]


@register_hook
class PushoverHook(Hook):
    """Sends Pushover notifications for domain-update events."""

    key = 'pushover'
    display_name = 'Pushover'
    ConfigModel = PushoverConfig

    async def on_domain_update_success(
            self, event: DomainUpdateSuccessEvent, config: BaseModel) -> None:
        """Send a success notification."""
        assert isinstance(config, PushoverConfig)
        await self._send(
            config, event.hostname,
            f'Updated {event.hostname} {event.record_type} -> {event.ip}', 0)

    async def on_domain_update_pending(
            self, event: DomainUpdatePendingEvent, config: BaseModel) -> None:
        """Send a staleness notification."""
        assert isinstance(config, PushoverConfig)
        await self._send(
            config, event.hostname,
            f'{event.hostname} {event.record_type} is stale '
            f'(current IP {event.current_ip})', 0)

    async def on_domain_update_error(
            self, event: DomainUpdateErrorEvent, config: BaseModel) -> None:
        """Send a high-priority failure notification."""
        assert isinstance(config, PushoverConfig)
        await self._send(
            config, event.hostname,
            f'Failed to update {event.hostname} {event.record_type}: '
            f'{event.message}', 1)

    async def _send(
            self, config: PushoverConfig, title: str, message: str,
            priority: int) -> None:
        """POST a message to the Pushover API, raising on failure."""
        data = {
            'token': config.token.get_secret_value(),
            'user': config.user.get_secret_value(),
            'title': title,
            'message': message,
            'priority': priority,
        }
        async with aiohttp.ClientSession() as session:
            async with session.post(API_URL, data=data) as resp:
                status = resp.status
                body = await resp.json()
        if status != 200 or body.get('status') != 1:
            raise RuntimeError(
                f'Pushover API error (HTTP {status}): '
                f'{body.get("errors", body.get("status"))}')
