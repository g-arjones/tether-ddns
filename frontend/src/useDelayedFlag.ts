import { useEffect, useState } from 'react';

// True only after `active` has stayed true continuously for `delayMs`.
export function useDelayedFlag(active: boolean, delayMs: number): boolean {
  const [flag, setFlag] = useState(false);

  useEffect(() => {
    if (!active) {
      setFlag(false);
      return;
    }
    const timer = setTimeout(() => { setFlag(true); }, delayMs);
    return () => { clearTimeout(timer); };
  }, [active, delayMs]);

  return flag;
}
