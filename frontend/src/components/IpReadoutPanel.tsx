import type { JSX } from 'react';
import { relStable } from '../utils';

export interface IpReadoutPanelProps {
  ipv4: string | null; ipv6: string | null;
  ipv4ChangedAt: number | null; ipv6ChangedAt: number | null;
  ipSource: string;
}

export function IpReadoutPanel(p: IpReadoutPanelProps): JSX.Element {
  const rows = [
    { meta: 'IPv4 · A', addr: p.ipv4, since: p.ipv4ChangedAt },
    { meta: 'IPv6 · AAAA', addr: p.ipv6, since: p.ipv6ChangedAt },
  ];
  return (
    <div className="panel">
      <div className="panel-head"><h4>Public IP</h4><span className="sub">dual-stack · {p.ipSource}</span></div>
      <div className="ip-readout">
        {rows.map((r) => (
          <div className="ip-row" key={r.meta}>
            <div><div className="ip-meta">{r.meta}</div><div className="ip-addr">{r.addr ?? '—'}</div></div>
            <div className="ip-since">stable<br />{relStable(r.since)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
