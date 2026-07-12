import { useEffect, useState, type JSX } from 'react';
import type { AboutInfo } from '../types';
import { getAbout } from '../api';

const BACKEND_ORDER = [
  'python', 'apscheduler', 'fastapi', 'pydantic',
  'aiodns', 'aiohttp', 'uvicorn', 'websockets',
] as const;

const FRONTEND_ROWS: [string, string][] = [
  ['React', __REACT_VERSION__],
  ['Vite', __VITE_VERSION__],
  ['TypeScript', __TS_VERSION__],
];

function Row({ name, version }: { name: string; version: string }): JSX.Element {
  return (
    <div className="about-row">
      <span className="about-name">{name}</span>
      <span className="about-ver">{version}</span>
    </div>
  );
}

export function AboutView(): JSX.Element {
  const [about, setAbout] = useState<AboutInfo | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    getAbout()
      .then((info) => { if (active) setAbout(info); })
      .catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, []);

  return (
    <>
      <div className="section-head"><h3>About</h3></div>
      <div className="panel about-header">
        <h2>{about?.app.name ?? 'Tether'}</h2>
        <span className="about-ver">v{about?.app.version ?? '—'}</span>
        <p className="about-desc">{about?.app.description ?? ''}</p>
      </div>
      <div className="settings-grid">
        <div className="panel">
          <div className="sg-title">Backend</div>
          {failed && <div className="about-error">Couldn&apos;t load version info.</div>}
          {BACKEND_ORDER.map((k) => (
            <Row key={k} name={k} version={about?.backend[k] ?? '—'} />
          ))}
        </div>
        <div className="panel">
          <div className="sg-title">Frontend</div>
          {FRONTEND_ROWS.map(([name, version]) => (
            <Row key={name} name={name} version={version} />
          ))}
        </div>
      </div>
    </>
  );
}
