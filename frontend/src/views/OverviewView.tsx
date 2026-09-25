import type { JSX } from 'react';
import type { StateSnapshot, Settings, DomainConfig, IncidentWindow, HealthchecksProject } from '../types';
import { StatCard } from '../components/StatCard';
import { HeartbeatCard } from '../components/HeartbeatCard';
import { IpReadoutPanel } from '../components/IpReadoutPanel';
import { ReachabilityPanel } from '../components/ReachabilityPanel';
import { RecordHealthPanel } from '../components/RecordHealthPanel';
import { HealthchecksPanel } from '../components/HealthchecksPanel';
import type { DayBucket } from '../utils';
import { IconGlobe, IconCheckCircle, IconAlertTriangle } from '../components/icons';

export interface OverviewViewProps {
  snapshot: StateSnapshot | null;
  domains: DomainConfig[];
  projects: HealthchecksProject[];
  settings: Settings | null;
  incidentWindow: IncidentWindow | null;
  dayBuckets: DayBucket[];
  nowMs: number;
  onSelectDay: (dayStart: number) => void;
  onPing: () => Promise<void>;
}

export function OverviewView(
  {
    snapshot, domains, projects, settings, incidentWindow, dayBuckets, nowMs, onSelectDay, onPing,
  }: OverviewViewProps,
): JSX.Element {
  // Null-safe defaults
  const reachability = snapshot?.reachability ?? { since: 0, rev: 0, ongoing: null, history: [], latest: [] };
  const ipv4 = snapshot?.public_ipv4 ?? null;
  const ipv6 = snapshot?.public_ipv6 ?? null;
  const ipv4ChangedAt = snapshot?.ipv4_changed_at ?? null;
  const ipv6ChangedAt = snapshot?.ipv6_changed_at ?? null;
  const ipSource = settings?.ip_source ?? '';
  const nextCheckAt = snapshot?.next_check_at ?? null;
  const checkInterval = settings?.check_interval ?? 0;
  const runtimeDomains = snapshot?.domains ?? [];

  // Build enabledById from domains config
  const enabledById: Record<string, boolean> = {};
  for (const d of domains) {
    enabledById[d.id] = d.enabled;
  }

  // Compute stats
  const total = domains.length;
  const providers = new Set(domains.map((d) => d.provider)).size;

  let synced = 0;
  let needsUpdate = 0;
  for (const d of domains) {
    const runtime = runtimeDomains.find((r) => r.id === d.id);
    if (runtime?.status === 'synced') synced += 1;
    if (runtime?.status === 'pending' || runtime?.status === 'error') needsUpdate += 1;
  }

  // Icons from mockup
  const globeIcon = <IconGlobe />;

  const checkIcon = <IconCheckCircle />;

  const warnIcon = <IconAlertTriangle />;

  return (
    <>
      <div className="stats">
        <StatCard label="Total Domains" value={total} sub={`Across ${providers} ${providers === 1 ? 'provider' : 'providers'}`} tint="tint-accent" icon={globeIcon} />
        <StatCard label="Synced" value={synced} sub="Records up to date" tint="tint-ok" icon={checkIcon} />
        <StatCard label="Needs Update" value={needsUpdate} sub="Pending or errored" tint={needsUpdate > 0 ? 'tint-warn' : 'tint-ok'} icon={warnIcon} />
        <HeartbeatCard
          status={snapshot?.heartbeat ?? null}
          url={settings?.heartbeat_url ?? null}
          interval={settings?.heartbeat_interval ?? 300}
          onPing={onPing}
        />
      </div>
      <div className="ov-grid">
        <HealthchecksPanel projects={projects} runtime={snapshot?.healthchecks} nowMs={nowMs} />
        <IpReadoutPanel ipv4={ipv4} ipv6={ipv6} ipv4ChangedAt={ipv4ChangedAt} ipv6ChangedAt={ipv6ChangedAt} ipSource={ipSource} />
        <RecordHealthPanel domains={runtimeDomains} enabledById={enabledById} nextCheckAt={nextCheckAt} checkInterval={checkInterval} />
        <div className="panel ov-wide">
          <ReachabilityPanel
            reachability={reachability}
            incidentWindow={incidentWindow}
            buckets={dayBuckets}
            nowMs={nowMs}
            onSelectDay={onSelectDay}
          />
        </div>
      </div>
    </>
  );
}
