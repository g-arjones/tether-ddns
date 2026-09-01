import type { JSX } from 'react';
import type { ConnectionStatus } from '../liveConnection';

export interface ConnectionOverlayProps {
  status: ConnectionStatus;
  visible: boolean;
}

export function ConnectionOverlay({ status, visible }: ConnectionOverlayProps): JSX.Element {
  const label = status === 'connecting' ? 'Connecting…' : 'Reconnecting…';
  return (
    <div className={`conn-overlay${visible ? ' conn-open' : ''}`} aria-hidden={!visible}>
      <div className="conn-card">
        <span className="conn-spinner" />
        <span className="conn-label" role="status" aria-live="polite">
          {visible ? label : ''}
        </span>
      </div>
    </div>
  );
}
