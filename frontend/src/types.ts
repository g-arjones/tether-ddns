export interface Provider { key: string; display_name: string; schema: Record<string, unknown>; }
export interface HookDef { key: string; display_name: string; events: string[]; schema: Record<string, unknown>; }
export interface DomainState { id: string; status: string; ip: string | null; updated: number | null; message: string; }
export interface Settings { check_interval: number; ip_source: string; update_on_startup: boolean; retry_on_failure: boolean; notify: boolean; }
export interface LogEntry { time: number; level: string; logger: string; message: string; }
export interface StateSnapshot { public_ip: string | null; online: boolean; domains: DomainState[]; settings: Settings; logs: LogEntry[]; }
export interface DomainConfig { id: string; hostname: string; provider: string; record_type: string; ttl: string | number; enabled: boolean; provider_config?: Record<string, unknown>; }
export interface HookConfig { id: string; hook: string; events: string[]; config?: Record<string, unknown>; }
