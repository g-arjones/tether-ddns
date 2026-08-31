import { defineConfig } from '@playwright/test';

/**
 * Playwright e2e config for the production SPA served by FastAPI.
 *
 * The webServer builds the frontend (output goes to ../tether_ddns/static),
 * then launches the backend on a dedicated port with config and state both
 * redirected into one temp dir, so a run is hermetic: it can never reuse a
 * developer's instance on the default port 8000, write to the real config, or
 * leave state/incident files in the repository root.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 30000,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:8123',
    trace: 'on-first-retry',
  },
  webServer: {
    command:
      'npm run build && cd .. && E2E_DIR=$(mktemp -d) && ' +
      'TETHER_DDNS_CONFIG_PATH=$E2E_DIR/config.json ' +
      'TETHER_DDNS_STATE_PATH=$E2E_DIR/state.json ' +
      'TETHER_DDNS_PORT=8123 .venv/bin/python -m tether_ddns',
    url: 'http://localhost:8123',
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
  },
});
