import { defineConfig } from '@playwright/test';

const port = 4173;
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 240_000,
  expect: { timeout: 20_000 },
  retries: process.env['CI'] ? 1 : 0,
  workers: 1, // one shared module download/cache
  reporter: process.env['CI'] ? 'github' : 'list',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    // Local runs use the installed Chrome; CI installs Playwright's chromium (PW_CHANNEL=chromium → default browser).
    ...(process.env['PW_CHANNEL'] === 'chromium'
      ? {}
      : { channel: process.env['PW_CHANNEL'] ?? 'chrome' }),
    viewport: { width: 1440, height: 960 },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `npm run build && npm run preview -- --host 127.0.0.1 --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}/`,
    reuseExistingServer: !process.env['CI'],
    timeout: 180_000,
  },
});
