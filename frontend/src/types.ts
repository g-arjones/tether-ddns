export interface Provider { key: string; display_name: string; schema: Record<string, unknown>; }
export interface HookEventDef { key: string; label: string; }
export interface HookDef { key: string; display_name: string; events: HookEventDef[]; schema: Record<string, unknown>; }
export interface DomainState { id: string; status: string; ip: string | null; updated: number | null; message: string; }
export interface Settings { check_interval: number; ip_source: string; update_on_startup: boolean; retry_on_failure: boolean; notify: boolean; }
export interface LogEntry { time: number; level: string; logger: string; message: string; }

export interface ResolverProbe { ip: string; ok: boolean; latency_ms: number | null; }
export interface CheckRecord { ts: number; successes: number; total: number; }
export interface Reachability {
  started_at: number;
  checks: number;
  online: number;
  history: CheckRecord[];
  latest: ResolverProbe[];
}

export interface StateSnapshot {
  public_ipv4: string | null;
  public_ipv6: string | null;
  ipv4_changed_at: number | null;
  ipv6_changed_at: number | null;
  online: boolean;
  next_check_at: number | null;
  reachability: Reachability;
  domains: DomainState[];
  settings: Settings;
  logs: LogEntry[];
}

export interface DomainConfig { id: string; hostname: string; provider: string; record_type: string; enabled: boolean; provider_config?: Record<string, unknown>; }
export interface HookConfig { id: string; hook: string; events: string[]; config?: Record<string, unknown>; }
