# Domain Status Consistency Fix — Design

**Date:** 2026-07-11
**Status:** Approved

## Problem

A domain's status badge conflates two orthogonal concerns:

1. **Freshness** — is the DNS record up to date with the current public IP
   (`synced` / `pending` / `error`)?
2. **Auto-update** — is the scheduler allowed to push updates for this domain
   (`enabled` / disabled)?

Today, disabled domains are forced to the `paused` status, which hides
freshness entirely. Concretely:

- `RuntimeState.rebuild()` sets disabled domains to `'paused'`
  ([runtime.py](../../../tether_ddns/runtime.py)) and resets every domain's
  runtime (wiping `ip`/`updated`) on any config edit.
- `Scheduler.sync_ips()` does `if not domain.enabled: continue`
  ([scheduler.py](../../../tether_ddns/scheduler.py)), so disabled domains are
  never re-evaluated after an IP change.
- The frontend forces the badge to `paused` whenever `!domain.enabled`
  (`DomainCard.tsx`, `App.tsx`), overriding the real status.

The play/pause button already communicates auto-update state, so the badge
should always communicate freshness — `synced`, `pending`, or `error` —
regardless of whether auto-update is on.

## Goal

Make the status badge always reflect freshness. Remove the `paused` status.
For disabled domains, compute freshness cheaply by comparing the last-known
assigned IP against the current public IP — never by pushing an update.

## Decisions

- **Freshness source:** compare `runtime.ip` (last assigned IP) to the current
  public IP for the domain's family. Equal and known → `synced`; unknown or
  differing → `pending`. No network calls, no provider reads.
- **Remove `paused`:** `Status` becomes
  `Literal['synced', 'pending', 'error', 'updating']`. Enabled/disabled is
  config state, surfaced only by the play/pause button.
- **Preserve runtime on rebuild:** `rebuild()` keeps `ip`/`updated` for domain
  ids that still exist; only brand-new ids start fresh. This stops one domain's
  edit from wiping others' history.
- **Enabled statuses stay authoritative:** freshness recompute never overwrites
  an enabled domain's `error` or an in-flight `updating`. It only sets
  `synced`/`pending`.

## Design

### 1. Runtime model (`tether_ddns/runtime.py`)

- Change `Status` to `Literal['synced', 'pending', 'error', 'updating']`
  (drop `'paused'`).
- Add a module-level helper:

```python
def freshness(assigned_ip: str | None, current_ip: str | None) -> Status:
    """Return 'synced' when the assigned IP matches the current public IP."""
    if assigned_ip is not None and assigned_ip == current_ip:
        return 'synced'
    return 'pending'
```

- Add a method that recomputes a domain's freshness without pushing, used for
  disabled domains and rebuild:

```python
def set_freshness(self, domain_id: str, current_ip: str | None) -> None:
    """Recompute a domain's status from freshness, preserving ip/updated.

    Only transitions between 'synced' and 'pending'; never clobbers 'error'
    or 'updating'.
    """
    current = self.domains.get(domain_id)
    if current is None or current.status in ('error', 'updating'):
        return
    current.status = freshness(current.ip, current_ip)
    self._emit()
```

- Rewrite `rebuild()` to merge instead of reset:

```python
def rebuild(self, cfg: AppConfig) -> None:
    """Reset domain runtimes from configuration, preserving known history."""
    previous = self.domains
    self.domains = {}
    for d in cfg.domains:
        prior = previous.get(d.id)
        if prior is not None:
            self.domains[d.id] = prior
        else:
            self.domains[d.id] = DomainRuntime(id=d.id, status='pending')
    self._emit()
```

(Freshness for surviving domains is recomputed by the scheduler's next
`sync_ips`/`check_once`; a brand-new domain starts `pending`.)

### 2. Scheduler (`tether_ddns/scheduler.py`)

In `sync_ips`, replace the `if not domain.enabled: continue` skip so disabled
domains get a freshness recompute instead of a push:

```python
    for domain in cfg.domains:
        family = _family_for(domain.record_type)
        ip = by_family[family]
        if not domain.enabled:
            state.set_freshness(domain.id, ip)
            continue
        if ip is None:
            continue
        runtime = state.domains.get(domain.id)
        needs_retry = (cfg.settings.retry_on_failure and runtime is not None
                       and runtime.status == 'error')
        is_fresh = runtime is None or runtime.status == 'pending'
        if family in changed or is_fresh or needs_retry:
            await sync_domain(domain, ip, state)
```

Enabled behavior is unchanged. Disabled domains never call `sync_domain`, so
they never enter `updating` or `error`.

### 3. Frontend (`frontend/src/`)

- `DomainCard.tsx`: remove the `const status = domain.enabled ? runtime.status
  : 'paused'` override — render `runtime.status` directly. Remove the `paused`
  entry from `STATUS_META`.
- `App.tsx`: in the stats `useMemo`, remove the `: 'paused'` override —
  use `rt?.status ?? 'pending'` for all domains.
- `styles.css`: remove the `.st-paused` rules.
- `types.ts`: `DomainState.status` is typed as `string`, so no change needed.

The play/pause button remains the sole enabled/disabled indicator.

## Testing

- **Runtime:** `freshness()` returns `synced`/`pending` correctly; `rebuild()`
  preserves `ip`/`updated` for surviving ids and starts new ids at `pending`;
  `set_freshness()` flips synced↔pending but leaves `error`/`updating` intact.
- **Scheduler:** after an IP change, a disabled domain whose assigned IP no
  longer matches becomes `pending`; a disabled domain still matching stays
  `synced`; an enabled domain in `error` is not overwritten by freshness.
- **Frontend:** `DomainCard` renders the real status for a disabled domain
  (not `Paused`); stats count disabled domains by real status.

## Non-goals

- No provider DNS read/query for freshness.
- No change to the persisted config format.
- No change to hooks (the new hook events are a separate spec).
