import { test, expect, type Page } from '@playwright/test';

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

// The real backend has no projects and cannot reach healthchecks.io, so config comes
// from a REST stub and live status is spliced into every real ws `state` frame.
async function stubHealthchecks(page: Page): Promise<void> {
  await page.route('**/api/healthchecks', async (route) => {
    if (route.request().method() === 'GET') await route.fulfill({ json: [PROJECT] });
    else await route.fallback();
  });
  await page.routeWebSocket('**/api/ws', (ws) => {
    const server = ws.connectToServer();
    server.onMessage((message) => {
      const frame = JSON.parse(String(message)) as { kind: string; payload: Record<string, unknown> };
      if (frame.kind === 'state') frame.payload.healthchecks = RUNTIME;
      ws.send(JSON.stringify(frame));
    });
  });
}

async function openHealthchecks(page: Page): Promise<void> {
  await page.getByRole('button', { name: /Healthchecks/ }).click();
  await expect(page.getByRole('heading', { name: 'Healthchecks', level: 2 })).toBeVisible();
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

test('the overview shows healthchecks badges between the stat cards and the IP panel', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await stubHealthchecks(page);
  await page.goto('/');
  const panel = page.locator('.hc-panel');
  await expect(panel.locator('.hc-badge')).toHaveCount(3);
  await expect(panel.locator('.hc-badge.hc-down')).toContainText('SSL (hydrogen)');
  await expect(panel.locator('.hc-badge.hc-gone')).toContainText('Old job');
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
test('every status is styled on pills, badges and dots, and an unknown class never reads as up', async ({ page }) => {
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
        `<span class="hc-badge hc-${status}"><i></i>x</span>` +
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
        const kind = ['pill', 'badge', 'dot'][i];
        if (dot.bg !== expected) out.push(`${kind}.hc-${status}: ${dot.bg} != ${expected}`);
        if (dot.dashed !== stateless) out.push(`${kind}.hc-${status}: dashed=${dot.dashed}`);
      });
    }
    for (const [i, dot] of dots('bogus').entries()) {
      if (dot.bg === dotOf.up) out.push(`${['pill', 'badge', 'dot'][i]}.hc-bogus reads as up`);
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
