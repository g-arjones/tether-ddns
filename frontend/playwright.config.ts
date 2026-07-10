import { defineConfig } from '@playwright/test';

/**
 * Playwright e2e config for the production SPA served by FastAPI.
 *
 * The webServer builds the frontend (output goes to ../tether_ddns/static),
 * then launches the backend with an isolated temp config so tests start
 * from an empty state.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 30000,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:8000',
    trace: 'on-first-retry',
  },
  webServer: {
    command:
      'npm run build && cd .. && TETHER_DDNS_CONFIG_PATH=$(mktemp -d)/e2e-config.json ' +
      '/home/arjones/dev/tether-ddns/.venv/bin/python -m tether_ddns',
    url: 'http://localhost:8000',
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
  },
});
