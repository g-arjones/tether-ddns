import { test, expect } from '@playwright/test';

test('add a domain and see it listed', async ({ page }) => {
  await page.goto('/');

  // Open the Add Domain modal from the "Your Domains" section header.
  await page
    .locator('.section-head')
    .filter({ hasText: 'Your Domains' })
    .getByRole('button', { name: 'Add Domain' })
    .click();

  const modal = page.locator('.modal');
  await expect(modal.getByRole('heading', { name: 'Add Domain' })).toBeVisible();

  // Fill the hostname.
  await modal.getByLabel('Hostname / FQDN').fill('home.example.com');

  // Select the DuckDNS provider (also the default) to render its schema fields.
  await modal.getByLabel('DNS Provider').selectOption({ label: 'DuckDNS' });

  // DuckDNS schema fields rendered by SchemaForm: token (password) + domain (text).
  await modal.getByLabel('Token', { exact: true }).fill('secret-token');
  await modal.getByLabel('Domain', { exact: true }).fill('home');

  // Submit via the modal footer button.
  await modal.locator('.modal-foot').getByRole('button', { name: 'Add Domain' }).click();

  // The new domain appears in a DomainCard.
  await expect(page.getByText('home.example.com')).toBeVisible();
});

test('log viewer is visible', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('log-viewer')).toBeVisible();
});
