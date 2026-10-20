import { defineConfig } from '@playwright/test';

export default defineConfig({
  testMatch: '**/*.e2e.ts',
  timeout: 180_000,
  workers: 1,
  reporter: 'list',
  outputDir: 'test-results',
  use: {
    screenshot: 'only-on-failure',
    launchOptions: process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
  },
});
