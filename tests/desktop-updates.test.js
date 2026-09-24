// The desktop's updates answer on the title bar's Update button, never in a
// native dialog, and download only when that button is pressed
// (research/old/done-2026-09-15.md, R3). Read as text: the updater runs in
// Electron's main process, which no test here can start.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const DESKTOP = join(import.meta.dirname, '..', 'desktop');
const updates = readFileSync(join(DESKTOP, 'updates.ts'), 'utf8');
const bridge = readFileSync(join(DESKTOP, 'chrome', 'bridge.ts'), 'utf8');
const bar = readFileSync(join(DESKTOP, 'chrome', 'titlebar.ts'), 'utf8');

/** The body of a top-level function in updates.ts, up to its closing brace at column 0. */
function body(name) {
  const m = new RegExp(`\\nexport (?:async )?function ${name}\\(|\\n(?:async )?function ${name}\\(`).exec(updates);
  assert.ok(m, `no function ${name} in desktop/updates.ts`);
  const end = updates.indexOf('\n}\n', m.index);
  return updates.slice(m.index, end);
}

test('the updater opens no native dialog', () => {
  assert.doesNotMatch(updates, /import\s*\{[^}]*\bdialog\b[^}]*\}\s*from 'electron'/);
  assert.doesNotMatch(updates, /showMessageBox|\bdialog\.\w+\(/);
});

test('only a press on Update downloads', () => {
  // The download starts in one place, and that place is reached from the press.
  const starts = [...updates.matchAll(/\bdownloadAndInstall\(/g)].length;
  assert.equal(starts, 2, 'downloadAndInstall is defined once and called once');
  assert.match(body('clickUpdate'), /downloadAndInstall\(/);
  const fetches = [...updates.matchAll(/\bfetchUpdate\(/g)].length;
  assert.equal(fetches, 2, 'fetchUpdate is defined once and called once');
  assert.match(body('downloadAndInstall'), /fetchUpdate\(/);
  // The check announces, and does not fetch.
  assert.doesNotMatch(body('check'), /fetchUpdate\(|downloadAndInstall\(/);
});

test('the installer starts only after the quit has written the board', () => {
  // NSIS kills a copy still running within about three seconds, and the
  // flush that holds the close may take ten. will-quit comes after the flush.
  assert.doesNotMatch(body('install'), /runInstaller\(/);
  assert.match(body('install'), /restartAfter = true;/);
  assert.match(body('startUpdates'), /app\.on\('will-quit', \(\) => runInstaller\(restartAfter\)\);/);
  assert.equal([...updates.matchAll(/\brunInstaller\(/g)].length, 2, 'defined once and called from will-quit only');
});

test('a check that finds nothing newer clears a failure from before', () => {
  // Otherwise "Could not check" stayed on the button for the whole run, and a
  // passing "Up to date" went back to it after five seconds.
  const current = /if \(!newer\(rel\.version, app\.getVersion\(\)\)\) \{([\s\S]*?)\n {4}\}/.exec(body('check'));
  assert.ok(current, 'no not-newer branch in check()');
  assert.match(current[1], /pending = null;/);
  assert.match(current[1], /if \(offered\) publish\(null\);/);
  assert.ok(current[1].indexOf('publish(null)') < current[1].indexOf('say('), 'cleared before the passing answer');
});

test('every state the updater can say has a word on the button', () => {
  const union = /export type UpdateState =([^;]+);/.exec(bridge);
  assert.ok(union, 'no UpdateState in desktop/chrome/bridge.ts');
  const states = [...union[1].matchAll(/'([a-z]+)'/g)].map(m => m[1]);
  assert.ok(states.length >= 8, `only ${states.length} states read`);
  const words = /const WORDS\b[\s\S]*?= \{([\s\S]*?)\n\};/.exec(bar);
  assert.ok(words, 'no WORDS table in desktop/chrome/titlebar.ts');
  for (const state of states) assert.match(words[1], new RegExp(`\\b${state}:`), `no word for ${state}`);
  // And the updater says only states the type knows.
  for (const [, said] of updates.matchAll(/state: '([a-z]+)'/g)) {
    assert.ok(states.includes(said), `updates.ts says '${said}', which UpdateState does not have`);
  }
});
