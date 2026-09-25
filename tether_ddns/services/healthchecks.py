"""Healthchecks polling and manual fetch as a context-owning service."""
from __future__ import annotations

import time

from tether_ddns.config_store import HealthcheckRef, HealthchecksProject
from tether_ddns.context import AppContext
from tether_ddns.healthchecks import HealthchecksError, RemoteCheck, list_checks
from tether_ddns.logging_setup import get_logger
from tether_ddns.runtime import CheckStatus, ProjectRuntime

_log = get_logger()


def merge_refs(
    existing: list[HealthcheckRef], remote: list[RemoteCheck],
) -> list[HealthcheckRef]:
    """Rebuild the fetched check list: keep visibility, show new, drop removed."""
    visible = {ref.key: ref.visible for ref in existing}
    return [
        HealthcheckRef(key=c.key, name=c.name, slug=c.slug, visible=visible.get(c.key, True))
        for c in remote
    ]


class HealthchecksService:
    """Polls project status on schedule and rebuilds check lists on demand."""

    def __init__(self, ctx: AppContext) -> None:
        """Create a service bound to a context."""
        self._ctx = ctx

    def _project(self, project_id: str) -> HealthchecksProject | None:
        return next((p for p in self._ctx.config.healthchecks if p.id == project_id), None)

    async def validate(self, base_url: str, api_key: str) -> list[RemoteCheck]:
        """Return the project's checks, raising HealthchecksError if unusable."""
        return await list_checks(base_url, api_key)

    def record_success(self, project: HealthchecksProject, remote: list[RemoteCheck]) -> None:
        """Store a successful poll result, filtered to the fetched checks."""
        runtime = self._ctx.runtime
        previous = runtime.healthchecks.get(project.id)
        known = {ref.key for ref in project.checks}
        checks = {
            c.key: CheckStatus.model_validate(c.model_dump(exclude={'key'}))
            for c in remote if c.key in known}
        runtime.set_project_runtime(
            project.id, ProjectRuntime(polled_at=time.time(), ok=True, checks=checks))
        if previous is not None and previous.error is not None:
            _log.info('Healthchecks "%s": polling recovered', project.name)

    async def poll(self, project_id: str) -> None:
        """Refresh one project's status; skip while offline."""
        project = self._project(project_id)
        if project is None:
            return
        runtime = self._ctx.runtime
        if not runtime.online:
            runtime.set_healthchecks_offline([project_id])
            return
        try:
            remote = await list_checks(str(project.base_url), project.api_key)
        except HealthchecksError as exc:
            previous = runtime.healthchecks.get(project_id)
            if previous is None:
                previous = ProjectRuntime()
            runtime.set_project_runtime(project_id, ProjectRuntime(
                polled_at=time.time(), ok=False, error=str(exc), checks=previous.checks))
            if previous.error is None:
                _log.warning('Healthchecks "%s": %s', project.name, exc)
            return
        self.record_success(project, remote)

    async def fetch(self, project_id: str) -> HealthchecksProject:
        """Rebuild a project's check list from upstream and persist it."""
        project = self._project(project_id)
        if project is None:
            raise LookupError(project_id)
        remote = await list_checks(str(project.base_url), project.api_key)
        project.checks = merge_refs(project.checks, remote)
        project.fetched_at = time.time()
        self._ctx.persist()
        self.record_success(project, remote)
        return project

    def mark_offline(self) -> None:
        """Flag every project as paused by an outage."""
        self._ctx.runtime.set_healthchecks_offline(
            [p.id for p in self._ctx.config.healthchecks])

    async def poll_all(self) -> None:
        """Poll every configured project once (used when the link comes back)."""
        for project in list(self._ctx.config.healthchecks):
            await self.poll(project.id)
