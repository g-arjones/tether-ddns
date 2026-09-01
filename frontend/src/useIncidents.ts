import { useEffect, useState } from 'react';
import { getIncidents } from './api';
import type { IncidentWindow } from './types';

// Refetches whenever `rev` or `generation` changes. The effect dependency uses
// Object.is, so a server restart that resets rev to a lower number still refetches.
// `generation` advances on every websocket reopen, making a reconnect a full resync.
export function useIncidents(rev: number, generation: number): IncidentWindow | null {
  const [data, setData] = useState<IncidentWindow | null>(null);

  useEffect(() => {
    let cancelled = false;
    getIncidents()
      .then((w) => { if (!cancelled) setData(w); })
      .catch(() => { if (!cancelled) setData(null); });
    return () => { cancelled = true; };
  }, [rev, generation]);

  return data;
}
