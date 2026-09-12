// The smoke run's configuration, nearly all defaults on purpose.
//
// Not a test suite - `npm test` at the root is that - just one check that the
// assembled app starts and returns the board it was left with. One worker,
// not for speed: two Electron apps race for the single-instance lock, so the
// second hands off its argv and quits, and the test waits on a window that
// never opens.

import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test',
  // A launch, a boot and a relaunch - generous, since this catches "it did
  // not start", not "it was slow".
  timeout: 180_000,
  expect: { timeout: 15_000 },
  workers: 1,
  fullyParallel: false,
  // No retries: a flaky smoke test teaches people to re-run it. A failure
  // means the app failed - see userData/logs/main.log.
  retries: 0,
  reporter: [['list']],
});
