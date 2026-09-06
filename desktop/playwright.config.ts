// The smoke run's configuration, and it is nearly all defaults on purpose.
//
// One spec, one worker, no reporters beyond the terminal. This is not a test
// suite - the suite is `npm test` at the root, over two thousand cases with no
// install - it is one check that the assembled application starts and comes
// back with the board it was left with.
//
// **One worker, and it is not about speed.** Two Electron apps at once means
// two processes racing for the single-instance lock, which the second one
// loses: it hands its argv over and quits, and the test driving it waits for a
// window that will never open. Each spec makes its own userData directory, so
// they do not share a store either.

import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test',
  // A launch, a boot and a relaunch. Generous, because the failure this is
  // catching is "it did not start" rather than "it was slow".
  timeout: 180_000,
  expect: { timeout: 15_000 },
  workers: 1,
  fullyParallel: false,
  // A flaky smoke test is worse than none: it teaches people to re-run it. If
  // this fails, the app failed, and the log at userData/logs/main.log says how.
  retries: 0,
  reporter: [['list']],
});
