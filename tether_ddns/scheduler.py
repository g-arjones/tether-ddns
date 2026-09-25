"""APScheduler-driven periodic jobs delegating sync to SyncService."""
from __future__ import annotations

import contextlib
from datetime import datetime, timezone

from apscheduler.jobstores.base import JobLookupError  # pyright: ignore[reportMissingTypeStubs]
from apscheduler.schedulers.asyncio import (  # pyright: ignore[reportMissingTypeStubs]
    AsyncIOScheduler,
)

from tether_ddns.config_store import HealthchecksProject
from tether_ddns.context import AppContext
from tether_ddns.hooks.base import ReachabilityChangedEvent
from tether_ddns.reachability import ReachabilityProbe
from tether_ddns.runtime import RuntimeState
from tether_ddns.services.dispatch import DispatchService
from tether_ddns.services.healthchecks import HealthchecksService
from tether_ddns.services.heartbeat import HeartbeatService
from tether_ddns.services.sync import SyncService

REACHABILITY_INTERVAL_SECONDS = 30
STATE_FLUSH_INTERVAL_SECONDS = 30


def healthchecks_job_id(project_id: str) -> str:
    """Return the scheduler job id for a healthchecks project."""
    return f'healthchecks:{project_id}'


class Scheduler:
    """Owns the APScheduler instance and periodic checks."""

    def __init__(
        self, ctx: AppContext, sync: SyncService,
        dispatch: DispatchService, reachability: ReachabilityProbe,
        heartbeat: HeartbeatService, *,
        healthchecks: HealthchecksService | None = None,
    ) -> None:
        """Create an unstarted scheduler bound to its services."""
        self._scheduler = AsyncIOScheduler()
        self._ctx = ctx
        self._sync = sync
        self._dispatch = dispatch
        self._reachability = reachability
        self._heartbeat = heartbeat
        self._healthchecks = (
            healthchecks if healthchecks is not None else HealthchecksService(ctx))
        self._last_state_json: str | None = None

    def start(self) -> None:
        """Schedule the reachability, IP-sync, heartbeat and flush jobs and start."""
        self._scheduler.add_job(  # pyright: ignore[reportUnknownMemberType]
            self.check_reachability, 'interval',
            seconds=REACHABILITY_INTERVAL_SECONDS,
            args=[], id='reachability', replace_existing=True,
        )
        self._scheduler.add_job(  # pyright: ignore[reportUnknownMemberType]
            self.sync_ips, 'interval',
            seconds=self._ctx.config.settings.check_interval,
            args=[], id='sync', replace_existing=True,
        )
        self._scheduler.add_job(  # pyright: ignore[reportUnknownMemberType]
            self.flush_state, 'interval',
            seconds=STATE_FLUSH_INTERVAL_SECONDS,
            args=[], id='state-flush', replace_existing=True,
        )
        self.reschedule_heartbeat(run_now=True)
        for project in self._ctx.config.healthchecks:
            self.schedule_healthchecks(project, run_now=True)
        self._scheduler.start()
        self._publish_next_check(self._ctx.runtime)

    def reschedule_sync(self) -> None:
        """Re-add the sync job with the current check interval and republish."""
        self._scheduler.add_job(  # pyright: ignore[reportUnknownMemberType]
            self.sync_ips, 'interval',
            seconds=self._ctx.config.settings.check_interval,
            args=[], id='sync', replace_existing=True,
        )
        self._publish_next_check(self._ctx.runtime)

    def reschedule_heartbeat(self, *, run_now: bool = False) -> None:
        """(Re-)add the heartbeat job with the current heartbeat interval.

        With ``run_now`` the first tick fires immediately; the offline gate
        inside ``HeartbeatService.run`` still applies.
        """
        if run_now:
            self._scheduler.add_job(  # pyright: ignore[reportUnknownMemberType]
                self._heartbeat.run, 'interval',
                seconds=self._ctx.config.settings.heartbeat_interval,
                args=[], id='heartbeat', replace_existing=True,
                next_run_time=datetime.now(timezone.utc),
            )
        else:
            self._scheduler.add_job(  # pyright: ignore[reportUnknownMemberType]
                self._heartbeat.run, 'interval',
                seconds=self._ctx.config.settings.heartbeat_interval,
                args=[], id='heartbeat', replace_existing=True,
            )

    def schedule_healthchecks(
        self, project: HealthchecksProject, *, run_now: bool = False,
    ) -> None:
        """(Re-)add a project's poll job; ``run_now`` fires the first tick at once."""
        if run_now:
            self._scheduler.add_job(  # pyright: ignore[reportUnknownMemberType]
                self._healthchecks.poll, 'interval',
                seconds=project.poll_interval, args=[project.id],
                id=healthchecks_job_id(project.id), replace_existing=True,
                next_run_time=datetime.now(timezone.utc),
            )
        else:
            self._scheduler.add_job(  # pyright: ignore[reportUnknownMemberType]
                self._healthchecks.poll, 'interval',
                seconds=project.poll_interval, args=[project.id],
                id=healthchecks_job_id(project.id), replace_existing=True,
            )

    def unschedule_healthchecks(self, project_id: str) -> None:
        """Remove a project's poll job if it exists."""
        with contextlib.suppress(JobLookupError):
            self._scheduler.remove_job(  # pyright: ignore[reportUnknownMemberType]
                healthchecks_job_id(project_id))

    def run_startup_check(self) -> None:
        """Schedule one immediate, non-blocking check cycle at startup."""
        self._scheduler.add_job(  # pyright: ignore[reportUnknownMemberType]
            self.check_once, 'date', args=[],
            id='startup', replace_existing=True,
        )

    def flush_state(self) -> None:
        """Persist runtime state to disk only when the payload has changed.

        Skips redundant writes: the reachability telemetry is excluded from the
        persisted model, so a plain reachability tick produces an identical
        payload and no disk write.
        """
        payload = self._ctx.runtime.model_dump_json()
        if payload == self._last_state_json:
            return
        self._ctx.persist_state()
        self._last_state_json = payload

    def shutdown(self) -> None:
        """Flush runtime state and incidents, then stop the scheduler."""
        self.flush_state()
        self._ctx.persist_incidents()
        if self._scheduler.running:
            self._scheduler.shutdown(wait=False)

    def _publish_next_check(self, state: RuntimeState) -> None:
        """Publish the sync job's next fire time to runtime state."""
        sc = self._scheduler
        get = sc.get_job  # pyright: ignore[reportUnknownMemberType,reportUnknownVariableType]
        job = get('sync')  # pyright: ignore[reportUnknownVariableType]
        next_run = (
            getattr(job, 'next_run_time', None)  # pyright: ignore[reportUnknownArgumentType]
            if job else None)
        ts = next_run.timestamp() if next_run else None
        state.set_next_check_at(ts)

    async def check_reachability(self) -> None:
        """Run the DNS-quorum check; fire reachability_changed on transition."""
        state = self._ctx.runtime
        was_online = state.online
        reach = await self._reachability.check()
        view = self._ctx.incidents.record(reach)
        if state.record_reachability(reach, view):
            if reach.online:
                await self._healthchecks.poll_all()
            else:
                self._healthchecks.mark_offline()
            await self._dispatch.dispatch(
                'reachability_changed',
                ReachabilityChangedEvent(
                    online=reach.online, was_online=was_online))

    async def sync_ips(self) -> None:
        """Delegate to SyncService, then republish the next fire time."""
        await self._sync.sync_ips()
        self._publish_next_check(self._ctx.runtime)

    async def check_once(self) -> None:
        """Run reachability then, if online, an IP sync (startup/refresh)."""
        await self.check_reachability()
        if self._ctx.runtime.online:
            await self.sync_ips()
