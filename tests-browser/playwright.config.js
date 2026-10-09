// The browser suite: the app driven by real pointer, wheel, key and touch
// input in Chromium, Firefox, WebKit and an emulated phone. Local only and run
// by hand (`npm run test:browser`), never per commit or in CI, which keep
// tools/smoke.mjs. Playwright comes from desktop/node_modules, so the root
// stays at four devDependencies and `npm test` stays zero-install.

const PORT = 6290;
const BASE = `http://127.0.0.1:${PORT}/`;
// A desktop-sized window: a phone-sized one boots a board in the Feed layout.
const DESKTOP = { viewport: { width: 1280, height: 800 } };
const NOT_TOUCH = '**/*.touch.spec.js';

export default {
  testDir: '.',
  testMatch: '**/*.spec.js',
  outputDir: '../test-results/browser',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  // The app is heavy; more workers than this starve each other's timers.
  workers: 4,
  reporter: [['list']],
  use: { baseURL: BASE, trace: 'retain-on-failure' },
  webServer: {
    command: `node ../tools/web-server.mjs ${PORT}`,
    url: BASE,
    reuseExistingServer: true,
  },
  projects: [
    { name: 'chromium', testIgnore: NOT_TOUCH, use: { browserName: 'chromium', ...DESKTOP } },
    { name: 'firefox', testIgnore: NOT_TOUCH, use: { browserName: 'firefox', ...DESKTOP } },
    { name: 'webkit', testIgnore: NOT_TOUCH, use: { browserName: 'webkit', ...DESKTOP } },
    {
      name: 'touch',
      testMatch: '**/*.touch.spec.js',
      use: {
        browserName: 'chromium',
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
};
