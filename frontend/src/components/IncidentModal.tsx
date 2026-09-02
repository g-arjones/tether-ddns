import type { JSX } from 'react';
import type { Incident } from '../types';
import { formatDuration, type DayBucket } from '../utils';
import { Modal } from './Modal';

export interface IncidentModalProps {
  bucket: DayBucket | null;
  nowMs: number;
  onClose: () => void;
}

function clock(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString(undefined, {
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

function range(inc: Incident, bucket: DayBucket): string {
  const from = clock(Math.max(inc.start, bucket.start));
  if (inc.end === null) return `${from} → now`;
  return `${from} → ${clock(Math.min(inc.end, bucket.end))}`;
}

function spanSeconds(inc: Incident, bucket: DayBucket, nowSec: number): number {
  const start = Math.max(inc.start, bucket.start);
  const end = Math.min(inc.end ?? nowSec, bucket.end);
  return Math.max(0, end - start);
}

export function IncidentModal({ bucket, nowMs, onClose }: IncidentModalProps): JSX.Element {
  const nowSec = nowMs / 1000;
  const heading = bucket
    ? new Date(bucket.start * 1000).toLocaleDateString(undefined, {
      weekday: 'long', day: 'numeric', month: 'long',
    })
    : '';
  const span = bucket ? bucket.end - bucket.start : 1;
  const observed = bucket ? bucket.observedEnd - bucket.start : 0;
  const pct = bucket && observed > 0
    ? (((observed - bucket.offlineSeconds) / observed) * 100).toFixed(1)
    : '100.0';

  return (
    <Modal open={bucket !== null} title={heading} onClose={onClose}>
      {bucket && (
        <>
          <div className="inc-summary">
            <div><span className="inc-k">Uptime</span><span className="inc-v">{pct}%</span></div>
            <div><span className="inc-k">Offline</span><span className="inc-v">{formatDuration(bucket.offlineSeconds)}</span></div>
            <div><span className="inc-k">Degraded</span><span className="inc-v">{formatDuration(bucket.degradedSeconds)}</span></div>
          </div>
          <div>
            <div className="inc-label">Day timeline</div>
            <div className="inc-track">
              {bucket.observedEnd < bucket.end && (
                <b
                  className="future"
                  style={{
                    left: `${((bucket.observedEnd - bucket.start) / span) * 100}%`,
                    width: `${((bucket.end - bucket.observedEnd) / span) * 100}%`,
                  }}
                />
              )}
              {bucket.incidents.map((inc, i) => {
                const from = Math.max(inc.start, bucket.start);
                const to = Math.min(inc.end ?? nowSec, bucket.end);
                const left = ((from - bucket.start) / span) * 100;
                const width = Math.max(0.4, ((to - from) / span) * 100);
                return (
                  <b
                    key={`${inc.start}-${i}`}
                    className={inc.severity}
                    style={{ left: `${left}%`, width: `${width}%` }}
                  />
                );
              })}
            </div>
            <div className="inc-ticks"><span>00</span><span>06</span><span>12</span><span>18</span><span>24</span></div>
          </div>
          {bucket.incidents.length === 0 && (
            <p className="modal-blurb">No incidents recorded on this day.</p>
          )}
          {bucket.incidents.map((inc, i) => (
            <div className="inc-row" key={`${inc.start}-row-${i}`}>
              <span className={`inc-pip ${inc.severity}`} />
              <div className="inc-main">
                <div className="inc-time">{range(inc, bucket)}</div>
                <div className="inc-meta">
                  <span className={`inc-tag ${inc.severity}`}>{inc.severity}</span>
                  {` worst ${inc.min_successes}/${inc.total}`}
                  {inc.start < bucket.start ? ' · started the previous day' : ''}
                </div>
                <div className="inc-meta">
                  {inc.failed.map((ip) => <span className="inc-chip" key={ip}>{ip}</span>)}
                </div>
              </div>
              <span className="inc-dur">{formatDuration(spanSeconds(inc, bucket, nowSec))}</span>
            </div>
          ))}
        </>
      )}
    </Modal>
  );
}
