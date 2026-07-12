# Re-verify Domain After Config Change — Design

**Date:** 2026-07-11
**Status:** Approved

**Relates to:** `2026-07-11-domain-status-consistency-design.md` (which made
`rebuild()` preserve runtime status — the change that introduced this gap).

## Problem

`Scheduler.sync_ips` decides whether to push a domain from three signals only:
the detected public IP changed this cycle (`family in changed`), the runtime
status is `pending` (`is_fresh`), or it is `error` + retry (`needs_retry`). There
is **no signal for "the domain's configuration changed."**

Before the status-consistency fix, `rebuild()` reset every enabled domain to
`pending` on any config change, which incidentally forced a re-check. The
consistency fix (correctly) made `rebuild()` preserve runtime status — but
nothing replaced that forced re-check.

**Result:** editing a domain that is currently `synced` — changing its hostname,
provider, record type, or provider config — leaves it showing `synced`, and the
scheduler never re-pushes it until the public IP happens to change. The DNS
record for the new configuration is silently stale.

(The `pending`-enable and `error`+retry paths already work — verified — because
`is_fresh`/`needs_retry` bypass the IP-change check.)

## Goal

When a domain's record-affecting configuration changes, force a re-verification:
`rebuild()` should reset that domain's runtime to `pending` (as if new), while
still preserving the runtime of domains that did not change. Toggling
enable/disable must NOT force a re-check (freshness already handles it).

## Decisions

- **`RuntimeState` remembers each domain's `DomainConfig`** (captured on
  `rebuild`), so the next `rebuild` can detect a change.
- **Change detection = Pydantic value equality**, ignoring `enabled`:
  `prev.model_copy(update={'enabled': new.enabled}) != new`. This is
  secret-correct (`SecretStr` compares real values — and `merge_secrets` has
  already resolved secrets to real values by the time `rebuild` runs), and
  future-proof (new config fields are covered automatically, no field list).
- **On a changed domain, reset to `pending` and clear `ip`** so a renamed record
  does not display the previous record's IP as if current.
- **Enable/disable toggles are not a change** — `enabled` is excluded from the
  comparison; existing freshness handling governs a toggled domain.

## Design

### `tether_ddns/runtime.py`

Add a per-domain config store and use it in `rebuild()`:

```python
class RuntimeState:
    def __init__(self) -> None:
        ...
        self.domains: dict[str, DomainRuntime] = {}
        self._configs: dict[str, DomainConfig] = {}
        self._listeners: list[Listener] = []

    def rebuild(self, cfg: AppConfig) -> None:
        """Reset domain runtimes from configuration, preserving history.

        A domain that is new, or whose record-affecting config changed, starts
        fresh at 'pending'; an unchanged domain keeps its runtime.
        """
        previous = self.domains
        prev_configs = self._configs
        self.domains = {}
        self._configs = {}
        for d in cfg.domains:
            prior_runtime = previous.get(d.id)
            prior_config = prev_configs.get(d.id)
            unchanged = (
                prior_runtime is not None
                and prior_config is not None
                and prior_config.model_copy(
                    update={'enabled': d.enabled}) == d)
            if unchanged:
                self.domains[d.id] = prior_runtime
            else:
                self.domains[d.id] = DomainRuntime(id=d.id, status='pending')
            self._configs[d.id] = d
        self._emit()
```

Notes:
- A brand-new domain (`prior_runtime is None`) falls into the `else` branch →
  fresh `pending` (same as today).
- A changed domain → fresh `DomainRuntime` (default `ip=None`, `status='pending'`).
- `DomainConfig` is imported in `runtime.py` (the module already imports
  `AppConfig` from `tether_ddns.config`; add `DomainConfig`).

No other component changes: the scheduler's existing `is_fresh`
(`status == 'pending'`) branch already pushes a `pending` domain on the next
cycle, so resetting to `pending` is sufficient to trigger the re-push.

## Testing (`test/unit/test_runtime.py`)

- **changed hostname resets:** rebuild with a domain synced (ip set), then
  rebuild with the same id but a new hostname → status `pending`, `ip` is `None`.
- **changed provider_config resets:** same, changing `provider_config`.
- **unchanged preserves:** rebuild twice with identical config → status/ip/updated
  preserved (existing consistency-fix behavior still holds).
- **enable toggle does NOT reset:** domain synced with ip; rebuild with the same
  config but flipped `enabled` → status stays `synced`, `ip` preserved.
- **new domain starts pending:** an added id → `pending`.

Integration (`test/unit/test_scheduler.py`): a domain synced against the current
IP, then its hostname edited (via `rebuild`), then `sync_ips` runs with no IP
change → the provider `update` is called (re-push happens).

## Non-goals

- No change to the API endpoints (they already call `rebuild()` after mutating
  config; the fix lives entirely in `rebuild()`).
- No change to the persisted config format or the frontend.
- No change to hook dispatch.
