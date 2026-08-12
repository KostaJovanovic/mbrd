// End-to-end runs, and they are optional on purpose.
//
// `npm test` is the suite that gates a pull request: Node's own runner over
// tests/, no install, no browser. This is the other half - the four things a
// canvas app's regressions actually live in and that a headless unit test
// structurally cannot see: pan and zoom, marquee select and drag, save →
// refresh → recover, and importing a file.
//
// It is not in CI and is not required to contribute, because it needs
// `npm install` and a browser download and this repository's whole premise is
// that neither is needed to work on it. Run it when you have touched the canvas
// or the storage layer and want more confidence than the unit suite can give:
//
//   npm install
//   npx playwright install chromium
//   npm run test:e2e
//
// The dev server is started for you (tools/serve.py, on a port of its own so it
// never argues with one you already have open on 6273).

import { defineConfig, devices } from '@playwright/test';

const PORT = 6274;

export default defineConfig({
  testDir: './tests/e2e',
  // The board is a singleton in a page; these run in separate contexts, but
  // serialising them keeps a failure readable rather than interleaved.
  fullyParallel: false,
  workers: 1,
  // A canvas assertion that flakes is a canvas assertion that is wrong. No
  // retries, so a flake is reported as the bug it is.
  retries: 0,
  reporter: [['list']],

  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],

  webServer: {
    command: `python tools/serve.py ${PORT}`,
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: true,
    stdout: 'ignore',
    timeout: 30_000,
  },
});
