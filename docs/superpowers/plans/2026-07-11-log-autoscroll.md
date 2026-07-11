# Log Viewer Auto-Scroll — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The log viewer follows new logs by auto-scrolling to the bottom, unless the user has scrolled up.

**Architecture:** Extract the log list into a small `LogViewer` component that manages a ref + `stickToBottom` flag and auto-scrolls on new logs; render it from `App`.

**Tech Stack:** React + TypeScript + Vitest.

## Global Constraints

- Frontend must pass `npm run lint`, `npm run build` (tsc), and `npx vitest run`.
- No backend change. Keep `data-testid="log-viewer"` on the scroll container.
- Follow only when within 40px of the bottom; initial state follows.

---

### Task 1: LogViewer component with follow behavior

**Files:**
- Create: `frontend/src/components/LogViewer.tsx`
- Test: `frontend/src/components/LogViewer.test.tsx`
- Modify: `frontend/src/App.tsx`

**Interfaces:**
- Produces: `LogViewer({ logs }: { logs: LogEntry[] })` rendering the existing
  `.log-viewer` markup (with `data-testid="log-viewer"`), following new logs when
  scrolled to the bottom.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/components/LogViewer.test.tsx`:

```typescript
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LogViewer } from './LogViewer';
import type { LogEntry } from '../types';

function makeLogs(n: number): LogEntry[] {
  return Array.from({ length: n }, (_, i) => ({
    time: 1700000000 + i, level: 'INFO', logger: 'tether_ddns', message: `line ${i}`,
  }));
}

describe('LogViewer', () => {
  it('follows to the bottom when at the bottom', () => {
    const { rerender } = render(<LogViewer logs={makeLogs(3)} />);
    const el = screen.getByTestId('log-viewer');
    // jsdom has no layout; simulate a scrolled-to-bottom element.
    Object.defineProperty(el, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(el, 'clientHeight', { value: 200, configurable: true });
    el.scrollTop = 800; // at bottom (1000 - 800 - 200 = 0)
    rerender(<LogViewer logs={makeLogs(6)} />);
    expect(el.scrollTop).toBe(el.scrollHeight);
  });

  it('does not follow when scrolled up', () => {
    const { rerender } = render(<LogViewer logs={makeLogs(3)} />);
    const el = screen.getByTestId('log-viewer');
    Object.defineProperty(el, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(el, 'clientHeight', { value: 200, configurable: true });
    el.scrollTop = 100; // scrolled up (gap 700 > 40)
    el.dispatchEvent(new Event('scroll'));
    rerender(<LogViewer logs={makeLogs(6)} />);
    expect(el.scrollTop).toBe(100);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/components/LogViewer.test.tsx`
Expected: FAIL — module `./LogViewer` does not exist.

- [ ] **Step 3: Implement `LogViewer`**

Create `frontend/src/components/LogViewer.tsx`:

```typescript
import { useEffect, useRef, useState } from 'react';
import type { LogEntry } from '../types';

const FOLLOW_THRESHOLD = 40;

export function LogViewer({ logs }: { logs: LogEntry[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [stick, setStick] = useState(true);

  useEffect(() => {
    const el = ref.current;
    if (el && stick) el.scrollTop = el.scrollHeight;
  }, [logs, stick]);

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    setStick(gap <= FOLLOW_THRESHOLD);
  };

  return (
    <div className="log-viewer" data-testid="log-viewer" ref={ref} onScroll={onScroll}>
      {logs.length === 0 ? (
        <div className="log-empty">Waiting for log records…</div>
      ) : (
        logs.map((log, i) => (
          <div className="log-line" key={i}>
            <span className="log-time">{new Date(log.time * 1000).toLocaleTimeString()}</span>
            <span className={`log-level log-level-${log.level}`}>{log.level}</span>
            <span className="log-msg">{log.message}</span>
          </div>
        ))
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/components/LogViewer.test.tsx`
Expected: PASS.

- [ ] **Step 5: Use `LogViewer` in `App.tsx`**

In `frontend/src/App.tsx`, add the import:

```typescript
import { LogViewer } from './components/LogViewer';
```

Replace the existing `.log-viewer` block:

```tsx
        <div className="section-head" style={{ marginTop: 24 }}>
          <h2>Logs</h2>
        </div>
        <LogViewer logs={logs} />
```

(Remove the old inline `<div className="log-viewer" ...>…</div>` markup.)

- [ ] **Step 6: Verify build, lint, and full frontend suite**

Run:
```bash
cd frontend
npm run build
npm run lint
npx vitest run
```
Expected: build passes (tsc), lint shows no new errors, all tests pass.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/LogViewer.tsx frontend/src/components/LogViewer.test.tsx frontend/src/App.tsx
git commit -m "feat(frontend): log viewer follows new logs (auto-scroll)"
```

---

## Final Verification

- [ ] `cd frontend && npx vitest run` → all pass.
- [ ] Manual: with the server running, watch the log viewer follow new records; scroll up and confirm it stops following until you return to the bottom.
