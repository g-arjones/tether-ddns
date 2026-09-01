import { test, expect, type WebSocketRoute } from '@playwright/test';

test('app starts on Overview', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Overview', level: 2 })).toBeVisible();
});

test('rail navigates across all five views', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Overview', level: 2 })).toBeVisible();

  // Navigate through all views via rail buttons
  const viewPairs = [
    ['Domains', 'Domains'],
    ['Hooks', 'Hooks'],
    ['Logs', 'Logs'],
    ['Settings', 'Settings'],
  ] as const;

  for (const [navButtonName, headingName] of viewPairs) {
    await page.getByRole('button', { name: new RegExp(navButtonName) }).click();
    // Check for the h2 heading in the TopBar
    await expect(page.getByRole('heading', { name: headingName, level: 2 })).toBeVisible();
  }
});

test('overview shows the instrument panels', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Public IP')).toBeVisible();
  await expect(page.getByText('Record health')).toBeVisible();
});

test('add a domain from the Domains view', async ({ page }) => {
  await page.goto('/');

  // Navigate to Domains view via rail
  await page.getByRole('button', { name: /Domains/ }).click();

  // Click Add Domain button in the view (not in the modal)
  await page.getByRole('main').getByRole('button', { name: 'Add Domain' }).click();

  const modal = page.locator('.modal');
  await expect(modal.getByRole('heading', { name: 'Add Domain' })).toBeVisible();

  // Fill the hostname
  await modal.getByLabel('Hostname / FQDN').fill('home.example.com');

  // Select the DuckDNS provider
  await modal.getByLabel('DNS Provider').selectOption({ label: 'DuckDNS' });

  // DuckDNS schema fields rendered by SchemaForm: token (password)
  await modal.getByLabel('Token', { exact: true }).fill('secret-token');

  // Submit via the modal footer button
  await modal.locator('.modal-foot').getByRole('button', { name: 'Add Domain' }).click();

  // The new domain appears in a DomainCard
  await expect(
    page.locator('.name').filter({ hasText: 'home.example.com' }).first(),
  ).toBeVisible();
});

test('log viewer is visible on the Logs view', async ({ page }) => {
  await page.goto('/');

  // Navigate to Logs view via rail
  await page.getByRole('button', { name: /Logs/ }).click();

  await expect(page.getByTestId('log-viewer')).toBeVisible();
});

test('about view shows backend and frontend panels', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /About/ }).click();
  await expect(page.getByRole('heading', { name: 'About', level: 2 })).toBeVisible();
  await expect(page.getByText('Backend')).toBeVisible();
  await expect(page.getByText('Frontend')).toBeVisible();
});

test('clicking a day bar opens the incident modal', async ({ page }) => {
  await page.goto('/');
  const bars = page.locator('.day-strip button');
  await expect(bars).toHaveCount(30);
  await bars.last().click();
  await expect(page.locator('.modal-overlay.open')).toBeVisible();
  await expect(page.getByText(/Day timeline/)).toBeVisible();
});

test('the day strip is keyboard reachable', async ({ page }) => {
  await page.goto('/');
  const first = page.locator('.day-strip button').first();
  await first.focus();
  await expect(first).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('.modal-overlay.open')).toBeVisible();
});

// Regression: placeholder bars once carried the global `.empty` class, whose
// 60px/20px padding overflowed the strip and starved the Record health column.
test('the live strip stays inside its box and does not starve the layout', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(page.locator('.quorum span')).toHaveCount(24);

  // One evaluate, one layout pass: the dashboard re-renders on every WebSocket
  // frame, so boxes sampled across separate calls can disagree by a pixel or two.
  const geometry = await page.evaluate(() => {
    const strip = document.querySelector('.quorum')!.getBoundingClientRect();
    const bars = [...document.querySelectorAll('.quorum span')].map((bar) => {
      const box = bar.getBoundingClientRect();
      return { y: box.y, height: box.height };
    });
    const health = document.querySelectorAll('.ov-grid > *')[1]!.getBoundingClientRect();
    return { stripY: strip.y, stripHeight: strip.height, bars, healthWidth: health.width };
  });

  for (const bar of geometry.bars) {
    expect(bar.height).toBeLessThanOrEqual(geometry.stripHeight);
    expect(bar.y).toBeGreaterThanOrEqual(geometry.stripY);
  }
  expect(geometry.healthWidth).toBeGreaterThan(300);
});

test('recovers from a dropped connection and does not duplicate logs', async ({ page }) => {
  let live = true;
  let activeRoute: WebSocketRoute | null = null;

  await page.routeWebSocket('**/api/ws', (route) => {
    if (!live) {
      route.close({ code: 1006 });
      return;
    }
    activeRoute = route;
    route.connectToServer();
  });

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Overview', level: 2 })).toBeVisible();

  await page.getByRole('button', { name: /Logs/ }).click();
  const lines = page.locator('.log-line');
  await expect.poll(async () => lines.count()).toBeGreaterThan(0);
  const before = await lines.count();

  live = false;
  if (activeRoute) {
    activeRoute.close({ code: 1006 });
  }
  await expect(page.getByText('Reconnecting…')).toBeVisible({ timeout: 40_000 });

  live = true;
  await expect(page.getByText('Reconnecting…')).toBeHidden({ timeout: 40_000 });

  await expect(page.getByRole('heading', { name: 'Logs', level: 2 })).toBeVisible();
  await expect.poll(async () => lines.count()).toBeLessThanOrEqual(before * 2 - 1);
});
