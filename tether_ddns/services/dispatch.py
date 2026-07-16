"""Hook event dispatch as a context-owning service."""
from __future__ import annotations

from tether_ddns.config_store import HookConfig
from tether_ddns.context import AppContext
from tether_ddns.hooks.base import EVENT_SPECS, HOOK_REGISTRY, HookEventBase
from tether_ddns.logging_setup import get_logger

_log = get_logger()


class DispatchService:
    """Fires configured hooks for events over a shared AppContext."""

    def __init__(self, ctx: AppContext) -> None:
        """Create a dispatch service bound to a context."""
        self._ctx = ctx

    async def dispatch(self, event_key: str, event: HookEventBase) -> None:
        """Invoke every matching enabled hook, isolating exceptions."""
        for hc in self._ctx.config.hooks:
            cls = HOOK_REGISTRY.get(hc.hook)
            if cls is None:
                _log.warning('Unknown hook %s', hc.hook)
                continue
            if (not hc.enabled or event_key not in hc.events
                    or event_key not in cls.supported_events()):
                continue
            try:
                config = cls.ConfigModel.model_validate(hc.config)
                await cls().handle(event_key, event, config)
            except Exception:  # noqa: BLE001 - hook errors must be contained
                _log.exception('Hook %s failed on %s', hc.hook, event_key)

    async def run_hook_now(self, hook_cfg: HookConfig) -> dict[str, object]:
        """Fire a hook for its enabled+supported events using current state."""
        cls = HOOK_REGISTRY.get(hook_cfg.hook)
        if cls is None:
            _log.warning('Unknown hook %s', hook_cfg.hook)
            return {'ran': 0, 'skipped': list(hook_cfg.events)}
        supported = cls.supported_events()
        ran = 0
        skipped: list[str] = []
        for event_key in hook_cfg.events:
            if event_key not in supported:
                continue
            events = EVENT_SPECS[event_key].model.from_context(self._ctx)
            if not events:
                skipped.append(event_key)
                continue
            for event in events:
                try:
                    config = cls.ConfigModel.model_validate(hook_cfg.config)
                    await cls().handle(event_key, event, config)
                except Exception:  # noqa: BLE001 - hook errors must be contained
                    _log.exception('Hook %s failed on %s', hook_cfg.hook, event_key)
                ran += 1
        return {'ran': ran, 'skipped': skipped}
