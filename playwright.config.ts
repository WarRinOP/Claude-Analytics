// Headless Chromium end to end tests of the dashboard. A global setup starts `serve` against a temp data folder and a
// synthetic transcript folder, so no real transcript is read and nothing is written under ~/.claude or the real app folder.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'test/e2e',
  testMatch: '**/*.spec.ts',
  globalSetup: './test/e2e/global-setup.ts',
  // The screenshot test writes to test-results/screens, so the per test artifacts live next to it, not over it.
  outputDir: 'test-results/artifacts',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    browserName: 'chromium',
    headless: true,
    viewport: { width: 1440, height: 900 },
    locale: 'en-GB',
    timezoneId: 'UTC',
    colorScheme: 'dark',
    trace: 'off',
  },
});
