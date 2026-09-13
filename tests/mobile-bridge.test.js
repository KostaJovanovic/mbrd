// The Android bridge has the desktop bridge's shape. Bridge in
// platform/electron.ts is written by hand, and so is mobile/bridge/mbrd-bridge.ts,
// and tsc checks the second against the first only when somebody runs the mobile
// typecheck. This runs in every `npm test`, as text, with nothing installed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT, JS, read } from './helpers.js';

const BRIDGE = join(ROOT, 'mobile', 'bridge', 'mbrd-bridge.ts');
const skip = !existsSync(BRIDGE) && 'mobile/ is absent from this checkout';

/** A member written at two spaces, from its name to the next line back at two
 * spaces or less: a group's whole block, or one line for a plain member. */
function members(block) {
  const out = new Map();
  const lines = block.split(/\r?\n/);
  lines.forEach((line, i) => {
    const m = /^ {2}(\w+)\??\s*[:(]/.exec(line);
    if (!m) return;
    const end = lines.findIndex((next, j) => j > i && /^ {0,2}\S/.test(next));
    out.set(m[1], lines.slice(i + 1, end < 0 ? undefined : end).join('\n'));
  });
  return out;
}

/** The names a group's block holds, at four spaces. */
const inner = block => new Set([...block.matchAll(/^ {4}(\w+)\s*[:(]/gm)].map(m => m[1]));

function bridgeInterface() {
  const src = read(join(JS, 'platform', 'electron.ts'));
  const m = /^export interface Bridge \{\n([\s\S]*?)^\}/m.exec(src.replace(/\r\n/g, '\n'));
  assert.ok(m, 'no `export interface Bridge {` in platform/electron.ts - has it moved?');
  return members(m[1]);
}

function androidObject() {
  const src = read(BRIDGE).replace(/\r\n/g, '\n');
  const m = /^const api: AndroidBridge = \{\n([\s\S]*?)^\};/m.exec(src);
  assert.ok(m, 'no `const api: AndroidBridge = {` in mbrd-bridge.ts - has it moved?');
  return members(m[1]);
}

test('the Android bridge defines every key of Bridge, group by group', { skip }, () => {
  const wanted = bridgeInterface();
  const got = androidObject();
  assert.ok(wanted.size >= 10, `only ${wanted.size} keys read from Bridge - has the layout changed?`);
  // `shell` is the one optional key, and the Android bridge is what sets it.
  const missing = [...wanted.keys()].filter(key => !got.has(key));
  assert.deepEqual(missing, [], `mbrd-bridge.ts has no ${missing.join(', ')}`);
  for (const [group, block] of wanted) {
    const names = inner(block);
    if (!names.size) continue;
    const absent = [...names].filter(name => !inner(got.get(group) ?? '').has(name));
    assert.deepEqual(absent, [], `mbrd-bridge.ts has no ${group}.${absent.join(`, ${group}.`)}`);
  }
});

test('the Android bridge is the version of the desktop bridge it copies', { skip }, () => {
  // preload.ts bumps `bridge` when a member goes or changes shape. The Android
  // one must follow, or an adapter that refuses an old shell refuses neither.
  const desktop = /^\s*bridge: (\d+),/m.exec(read(join(ROOT, 'desktop', 'preload.ts')));
  const android = /^\s*bridge: (\d+),/m.exec(read(BRIDGE));
  assert.ok(desktop && android, 'no `bridge: N,` in preload.ts or mbrd-bridge.ts');
  assert.equal(android[1], desktop[1]);
  assert.match(read(BRIDGE), /^\s*shell: 'capacitor',/m, "the Android bridge does not say shell: 'capacitor'");
});
