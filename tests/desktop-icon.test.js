// The Windows icon, and three ways it goes back to a blank placeholder.
//
// Microsoft allows PNG compression for an .ico's 256 px image only, and parts of
// the shell show the generic icon for a smaller PNG frame. A taskbar button
// takes the installer shortcut's icon only when the window's AppUserModelID is
// the shortcut's, which electron-builder sets from appId. And the installer
// writes package.json's description into every shortcut it makes: a long one
// with a double quote in it broke the line, and the shortcuts' icon field held
// a slice of the prose (research/rapid-fixes-2026-09-14.md, R4).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT, read } from './helpers.js';

const DESKTOP = join(ROOT, 'desktop');

test('the .ico carries bitmaps below 256 px and nothing else is a PNG', () => {
  const ico = readFileSync(join(DESKTOP, 'icons', 'icon.ico'));
  assert.equal(ico.readUInt16LE(2), 1, 'not an icon file');
  const count = ico.readUInt16LE(4);
  assert.ok(count >= 4, `only ${count} frames`);
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  for (let i = 0; i < count; i++) {
    const at = 6 + i * 16;
    const size = ico.readUInt8(at) || 256;
    const offset = ico.readUInt32LE(at + 12);
    const isPng = ico.subarray(offset, offset + 4).equals(PNG);
    if (size < 256) {
      assert.equal(isPng, false, `the ${size} px frame is a PNG`);
      assert.equal(ico.readUInt32LE(offset), 40, `the ${size} px frame has no BITMAPINFOHEADER`);
    }
  }
});

test('the description the installer writes into the shortcuts is short and plain', () => {
  const pkg = JSON.parse(read(join(DESKTOP, 'package.json')));
  const said = pkg.description;
  assert.equal(typeof said, 'string', 'desktop/package.json has no description');
  // A shortcut's comment holds 259 characters (INFOTIPSIZE), and the exe's
  // file description, which Task Manager shows, wants the app's name.
  assert.ok(said.length <= 80, `the description is ${said.length} characters`);
  // Nothing NSIS or a shortcut's command line reads as syntax.
  assert.doesNotMatch(said, /["$`\\\n\r]/, 'the description holds a quote, a $, a backtick, a backslash or a line break');
});

test('main.ts names the same AppUserModelID the installer gives its shortcuts', () => {
  const appId = /^appId:\s*(\S+)/m.exec(read(join(DESKTOP, 'electron-builder.yml')))?.[1];
  const main = read(join(DESKTOP, 'main.ts'));
  assert.ok(appId, 'no appId in electron-builder.yml');
  assert.match(main, new RegExp(`const APP_ID = '${appId.replace(/\./g, '\\.')}'`));
  assert.match(main, /app\.setAppUserModelId\(APP_ID\)/);
});
