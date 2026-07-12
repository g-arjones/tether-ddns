import { test, expect } from '@playwright/test';

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

  // DuckDNS schema fields rendered by SchemaForm: token (password) + domain (text)
  await modal.getByLabel('Token', { exact: true }).fill('secret-token');
  await modal.getByLabel('Domain', { exact: true }).fill('home');

  // Submit via the modal footer button
  await modal.locator('.modal-foot').getByRole('button', { name: 'Add Domain' }).click();

  // The new domain appears in a DomainCard
  await expect(
    page.locator('.name').filter({ hasText: 'home.example.com' }),
  ).toBeVisible();
});

test('log viewer is visible on the Logs view', async ({ page }) => {
  await page.goto('/');
  
  // Navigate to Logs view via rail
  await page.getByRole('button', { name: /Logs/ }).click();
  
  await expect(page.getByTestId('log-viewer')).toBeVisible();
});
