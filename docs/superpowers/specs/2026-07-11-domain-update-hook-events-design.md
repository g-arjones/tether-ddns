# Domain-Update Hook Events — Design

**Date:** 2026-07-11
**Status:** Approved

**Depends on:**
- `2026-07-11-per-event-hook-methods-design.md` (typed per-event hook methods,
  `EVENT_SPECS`, `supported_events()` inference, `_dispatch`).
- `2026-07-11-domain-status-consistency-design.md` (`freshness()`,
  `set_freshness()`, history-preserving `rebuild()`, `Status` without
  `'paused'`). This spec assumes the consistency fix is implemented first.

## Problem

Hooks can react to `ip_changed` and `reachability_changed`, but not to the
outcome of a domain's DNS update. Operators want to be notified when a domain
becomes stale (pending), when an update succeeds, or when it fails.

## Goal

Add three per-domain, status-transition hook events:

- `domain_update_pending` → `on_domain_update_pending`
- `domain_update_success` → `on_domain_update_success`
- `domain_update_error` → `on_domain_update_error`

They behave like the existing events: the scheduler fires them on real status
transitions, and "Run hook now" fires them from current state.

## Decisions

- **Three distinct payload classes**, each carrying only what its outcome needs
  plus common domain context.
- **Status-transition semantics** (like `ip_changed`/`reachability_changed`):
  the scheduler fires an event only when a domain's status actually changes.
- **Firing mechanics:** `sync_domain` and `set_freshness` *return* their
  outcome; dispatch happens only at the scheduler's `sync_ips` call sites.
  Runtime stays free of any hook dependency.
- **Manual force-update (`POST /domains/{id}/sync`) fires nothing** — it calls
  `sync_domain` but ignores the return value.
- **Disabled domains** only ever fire `domain_update_pending`, and only on the
  transition *to* `pending` via `set_freshness`. They never fire success/error.
- **"Run hook now"** fires, for each domain, only the single event matching that
  domain's *current* runtime status:
  `pending → domain_update_pending`, `error → domain_update_error` (re-emitting
  the stored `runtime.message`), `synced → domain_update_success`;
  `updating` is skipped. This mirrors the "fires regardless of change" behavior
  of the other events while staying truthful to each domain's real state.
- **Success payload has no `message`** field.

## Design

### 1. Event payloads (`tether_ddns/hooks/base.py`)

```python
class DomainUpdatePendingEvent(HookEventBase):
    """A domain's record became stale against the current public IP."""

    domain_id: str
    hostname: str
    record_type: str
    family: Literal['ipv4', 'ipv6']
    current_ip: str | None = None


class DomainUpdateSuccessEvent(HookEventBase):
    """A domain's record was updated to the current public IP."""

    domain_id: str
    hostname: str
    record_type: str
    family: Literal['ipv4', 'ipv6']
    ip: str


class DomainUpdateErrorEvent(HookEventBase):
    """A domain update attempt failed."""

    domain_id: str
    hostname: str
    record_type: str
    family: Literal['ipv4', 'ipv6']
    ip: str | None = None
    message: str
```

### 2. `EVENT_SPECS` + `Hook` methods (`base.py`)

Add three entries to `EVENT_SPECS`:

```python
'domain_update_pending': EventSpec(
    'Domain Update Pending', 'on_domain_update_pending',
    DomainUpdatePendingEvent),
'domain_update_success': EventSpec(
    'Domain Update Success', 'on_domain_update_success',
    DomainUpdateSuccessEvent),
'domain_update_error': EventSpec(
    'Domain Update Error', 'on_domain_update_error',
    DomainUpdateErrorEvent),
```

Add three no-op default methods to `Hook`:

```python
async def on_domain_update_pending(
        self, event: DomainUpdatePendingEvent, config: BaseModel) -> None:
    """Handle a domain becoming stale. Override to react; default no-op."""

async def on_domain_update_success(
        self, event: DomainUpdateSuccessEvent, config: BaseModel) -> None:
    """Handle a successful domain update. Default no-op."""

async def on_domain_update_error(
        self, event: DomainUpdateErrorEvent, config: BaseModel) -> None:
    """Handle a failed domain update. Default no-op."""
```

`supported_events()` inference, `/api/hooks`, and event validation pick these up
automatically (spec 1's 3-point extension pattern).

### 3. Runtime returns transitions (`tether_ddns/runtime.py`)

`set_status` and `set_freshness` return the resulting `Status` when it changed,
or `None` when unchanged, so scheduler callers can detect transitions. Runtime
imports nothing from `hooks`.

```python
def set_status(
    self, domain_id: str, status: Status, *,
    ip: str | None = None, message: str = '',
) -> Status | None:
    current = self.domains.get(domain_id)
    if current is None:
        return None
    changed = current.status != status
    current.status = status
    if ip is not None:
        current.ip = ip
    current.message = message
    current.updated = time.time()
    self._emit()
    return status if changed else None
```

```python
def set_freshness(self, domain_id: str, current_ip: str | None) -> Status | None:
    current = self.domains.get(domain_id)
    if current is None or current.status in ('error', 'updating'):
        return None
    new_status = freshness(current.ip, current_ip)
    if new_status == current.status:
        return None
    current.status = new_status
    self._emit()
    return new_status
```

Note: `set_status` returns the new status whenever it *differs from the prior
status*, including the interim `updating`. The scheduler is responsible for
suppressing the `updating` transition (see below).

### 4. Scheduler dispatch (`tether_ddns/scheduler.py`)

Add three dispatch helpers mirroring the existing ones:

```python
async def dispatch_domain_update_pending(
        event: DomainUpdatePendingEvent, cfg: AppConfig) -> None:
    await _dispatch('domain_update_pending', event, cfg)

async def dispatch_domain_update_success(
        event: DomainUpdateSuccessEvent, cfg: AppConfig) -> None:
    await _dispatch('domain_update_success', event, cfg)

async def dispatch_domain_update_error(
        event: DomainUpdateErrorEvent, cfg: AppConfig) -> None:
    await _dispatch('domain_update_error', event, cfg)
```

`sync_domain` returns its terminal `Status` (`'synced'` | `'error'`), so callers
that want events can act on it. It does NOT dispatch events itself — that keeps
the manual `/sync` path silent.

In `sync_ips`, wrap each domain:

- **Enabled, after `sync_domain`:** if the returned terminal status is
  `'synced'` and differs from the domain's status captured *before* the call,
  dispatch `domain_update_success`; if `'error'` and it differs, dispatch
  `domain_update_error` with `runtime.message`. (Capturing the pre-sync status
  means a re-confirmed `synced`/`error` with no change fires nothing.)
- **Disabled branch:** if `set_freshness` returns `'pending'`, dispatch
  `domain_update_pending`.

Payload construction pulls `domain.id`, `domain.hostname`,
`domain.record_type`, the family (`_family_for(domain.record_type)`), and
`runtime.ip`/`runtime.message`.

### 5. `run_hook_now` (`scheduler.py`)

Extend the event-building loop: for each configured `domain_update_*` event,
iterate `cfg.domains` and, for each domain whose *current* runtime status maps
to that event key, append the matching payload built from current state:

- `runtime.status == 'pending'` → `DomainUpdatePendingEvent(current_ip=<public IP for family>)`
- `runtime.status == 'synced'` → `DomainUpdateSuccessEvent(ip=runtime.ip)`
  (skip if `runtime.ip is None`)
- `runtime.status == 'error'` → `DomainUpdateErrorEvent(ip=runtime.ip, message=runtime.message)`
- `runtime.status == 'updating'` → skip

Only the event key(s) the hook is configured/subscribed for produce jobs, so a
hook listening only to `domain_update_error` fires solely for domains currently
in `error`. If no domain matches a configured event, record it in `skipped`
(consistent with the existing `ip_changed` skip reporting).

### 6. Frontend & docs

- `/api/hooks` already derives its event list from `EVENT_SPECS`, so the hook
  config UI offers the three new events with no frontend code change.
- README "Add a hook" example already demonstrates the override pattern; add a
  one-line mention that the domain-update events exist.

## Testing

- **base:** `supported_events()` includes the three new methods when overridden;
  `EVENT_SPECS` labels present; a hook overriding only `on_domain_update_error`
  supports only that event.
- **runtime:** `set_status` returns the new status on change and `None` when
  unchanged; `set_freshness` returns `pending`/`synced`/`None` appropriately.
- **scheduler (transition):** enabled domain going `pending → synced` fires
  `domain_update_success`; `pending → error` fires `domain_update_error` with
  the message; a re-sync with no status change fires nothing; disabled domain
  `synced → pending` fires `domain_update_pending`; the `updating` interim never
  fires.
- **scheduler (manual):** `POST /domains/{id}/sync` fires no domain-update
  events.
- **run_hook_now:** a hook subscribed to `domain_update_error` fires only for
  domains currently in `error`, re-emitting `runtime.message`; `synced` domains
  fire success with `runtime.ip`; `pending` domains fire pending; unmatched
  configured events are reported in `skipped`.

## Non-goals

- No provider DNS reads.
- No change to persisted config format.
- Domain force-update button remains silent for these events.
