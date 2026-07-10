# End-to-end tests (Playwright)

These tests run against the **production SPA served by FastAPI**: the built
frontend (`tether_ddns/static`) is served by `python -m tether_ddns` on port 8000.

## Prerequisites

- Node dependencies installed: `npm install` (in `frontend/`).
- Python venv at repo root (`.venv`) with the `tether_ddns` package installed.
- Chromium browser for Playwright: `npx playwright install chromium`.

The `webServer` in `playwright.config.ts` handles building the frontend and
launching the backend automatically, so you do not need to build or start the
server manually. Each run uses a fresh temp `TETHER_DDNS_CONFIG_PATH`, so tests
begin from an empty configuration.

## Run

```bash
cd frontend
npx playwright test
# or
npm run test:e2e
```

## Notes

- The webServer command is:
  `npm run build && cd .. && TETHER_DDNS_CONFIG_PATH=$(mktemp -d)/e2e-config.json /home/arjones/dev/tether-ddns/.venv/bin/python -m tether_ddns`
- `reuseExistingServer` is enabled outside CI, so an already-running server on
  port 8000 will be reused.
- Reports/artifacts (`playwright-report/`, `test-results/`) are git-ignored.
