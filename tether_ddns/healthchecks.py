"""Read-only client for the Healthchecks Management API v3."""
from __future__ import annotations

from datetime import datetime
from typing import Literal

import aiohttp

from pydantic import BaseModel, ConfigDict, ValidationError

from tether_ddns.logging_setup import describe_exception
from tether_ddns.runtime import CheckState, CheckStatus

ErrorField = Literal['api_key', 'base_url']
_TIMEOUT = aiohttp.ClientTimeout(total=10)


class HealthchecksError(Exception):
    """A failed Healthchecks request, worded for the operator."""

    def __init__(self, message: str, field: ErrorField = 'base_url') -> None:
        """Store the message and the form field it should be reported on."""
        super().__init__(message)
        self.field: ErrorField = field


class RemoteCheck(CheckStatus):
    """One upstream check, keyed by its read-only ``unique_key``."""

    key: str


class _RawCheck(BaseModel):
    model_config = ConfigDict(extra='ignore')

    name: str
    slug: str = ''
    status: CheckState
    last_ping: datetime | None = None
    next_ping: datetime | None = None
    timeout: int | None = None
    schedule: str | None = None
    tz: str | None = None
    grace: int
    unique_key: str | None = None
    uuid: str | None = None


class _ChecksResponse(BaseModel):
    model_config = ConfigDict(extra='ignore')

    checks: list[_RawCheck]


def checks_url(base_url: str) -> str:
    """Return the list-checks endpoint for a Healthchecks base URL."""
    base = base_url.rstrip('/')
    return f'{base}/api/v3/checks/'


def _stamp(value: datetime | None) -> float | None:
    return value.timestamp() if value is not None else None


def _raise_for_status(status: int) -> None:
    if status == 401:
        raise HealthchecksError('401 Unauthorized — API key invalid or revoked', 'api_key')
    if status == 429:
        raise HealthchecksError('429 Rate limited')
    if not 200 <= status < 300:
        raise HealthchecksError(f'HTTP {status}')


def _parse(body: object) -> list[RemoteCheck]:
    try:
        raw = _ChecksResponse.model_validate(body).checks
    except ValidationError as exc:
        raise HealthchecksError('Unexpected response') from exc
    if any(c.uuid is not None for c in raw):
        raise HealthchecksError('Use a read-only API key', 'api_key')
    checks: list[RemoteCheck] = []
    for c in raw:
        if c.unique_key is None:
            raise HealthchecksError('Unexpected response')
        checks.append(RemoteCheck(
            key=c.unique_key, name=c.name, slug=c.slug, status=c.status,
            last_ping=_stamp(c.last_ping), next_ping=_stamp(c.next_ping),
            timeout=c.timeout, schedule=c.schedule, tz=c.tz, grace=c.grace))
    return checks


async def list_checks(base_url: str, api_key: str) -> list[RemoteCheck]:
    """Return every check visible to a read-only key; raise HealthchecksError on failure."""
    try:
        async with aiohttp.ClientSession(timeout=_TIMEOUT) as session:
            async with session.get(
                    checks_url(base_url), headers={'X-Api-Key': api_key},
                    allow_redirects=False) as resp:
                _raise_for_status(resp.status)
                body: object = await resp.json(content_type=None)
    except (aiohttp.ClientError, TimeoutError) as exc:
        raise HealthchecksError(f'Unreachable: {describe_exception(exc)}') from exc
    except ValueError as exc:
        raise HealthchecksError('Unexpected response') from exc
    return _parse(body)
