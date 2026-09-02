import type { JSX, ReactNode } from 'react';

export interface IconProps {
  strokeWidth?: number;
}

function Svg({ strokeWidth = 2, children }: IconProps & { children: ReactNode }): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

export function IconClose(p: IconProps): JSX.Element {
  return <Svg {...p}><path d="M18 6 6 18M6 6l12 12" /></Svg>;
}

export function IconRefresh(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M23 4v6h-6M1 20v-6h6" />
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
    </Svg>
  );
}

export function IconInfo(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4M12 8h.01" />
    </Svg>
  );
}

// Canonical globe. Rail's brand logo previously drew the same circle as a path
// (`M12 2a10 10 0 1 0 0 20…`); it adopts this encoding in Task 3.
export function IconGlobe(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="10" />
      <path d="M2 12h20M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20z" />
    </Svg>
  );
}

// Canonical hook: the six-element drawing. HooksView's row icon previously
// omitted `M4 16…` and the anchor circle; it adopts this drawing in Task 2.
export function IconHook(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M4 10a10 10 0 0 1 10 10" />
      <path d="M4 16a4 4 0 0 1 4 4" />
      <circle cx="5" cy="19" r="1" />
      <path d="m12 10 4-4a2.83 2.83 0 0 1 4 4l-4 4" />
      <path d="m14 8 3 3" />
      <path d="m9 15 3 3" />
    </Svg>
  );
}

export function IconPlus(p: IconProps): JSX.Element {
  return <Svg {...p}><path d="M12 5v14M5 12h14" /></Svg>;
}

// Canonical edit (Lucide `square-pen`). DomainCard previously appended an extra
// `9.5-9.5z` segment; it adopts this path in Task 2.
export function IconEdit(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z" />
    </Svg>
  );
}

// Canonical trash (Lucide `trash-2`). HooksView previously used a differently
// ordered path; it adopts this one in Task 2.
export function IconTrash(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </Svg>
  );
}

export function IconChevronDown(p: IconProps): JSX.Element {
  return <Svg {...p}><path d="m6 9 6 6 6-6" /></Svg>;
}

export function IconCheck(p: IconProps): JSX.Element {
  return <Svg {...p}><path d="m5 12 5 5L20 7" /></Svg>;
}

export function IconSuccess(p: IconProps): JSX.Element {
  return <Svg {...p}><path d="M20 6 9 17l-5-5" /></Svg>;
}

export function IconError(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="10" />
      <path d="M15 9l-6 6M9 9l6 6" />
    </Svg>
  );
}

export function IconDashboard(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <rect x="3" y="3" width="7" height="9" />
      <rect x="14" y="3" width="7" height="5" />
      <rect x="14" y="12" width="7" height="9" />
      <rect x="3" y="16" width="7" height="5" />
    </Svg>
  );
}

export function IconLogs(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M4 4h16v16H4z" />
      <path d="M8 8h8M8 12h8M8 16h5" />
    </Svg>
  );
}

export function IconSettings(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </Svg>
  );
}

export function IconMoon(p: IconProps): JSX.Element {
  return <Svg {...p}><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" /></Svg>;
}

export function IconSun(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="5" />
      <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
    </Svg>
  );
}

export function IconMenu(p: IconProps): JSX.Element {
  return <Svg {...p}><path d="M3 12h18M3 6h18M3 18h18" /></Svg>;
}

// Solid glyph: overrides the stroked preamble rather than using Svg.
export function IconPlay(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" stroke="none">
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

export function IconSearch(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </Svg>
  );
}

export function IconCheckCircle(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
      <path d="M22 4 12 14.01l-3-3" />
    </Svg>
  );
}

export function IconAlertTriangle(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <path d="M12 9v4M12 17h.01" />
    </Svg>
  );
}

export function IconClock(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v6l4 2" />
    </Svg>
  );
}
