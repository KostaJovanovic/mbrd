// The native menu, and the one thing that can go wrong with it quietly.
//
// Every menu entry names a command by string - a name that matches nothing
// draws, is clickable, and does nothing, the same failure tests/icons.test.js
// guards against for the icon sprite. Checked against the real command
// object, not commands.ts's source text, since the surface spans five modules.
//
// Written with the ports (group C), goes green with the menu (group F), so
// groups D/E run red on purpose. Skipped only while desktop/package.json is
// absent entirely - a missing desktop/menu.ts once the shell exists is a
// failure, not a free pass.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ROOT } from './helpers.js';
import { createCommands } from '../web/assets/js/commands.ts';

const DESKTOP = join(ROOT, 'desktop');
const MENU = join(DESKTOP, 'menu.ts');
const started = existsSync(join(DESKTOP, 'package.json'));

// Same stub as settings-panel.test.js: createCommands() is a factory
// touching no browser global, and only the set of keys matters here.
const commands = () => createCommands(
  { toWorld: () => ({ x: 0, y: 0 }), centreWorld: () => ({ x: 0, y: 0 }), left: 0, top: 0, cx: 0, cy: 0, fit() {}, recenter() {} },
  { resetAppearance() {}, setWhimsy() {} });

test('every native menu entry names a command that exists', { skip: skipReason() }, () => {
  assert.ok(existsSync(MENU),
    'desktop/ exists but has no menu.ts - the shell has no menu bar, or it was renamed');
  const source = readFileSync(MENU, 'utf8');
  const cmds = commands();

  // desktop/menu.ts is a table, not a buildFromTemplate() call with logic in
  // it, so names are readable here without running Electron.
  const named = [...source.matchAll(/\bcmd:\s*'([^']+)'/g)].map(m => m[1]);
  assert.ok(named.length > 5,
    `only ${named.length} cmd: entries in desktop/menu.ts - the table is not being read`);

  for (const name of named) {
    assert.ok(name in cmds, `the menu names cmds.${name}, which does not exist`);
  }
});

test('the menu reaches the commands the desktop added', { skip: skipReason() }, () => {
  // Save As exists only because of the desktop, so it's the entry most likely
  // wired to an undefined name - named here since the sweep above would pass
  // even if the menu quietly dropped it.
  const source = readFileSync(MENU, 'utf8');
  assert.match(source, /\bcmd:\s*'saveAs'/, 'File → Save As is not on the menu');
  assert.ok('saveAs' in commands());
});

/** Null to run, or the sentence explaining why there is nothing to check yet. */
function skipReason() {
  return started ? false : 'no desktop/ yet - group D is what creates the shell this menu belongs to';
}
