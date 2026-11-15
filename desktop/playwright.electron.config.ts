import { defineConfig } from '@playwright/test';

/**
 * Electron e2e configuration (#86 Task 10): the connection-isolation spec only.
 *
 * Unlike playwright.config.ts (renderer-only, Vite dev server, live backend), this
 * launches the BUILT Electron shell from dist/ against in-process stub planes, so it
 * needs `npm run build` first and no backend. No webServer: the fixture serves the
 * built renderer itself. One worker, because every test owns port 3001 and a shell.
 *
 * Usage: cd desktop && npm run build && npm run test:e2e:electron
 */
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: /connectionIsolation\.spec\.ts/,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  timeout: 120_000,
  reporter: [['list']],
  outputDir: './test-results/electron',
});
