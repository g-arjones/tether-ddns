"""APScheduler-driven periodic jobs delegating sync to SyncService."""
from __future__ import annotations

from apscheduler.schedulers.asyncio import (  # pyright: ignore[reportMissingTypeStubs]
    AsyncIOScheduler,
)

from tether_ddns.context import AppContext
from tether_ddns.hooks.base import ReachabilityChangedEvent
from tether_ddns.reachability import ReachabilityProbe
from tether_ddns.runtime import RuntimeState
from tether_ddns.services.dispatch import DispatchService
from tether_ddns.services.sync import SyncService

REACHABILITY_INTERVAL_SECONDS = 30
STATE_FLUSH_INTERVAL_SECONDS = 30


class Scheduler:
    """Owns the APScheduler instance and periodic checks."""

    def __init__(
        self, ctx: AppContext, sync: SyncService,
        dispatch: DispatchService, reachability: ReachabilityProbe,
    ) -> None:
        """Create an unstarted scheduler bound to context, sync, dispatch, reachability."""
        self._scheduler = AsyncIOScheduler()
        self._ctx = ctx
        self._sync = sync
        self._dispatch = dispatch
        self._reachability = reachability

    def start(self) -> None:
        """Schedule the reachability and IP-sync jobs and start."""
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

    def run_startup_check(self) -> None:
        """Schedule one immediate, non-blocking check cycle at startup."""
        self._scheduler.add_job(  # pyright: ignore[reportUnknownMemberType]
            self.check_once, 'date', args=[],
            id='startup', replace_existing=True,
        )

    def flush_state(self) -> None:
        """Persist the current runtime state to disk."""
        self._ctx.persist_state()

    def shutdown(self) -> None:
        """Flush runtime state, then stop the scheduler."""
        self._ctx.persist_state()
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
        if state.record_reachability(reach):
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
