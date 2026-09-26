import { test, expect, type Page } from '@playwright/test';

// Computed colour of the --err token, in the same rgb() form toHaveCSS reports.
async function errColor(page: Page): Promise<string> {
  return page.evaluate(() => {
    const probe = document.createElement('div');
    probe.style.color = 'var(--err)';
    document.body.appendChild(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  });
}

test('a domain saved without its provider token is flagged on the token field', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('navigation').getByRole('button', { name: /Domains/ }).click();
  await page.getByRole('main').getByRole('button', { name: 'Add Domain' }).click();
  const modal = page.locator('.modal-overlay.open .modal');
  await expect(modal).toHaveCSS('transform', 'none');

  await modal.getByLabel('Hostname / FQDN').fill('cf.example.com');
  await modal.getByLabel('DNS Provider').selectOption({ label: 'Cloudflare' });
  await modal.locator('.modal-foot').getByRole('button', { name: 'Add Domain' }).click();

  const token = modal.getByLabel('API Token', { exact: true });
  await expect(token).toHaveAttribute('aria-invalid', 'true');
  await expect(token).toHaveCSS('border-color', await errColor(page));
  await expect(modal.locator('#sf-api_token-help')).toHaveText('Required');
});

test('hook save errors decorate the custom select and a schema select', async ({ page }) => {
  await page.route('**/api/hooks-config', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    return route.fulfill({
      status: 422,
      json: { detail: [
        { loc: ['body', 'hook'], msg: 'Unknown hook', type: 'unknown_hook' },
        { loc: ['body', 'config', 'ip_version'], msg: "Input should be 'ipv4' or 'ipv6'", type: 'literal_error' },
      ] },
    });
  });
  await page.goto('/');
  await page.getByRole('navigation').getByRole('button', { name: /Hooks/ }).click();
  await page.getByRole('main').getByRole('button', { name: 'Add Hook' }).click();
  const modal = page.locator('.modal-overlay.open .modal');
  await expect(modal).toHaveCSS('transform', 'none');

  await modal.getByLabel('Hook', { exact: true }).selectOption({ label: 'Router Firewall (ZTE)' });
  await modal.locator('.modal-foot').getByRole('button', { name: 'Add Hook' }).click();

  const err = await errColor(page);
  await expect(modal.getByLabel('Hook', { exact: true })).toHaveAttribute('aria-invalid', 'true');
  await expect(modal.locator('.cs-trigger').first()).toHaveCSS('border-color', err);
  const ipVersion = modal.getByLabel('IP Version');
  await expect(ipVersion).toHaveAttribute('aria-invalid', 'true');
  await expect(ipVersion).toHaveCSS('border-color', err);
});
