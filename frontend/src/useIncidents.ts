import { useEffect, useState } from 'react';
import { getIncidents } from './api';
import type { IncidentWindow } from './types';

// Refetches whenever `rev` changes value. The effect dependency uses Object.is,
// so a server restart that resets rev to a lower number still refetches.
export function useIncidents(rev: number): IncidentWindow | null {
  const [data, setData] = useState<IncidentWindow | null>(null);

  useEffect(() => {
    let cancelled = false;
    getIncidents()
      .then((w) => { if (!cancelled) setData(w); })
      .catch(() => { if (!cancelled) setData(null); });
    return () => { cancelled = true; };
  }, [rev]);

  return data;
}
