import { test, expect, type Locator, type Page } from '@playwright/test';

const NOW_S = Date.now() / 1000;
const PROJECT = {
  id: 'p1', name: 'Homelab', base_url: 'https://healthchecks.io/', api_key: '********',
  poll_interval: 120, show_on_overview: true, fetched_at: NOW_S - 3 * 86400,
  checks: [
    { key: 'k-ssl', name: 'SSL (hydrogen)', slug: 'ssl-hydrogen', visible: true },
    { key: 'k-backup', name: 'Backup', slug: 'backup', visible: true },
    { key: 'k-old', name: 'Old job', slug: 'old-job', visible: true },
  ],
};
const check = (name: string, slug: string, status: string, secondsAgo: number) => ({
  name, slug, status, last_ping: NOW_S - secondsAgo, next_ping: null,
  timeout: 86400, schedule: null, tz: null, grace: 3600,
});
const RUNTIME = {
  p1: {
    polled_at: NOW_S - 14, ok: true, error: null, offline: false,
    checks: {
      'k-ssl': check('SSL (hydrogen)', 'ssl-hydrogen', 'down', 130 * 86400),
      'k-backup': check('Backup', 'backup', 'up', 11 * 3600),
    },
  },
};
const MANY_KEYS = Array.from({ length: 24 }, (_, i) => `k${i}`);
const jobName = (i: number) => `Job ${'x'.repeat(i % 7)}${i}`;
const MANY_PROJECT = {
  ...PROJECT,
  checks: MANY_KEYS.map((key, i) => ({ key, name: jobName(i), slug: key, visible: true })),
};
const MANY_RUNTIME = {
  p1: {
    ...RUNTIME.p1,
    checks: Object.fromEntries(MANY_KEYS.map((key, i) => [key, check(jobName(i), key, i === 3 ? 'down' : 'up', 600)])),
  },
};

// The real backend has no projects and cannot reach healthchecks.io, so config comes
// from a REST stub and live status is spliced into every real ws `state` frame.
async function stubHealthchecks(page: Page, project: object = PROJECT, runtime: object = RUNTIME): Promise<void> {
  await page.route('**/api/healthchecks', async (route) => {
    if (route.request().method() === 'GET') await route.fulfill({ json: [project] });
    else await route.fallback();
  });
  await page.routeWebSocket('**/api/ws', (ws) => {
    const server = ws.connectToServer();
    server.onMessage((message) => {
      const frame = JSON.parse(String(message)) as { kind: string; payload: Record<string, unknown> };
      if (frame.kind === 'state') frame.payload.healthchecks = runtime;
      ws.send(JSON.stringify(frame));
    });
  });
}

async function openHealthchecks(page: Page): Promise<void> {
  await page.getByRole('button', { name: /Healthchecks/ }).click();
  await expect(page.getByRole('heading', { name: 'Healthchecks', level: 2 })).toBeVisible();
}

async function measureHead(panel: Locator) {
  return panel.evaluate((el) => {
    const head = el.querySelector('.hcp-head')!.getBoundingClientRect();
    const name = el.querySelector('.hcp-head strong')!.getBoundingClientRect();
    const summary = el.querySelector('.hcp-head .hc-sum')!.getBoundingClientRect();
    const bar = el.querySelector('.hcp-bar')!.getBoundingClientRect();
    return { headWidth: head.width, nameBottom: name.bottom, sumBottom: summary.bottom, barTop: bar.top, barWidth: bar.width };
  });
}

test('a project card expands into its checks table without a trailing divider', async ({ page }) => {
  await stubHealthchecks(page);
  await page.goto('/');
  await openHealthchecks(page);
  const card = page.locator('.hc-card').filter({ hasText: 'Homelab' });
  await expect(card.locator('.hc-sum')).toHaveText('1 up · 1 down · 1 gone · 3 checks');
  await card.getByRole('button', { name: 'Expand Homelab' }).click();
  const rows = card.locator('.hc-table tbody tr');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(2)).toContainText('Not in last poll — Fetch to remove');
  await expect(rows.first().locator('td').first()).toHaveCSS('border-bottom-width', '1px');
  await expect(rows.last().locator('td').first()).toHaveCSS('border-bottom-width', '0px');
});

test('the overview shows healthchecks chips between the stat cards and the IP panel', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await stubHealthchecks(page);
  await page.goto('/');
  const panel = page.locator('.hc-panel');
  await expect(panel.locator('.hcp-chip')).toHaveCount(3);
  await expect(panel.locator('.hcp-chip.hc-down')).toContainText('SSL (hydrogen)');
  await expect(panel.locator('.hcp-chip.hc-gone')).toContainText('Old job');
  await expect(panel.locator('.panel-head .hc-pill.hc-down')).toHaveText('1 down');
  const geometry = await page.evaluate(() => {
    const stats = document.querySelector('.stats')!.getBoundingClientRect();
    const hc = document.querySelector('.hc-panel')!.getBoundingClientRect();
    const ip = document.querySelector('.ov-grid > .hc-panel + .panel')!.getBoundingClientRect();
    return { statsBottom: stats.bottom, hcTop: hc.top, hcBottom: hc.bottom, ipTop: ip.top };
  });
  expect(geometry.hcTop).toBeGreaterThan(geometry.statsBottom);
  expect(geometry.ipTop).toBeGreaterThan(geometry.hcBottom);
  await expect(page.locator('.ov-grid > .hc-panel + .panel')).toContainText('Public IP');
});

// jsdom has no layout engine; only a real browser proves rows fill edge to edge.
test('overview chips fill every wrapped row edge to edge, with the bar inline on desktop', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await stubHealthchecks(page, MANY_PROJECT, MANY_RUNTIME);
  await page.goto('/');
  const panel = page.locator('.hc-panel');
  await expect(panel.locator('.hcp-chip')).toHaveCount(24);
  const layout = await panel.evaluate((el) => {
    const box = el.querySelector('.hcp-chips')!.getBoundingClientRect();
    const byTop = new Map<number, { left: number; right: number }[]>();
    for (const chip of el.querySelectorAll('.hcp-chip')) {
      const r = chip.getBoundingClientRect();
      const key = Math.round(r.top);
      byTop.set(key, [...(byTop.get(key) ?? []), { left: r.left, right: r.right }]);
    }
    const rows = [...byTop.values()].map((rs) => ({
      left: Math.min(...rs.map((r) => r.left)) - box.left,
      right: box.right - Math.max(...rs.map((r) => r.right)),
    }));
    const bar = el.querySelector('.hcp-bar')!.getBoundingClientRect();
    const name = el.querySelector('.hcp-head strong')!.getBoundingClientRect();
    return { rows, barTop: bar.top, nameBottom: name.bottom };
  });
  expect(layout.rows.length).toBeGreaterThan(1);
  for (const row of layout.rows) {
    expect(Math.abs(row.left)).toBeLessThanOrEqual(1);
    expect(Math.abs(row.right)).toBeLessThanOrEqual(1);
  }
  expect(layout.barTop).toBeLessThan(layout.nameBottom);
});

test('on a phone the overview bar gets its own line and nothing overflows the panel', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await stubHealthchecks(page, MANY_PROJECT, MANY_RUNTIME);
  await page.goto('/');
  const panel = page.locator('.hc-panel');
  await expect(panel.locator('.hcp-chip')).toHaveCount(24);
  await expect(panel.locator('.hcp-n-checks')).toBeHidden();
  const head = await measureHead(panel);
  const g = await panel.evaluate((el) => {
    const cs = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    const contentLeft = box.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft);
    const contentRight = box.right - parseFloat(cs.borderRightWidth) - parseFloat(cs.paddingRight);
    const pill = el.querySelector('.panel-head .hc-pill')!.getBoundingClientRect();
    const chips = [...el.querySelectorAll('.hcp-chip')].map((c) => c.getBoundingClientRect());
    return { pillHeight: pill.height, contentLeft, contentRight, minChipLeft: Math.min(...chips.map((c) => c.left)), maxChipRight: Math.max(...chips.map((c) => c.right)) };
  });
  expect(g.pillHeight).toBeLessThan(30);
  expect(head.barTop).toBeGreaterThanOrEqual(Math.max(head.nameBottom, head.sumBottom));
  expect(head.barWidth).toBeGreaterThanOrEqual(0.9 * head.headWidth);
  expect(g.minChipLeft).toBeGreaterThanOrEqual(g.contentLeft - 0.5);
  expect(g.maxChipRight).toBeLessThanOrEqual(g.contentRight + 0.5);
});

test('a narrow overview panel uses the stacked layout in a wide viewport', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await stubHealthchecks(page, MANY_PROJECT, MANY_RUNTIME);
  await page.goto('/');
  await page.addStyleTag({ content: '.hc-panel { max-width: 460px; }' });
  const panel = page.locator('.hc-panel');
  await expect(panel.locator('.hcp-chip')).toHaveCount(24);
  await expect(panel.locator('.hcp-n-checks')).toBeHidden();
  const head = await measureHead(panel);
  expect(head.barTop).toBeGreaterThanOrEqual(Math.max(head.nameBottom, head.sumBottom));
  expect(head.barWidth).toBeGreaterThanOrEqual(0.9 * head.headWidth);
});

test('adding a project shows the upstream error inline', async ({ page }) => {
  await page.route('**/api/healthchecks', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 422,
      json: { detail: [{ loc: ['body', 'api_key'], msg: '401 Unauthorized — API key invalid or revoked', type: 'value_error' }] },
    });
  });
  await page.goto('/');
  await openHealthchecks(page);
  await page.getByRole('main').getByRole('button', { name: 'Add project' }).click();
  const modal = page.locator('.modal-overlay.open .modal');
  await modal.getByLabel('Name').fill('Homelab');
  await modal.getByLabel('API key').fill('bad-key');
  await modal.getByRole('button', { name: 'Add & fetch' }).click();
  await expect(modal.locator('#hc-api_key-help')).toHaveText('401 Unauthorized — API key invalid or revoked');
  await expect(modal.getByLabel('API key')).toHaveAttribute('aria-invalid', 'true');
});

// jsdom has no layout or media queries; only a real browser proves the responsive table.
test('the checks table drops columns on narrow screens and stays inside its card', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await stubHealthchecks(page);
  await page.goto('/');
  await openHealthchecks(page);
  const card = page.locator('.hc-card').first();
  await card.getByRole('button', { name: 'Expand Homelab' }).click();
  await expect(card.locator('th.hc-c-slug')).toBeVisible();
  await expect(card.locator('.hc-mob').first()).toBeHidden();

  await page.setViewportSize({ width: 800, height: 900 });
  await expect(card.locator('th.hc-c-slug')).toBeHidden();
  await expect(card.locator('th.hc-c-status')).toBeVisible();

  await page.setViewportSize({ width: 375, height: 812 });
  await expect(card.locator('th.hc-c-status')).toBeHidden();
  await expect(card.locator('th.hc-c-period')).toBeHidden();
  await expect(card.locator('.hc-mob .hc-dot').first()).toBeVisible();
  await expect(card.locator('.hc-period-sub').first()).toBeVisible();
  const fits = await card.locator('.hc-inner').evaluate((el) => el.scrollWidth <= el.clientWidth);
  expect(fits).toBe(true);
});

// jsdom has no cascade; only a real browser proves every status × element pair is styled.
test('every status is styled on pills, chips and dots, and an unknown class never reads as up', async ({ page }) => {
  await page.goto('/');
  const wrong = await page.evaluate(() => {
    const mount = (html: string) => {
      const host = document.createElement('div');
      host.innerHTML = html;
      document.body.append(host);
      return host;
    };
    const resolve = (value: string) => {
      const host = mount(`<span style="background: ${value}"></span>`);
      const color = getComputedStyle(host.firstElementChild!).backgroundColor;
      host.remove();
      return color;
    };
    const dotOf: Record<string, string> = {
      up: resolve('var(--ok)'), grace: resolve('var(--warn)'), down: resolve('var(--err)'),
      paused: resolve('var(--text-3)'), new: resolve('var(--text-3)'),
      gone: resolve('transparent'), unknown: resolve('transparent'),
    };
    const out: string[] = [];
    const dots = (status: string) => {
      const host = mount(
        `<span class="hc-pill hc-${status}"><i></i>x</span>` +
        `<span class="hcp-chip hc-${status}"><i></i>x</span>` +
        `<i class="hc-dot hc-${status}"></i>`,
      );
      const styles = [...host.querySelectorAll('i')].map((el) => getComputedStyle(el));
      const result = styles.map((s) => ({ bg: s.backgroundColor, dashed: s.borderTopStyle === 'dashed' }));
      host.remove();
      return result;
    };
    for (const [status, expected] of Object.entries(dotOf)) {
      const stateless = status === 'gone' || status === 'unknown';
      dots(status).forEach((dot, i) => {
        const kind = ['pill', 'chip', 'dot'][i];
        if (dot.bg !== expected) out.push(`${kind}.hc-${status}: ${dot.bg} != ${expected}`);
        if (dot.dashed !== stateless) out.push(`${kind}.hc-${status}: dashed=${dot.dashed}`);
      });
    }
    for (const [i, dot] of dots('bogus').entries()) {
      if (dot.bg === dotOf.up) out.push(`${['pill', 'chip', 'dot'][i]}.hc-bogus reads as up`);
    }
    return out;
  });
  expect(wrong).toEqual([]);
});

test('editing a project with a new API key toasts that the check list refreshed', async ({ page }) => {
  await stubHealthchecks(page);
  await page.route('**/api/healthchecks/p1', async (route) => {
    if (route.request().method() !== 'PUT') {
      await route.fallback();
      return;
    }
    await route.fulfill({ json: PROJECT });
  });
  await page.goto('/');
  await openHealthchecks(page);
  const card = page.locator('.hc-card').filter({ hasText: 'Homelab' });
  await card.getByRole('button', { name: 'Edit' }).click();
  const modal = page.locator('.modal-overlay.open .modal');
  await modal.getByLabel('API key').fill('newkey');
  await modal.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('.toast')).toContainText('Saved Homelab — check list refreshed');
});

test('editing a project without touching the endpoint toasts a plain save', async ({ page }) => {
  await stubHealthchecks(page);
  await page.route('**/api/healthchecks/p1', async (route) => {
    if (route.request().method() !== 'PUT') {
      await route.fallback();
      return;
    }
    await route.fulfill({ json: PROJECT });
  });
  await page.goto('/');
  await openHealthchecks(page);
  const card = page.locator('.hc-card').filter({ hasText: 'Homelab' });
  await card.getByRole('button', { name: 'Edit' }).click();
  const modal = page.locator('.modal-overlay.open .modal');
  await modal.getByLabel('Name').fill('Homelab HQ');
  await modal.getByRole('button', { name: 'Save' }).click();
  const toast = page.locator('.toast');
  await expect(toast).toContainText('Saved Homelab HQ');
  await expect(toast).not.toContainText('refreshed');
});
