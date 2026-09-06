// The native menu, and the one thing that can go wrong with it quietly.
//
// Every entry on the desktop's menu bar names a command by string - File → Save
// sends `cmd:save`, and main.ts looks it up in the object createCommands()
// builds. A name that matches nothing is not an error anywhere: the menu item
// draws, it is clickable, and pressing it does nothing at all. That is the same
// failure the icon sprite has, so this is the same test in a different sprite -
// see tests/icons.test.js, whose shape this follows.
//
// It is checked against the real command object rather than against the source
// text of commands.ts, for the reason settings-panel.test.js gives: `key in
// cmds` is what the dispatch actually does, and the surface is spread across
// five modules that a regex over one file cannot see.
//
// ── Why this file exists before the menu does ──
//
// It was written with the ports (group C) and goes green with the menu (group
// F), so groups D and E run red on it on purpose. The alternative was a skip,
// and a skip conditional on nothing is the silent pass this whole file is
// about: `desktop/menu.ts` could be renamed, or never written, and a skipping
// test would report success forever.
//
// So the skip is conditional on the desktop not existing *at all*. While there
// is no desktop/package.json there is no shell to have a menu, and this says so
// and stands down. The moment there is one, a missing desktop/menu.ts is a
// failure - which is exactly the window in which somebody could forget to write
// it.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ROOT } from './helpers.js';
import { createCommands } from '../web/assets/js/commands.ts';

const DESKTOP = join(ROOT, 'desktop');
const MENU = join(DESKTOP, 'menu.ts');
const started = existsSync(join(DESKTOP, 'package.json'));

// The same stub settings-panel.test.js builds one with: createCommands() is a
// factory precisely so it touches no browser global, and what is wanted here is
// the set of keys rather than a working app.
const commands = () => createCommands(
  { toWorld: () => ({ x: 0, y: 0 }), left: 0, top: 0, cx: 0, cy: 0, fit() {}, recenter() {} },
  { resetAppearance() {}, setWhimsy() {} });

test('every native menu entry names a command that exists', { skip: skipReason() }, () => {
  assert.ok(existsSync(MENU),
    'desktop/ exists but has no menu.ts - the shell has no menu bar, or it was renamed');
  const source = readFileSync(MENU, 'utf8');
  const cmds = commands();

  // `cmd: 'name'` is the table's own spelling - see desktop/menu.ts, which is a
  // table and not a Menu.buildFromTemplate() call with logic in it, so that the
  // names are readable from here without running Electron.
  const named = [...source.matchAll(/\bcmd:\s*'([^']+)'/g)].map(m => m[1]);
  assert.ok(named.length > 5,
    `only ${named.length} cmd: entries in desktop/menu.ts - the table is not being read`);

  for (const name of named) {
    assert.ok(name in cmds, `the menu names cmds.${name}, which does not exist`);
  }
});

test('the menu reaches the commands the desktop added', { skip: skipReason() }, () => {
  // Save As is the one command that exists *because* of the desktop - the web
  // has Save and Export and no third verb - so it is the entry most likely to be
  // wired to a name nobody defined. Named here rather than left to the sweep
  // above, which would pass on a menu that quietly dropped it.
  const source = readFileSync(MENU, 'utf8');
  assert.match(source, /\bcmd:\s*'saveAs'/, 'File → Save As is not on the menu');
  assert.ok('saveAs' in commands());
});

/** Null to run, or the sentence explaining why there is nothing to check yet. */
function skipReason() {
  return started ? false : 'no desktop/ yet - group D is what creates the shell this menu belongs to';
}
