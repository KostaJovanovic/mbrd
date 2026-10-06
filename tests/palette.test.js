// The S box (ui/palette.ts): how it ranks (ui/palette-match.ts, pure), and the
// one way it goes quietly incomplete - a command added to the desktop's menu
// bar that no source of the box reaches. Its other sources are the menus, the
// toolbar and the panel themselves, read at open, so they cannot fall behind.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { ROOT, WEB, read } from './helpers.js';
import { fold, flatten, score, rank, dedupe, rowKey } from '../web/assets/js/ui/palette-match.ts';

const run = () => {};
const row = (label, path = ['Board'], weight = 2, extra = {}) =>
  ({ entry: { label, action: run }, path, weight, key: rowKey(path, label), ...extra });

test('folding drops case, accents and punctuation', () => {
  assert.equal(fold('Align & distribute'), 'align and distribute');
  assert.equal(fold('Café — Crème…'), 'cafe creme');
});

test('every word typed has to start a word of the name, its place or another name for it', () => {
  assert.ok(score('snap', 'Snap to grid') > 0);
  assert.ok(score('to gr', 'Snap to grid') > 0);
  assert.equal(score('snap zebra', 'Snap to grid'), 0);
  // Not a loose subsequence: these letters are in the name, in order, and that is not enough.
  assert.equal(score('nptg', 'Snap to grid'), 0);
  // Its place counts, for less than its name.
  assert.ok(score('picture', 'Fill the cells', ['Selection', 'Picture']) > 0);
  assert.ok(score('fill', 'Fill the cells') > score('picture', 'Fill the cells', ['Selection', 'Picture']));
});

test('initials, other names and American spelling find the row', () => {
  assert.ok(score('sg', 'Snap to grid') > 0);
  assert.ok(score('group', 'Fence these 3') > 0);
  assert.ok(score('lock', 'Anchor these') > 0);
  assert.ok(score('color', 'Colour') > 0);
  assert.ok(score('center', 'Align centre') > 0);
  assert.ok(score('crop', 'Edit picture…') > 0);
  assert.ok(score('notes', 'Add a note here') > 0, 'a plural finds its singular');
});

test('a name that starts with the query beats one that only contains its words', () => {
  const rows = [row('Show axes'), row('Show grid'), row('Snap to grid')];
  assert.equal(rank(rows, 'grid')[0].entry.label, 'Show grid');
  assert.equal(rank(rows, 'snap')[0].entry.label, 'Snap to grid');
});

test('the selection outranks the settings on an equal match', () => {
  const rows = [row('Reset size', ['Settings'], 1), row('Reset size', ['Selection'], 3)];
  assert.deepEqual(rank(rows, 'reset').map(r => r.path[0]), ['Selection', 'Settings']);
});

test('an empty query is what was used last, then the nearest rows in their own order', () => {
  const rows = [row('Paste', ['Board'], 2), row('Select all', ['Board'], 2), row('Credits', ['Help'], 1.2)];
  const used = [rowKey(['Help'], 'Credits')];
  assert.deepEqual(rank(rows, '', used).map(r => r.entry.label), ['Credits', 'Paste', 'Select all']);
  // Used before, and typed for: ahead of an equal match never used.
  const two = [row('Show grid', ['Board'], 2), row('Show axes', ['Board'], 2)];
  assert.equal(rank(two, 'show', [rowKey(['Board'], 'Show axes')])[0].entry.label, 'Show axes');
});

test('folds are laid out flat under their name, and what a menu hides stays hidden', () => {
  const rows = flatten([
    { label: 'Open', action: run },
    { label: 'Gone', hidden: true, action: run },
    { sep: true },
    { label: 'Showing 3 of 9', disabled: true },
    { label: 'Picture', sub: [{ label: 'Edit picture…', action: run }, { label: 'Fill the cells', action: run }] },
    { label: 'Spacing', range: { min: 0, max: 200, step: 4, get: () => 0, set: run } },
  ], ['Selection'], 3);
  assert.deepEqual(rows.map(r => [r.entry.label, r.path.join('/'), !!r.choice]), [
    ['Open', 'Selection', false],
    ['Edit picture…', 'Selection/Picture', true],
    ['Fill the cells', 'Selection/Picture', true],
    ['Spacing', 'Selection', false],
  ]);
});

test('one row per command, the nearest kept; a choice keeps its parent', () => {
  const kept = dedupe([
    row('Snap to grid', ['Settings', 'Board', 'Arrange'], 1),
    row('Snap to grid', ['Board'], 2),
    row('Warm', ['Selection', 'Colour'], 3, { choice: true }),
    row('Warm', ['Tools', 'Note'], 1.5, { choice: true }),
  ]);
  assert.deepEqual(kept.map(r => `${r.entry.label} ${r.path.join('/')}`),
    ['Snap to grid Board', 'Warm Selection/Colour', 'Warm Tools/Note']);
});

test('a recent row is known by its key, whatever count its label carries today', () => {
  assert.equal(rowKey(['3 selected'], 'Rearrange these 3'), rowKey(['12 selected'], 'Rearrange these 12'));
});

test('every command on the desktop menu bar is in the box', () => {
  // The menu bar's own commands, and where the box finds each: APP in
  // ui/palette.ts, a panel button, a toolbar tool, or one of the rows below,
  // which the box reads off a menu or off the page.
  const bar = [...read(join(ROOT, 'desktop', 'menu.ts')).matchAll(/\bcmd: '(\w+)'/g)].map(m => m[1]);
  assert.ok(bar.length >= 20, `only ${bar.length} commands read off desktop/menu.ts`);
  const palette = read(join(WEB, 'assets', 'js', 'ui', 'palette.ts'));
  const schema = read(join(WEB, 'assets', 'js', 'ui', 'settings-schema.ts'));
  const html = read(join(WEB, 'index.html'));
  const camel = s => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  const reached = new Set([
    ...[...palette.matchAll(/\bcmd: '(\w+)'/g)].map(m => m[1]),
    ...[...schema.matchAll(/\bcmd: '([\w-]+)'/g)].map(m => camel(m[1])),
    ...[...html.matchAll(/data-cmd="([\w-]+)"/g)].map(m => camel(m[1])),
  ]);
  const elsewhere = {
    undo: 'the Undo button (#history-ctl)',
    redo: 'the Redo button (#history-ctl)',
    selectAll: 'the board menu',
    deleteSelection: 'the card menu',
    fit: 'the Zoom to fit button (#zoom-ctl)',
    recenter: 'the Back to 0,0 button (#zoom-ctl)',
    timeline: 'Show timeline, in the panel',
  };
  const missing = bar.filter(cmd => !reached.has(cmd) && !elsewhere[cmd]);
  assert.deepEqual(missing, [], 'on the menu bar and nowhere in the S box');
});
