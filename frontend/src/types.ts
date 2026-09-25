export interface Provider { key: string; display_name: string; schema: Record<string, unknown>; }
export interface HookEventDef { key: string; label: string; }
export interface HookDef { key: string; display_name: string; events: HookEventDef[]; schema: Record<string, unknown>; }
export interface DomainState { id: string; status: string; ip: string | null; updated: number | null; message: string; }
export interface Settings {
  check_interval: number; ip_source: string; update_on_startup: boolean; retry_on_failure: boolean; notify: boolean;
  heartbeat_url: string | null; heartbeat_interval: number;
}
export interface HeartbeatStatus { at: number; ok: boolean; skipped: boolean; error: string | null; }
export interface LogEntry { time: number; level: string; logger: string; message: string; }

export interface ResolverProbe { ip: string; ok: boolean; latency_ms: number | null; }
export interface CheckRecord { ts: number; successes: number; total: number; }

export type Severity = 'degraded' | 'outage';

export interface Incident {
  start: number;
  end: number | null;
  severity: Severity;
  min_successes: number;
  total: number;
  failed: string[];
}

export interface IncidentWindow {
  monitoring_since: number;
  rev: number;
  incidents: Incident[];
  ongoing: Incident | null;
}

export interface Reachability {
  since: number;
  rev: number;
  ongoing: Incident | null;
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
  heartbeat?: HeartbeatStatus | null;
  reachability: Reachability;
  domains: DomainState[];
  // Present on the REST /api/state payload; absent from the /api/ws state
  // frame (settings are fetched separately; logs arrive as their own frames).
  settings?: Settings;
  logs?: LogEntry[];
  // Optional: fixtures and older servers omit it — always read `snapshot?.healthchecks?.[id]`.
  healthchecks?: Record<string, ProjectRuntime>;
}

export type CheckState = 'new' | 'up' | 'grace' | 'down' | 'paused';
export interface HealthcheckRef { key: string; name: string; slug: string; visible: boolean; }
export interface HealthchecksProject {
  id: string;
  name: string;
  base_url: string;
  api_key: string;
  poll_interval: number;
  show_on_overview: boolean;
  fetched_at: number | null;
  checks: HealthcheckRef[];
}
export interface HealthchecksInput {
  name: string;
  base_url: string;
  api_key: string;
  poll_interval: number;
  show_on_overview?: boolean;
}
export interface CheckStatus {
  name: string;
  slug: string;
  status: CheckState;
  last_ping: number | null;
  next_ping: number | null;
  timeout: number | null;
  schedule: string | null;
  tz: string | null;
  grace: number;
}
export interface ProjectRuntime {
  polled_at: number | null;
  ok: boolean;
  error: string | null;
  offline: boolean;
  checks: Record<string, CheckStatus>;
}

export interface DomainConfig { id: string; hostname: string; provider: string; record_type: string; enabled: boolean; provider_config?: Record<string, unknown>; }
export interface HookConfig { id: string; hook: string; events: string[]; config?: Record<string, unknown>; }
export interface AboutInfo {
  app: { name: string; version: string; description: string };
  backend: { name: string; version: string }[];
}
