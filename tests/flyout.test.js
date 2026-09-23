// The toolbar's hover flyouts, and the three ways they can quietly stop
// being about the buttons they hang off.
//
// Almost none of this is testable - dwell, bar-swap, grace period and
// placement are pointer behaviour, and the panel is ui/menu.ts's, tested
// where it lives. What's checkable: the table names real buttons, its rows
// match their catalogues, and the one behaviour change underneath (a note
// can be asked for a colour) left the old behaviour untouched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { WEB, JS, read } from './helpers.js';
import { FLYOUTS, arrangeEntries, noteEntries, colourEntries, computedHex } from '../web/assets/js/ui/flyout.ts';
import { ARRANGEMENTS } from '../web/assets/js/arrange/arrangements.ts';
import { NOTE_TINTS, addNote } from '../web/assets/js/import/drop.ts';
import { fresh } from './state-fixtures.js';

const html = read(join(WEB, 'index.html'));

/** The toolbar and nothing else on the page. */
const bar = html.match(/<div id="toolbar"[\s\S]*?\n<\/div>/)?.[0] ?? '';

test('every button the table names is a button on the bar', () => {
  assert.ok(bar, 'no #toolbar found in index.html - has the markup moved?');
  const keys = Object.keys(FLYOUTS);
  assert.ok(keys.length >= 3, `only ${keys.length} flyouts`);
  for (const cmd of keys) {
    assert.match(
      bar, new RegExp(`data-cmd="${cmd}"`),
      `FLYOUTS names "${cmd}" and the toolbar has no such button`,
    );
  }
});

test('a button with a flyout carries no title', () => {
  // A native tooltip appears about a second into a hover, half a second
  // after the flyout - drawing a second box over the first for the same
  // gesture. The button's word is the label; aria-label carries the rest.
  for (const cmd of Object.keys(FLYOUTS)) {
    const tag = bar.match(new RegExp(`<button[^>]*data-cmd="${cmd}"[^>]*>`))?.[0] ?? '';
    assert.ok(tag, `no <button> tag for ${cmd}`);
    assert.doesNotMatch(tag, /\stitle=/, `${cmd} still has a title, which will draw over its flyout`);
    assert.match(tag, /aria-label="/, `${cmd} lost its title and gained no aria-label`);
  }
});

// ---------------------------------------------------------------------------
// The three lists
// ---------------------------------------------------------------------------

/** Just enough command surface for the builders, which read nothing else. */
const stub = (over = {}) => ({
  arrangement: () => 'spiral',
  hasSelection: () => true,
  settingNumber: () => 12,
  setSetting: () => {},
  arrangeAs: () => {},
  rearrangeSelection: () => {},
  addNote: () => {},
  addSwatch: () => {},
  addSwatchOf: () => {},
  ...over,
});

test('a pigment swatch reads a computed colour in either spelling', () => {
  assert.equal(computedHex('rgb(23, 10, 0)'), '#170a00');
  assert.equal(computedHex('rgba(255, 128, 0, 0.5)'), '#ff8000');
  // A token mixed `in srgb` computes to channels 0-1, which read as 0-255
  // made the Harsh "Ink" swatch #000000.
  assert.equal(computedHex('color(srgb 0.09 0.04 0)'), '#170a00');
  assert.equal(computedHex('color(srgb 1 .5 0 / 0.5)'), '#ff8000');
});

test('the layouts are the arrangement catalogue, in its order', () => {
  // Not a list of seven written out here - kept in step by hand, an
  // arrangement added to arrangements.ts is one the panel offers and the
  // flyout silently doesn't.
  const rows = arrangeEntries(stub()).filter(e => e.check != null);
  assert.deepEqual(rows.map(r => r.label), ARRANGEMENTS.map(a => a.label));

  // The line above can't see this: arrangeEntries builds rows out of
  // ARRANGEMENTS, so comparing the two compares the implementation with
  // itself. The pair that can actually drift is the flyout and the panel.
  const schema = read(join(JS, 'ui', 'settings-schema.ts'));
  const opts = /id: 'arrangement'[\s\S]*?\boptions:([\s\S]*?)\bget:/.exec(schema);
  assert.ok(opts, "no 'arrangement' control in settings-schema.ts - has it moved?");
  assert.match(opts[1], /\bARRANGEMENTS\b/,
    'the settings panel builds its arrangement rows from somewhere other than '
    + 'the catalogue, so the panel and the flyout can now offer different shapes');
});

test('exactly one layout is ticked, and it is the one the board is in', () => {
  const rows = arrangeEntries(stub({ arrangement: () => 'masonry' })).filter(e => e.check != null);
  const ticked = rows.filter(r => r.check);
  assert.equal(ticked.length, 1, 'a radio with none or two ticked is not a radio');
  assert.equal(ticked[0].label, 'Masonry');
});

test('a board set to something the catalogue does not have ticks nothing', () => {
  // Ticking the first row would falsely claim the board is in Spiral - a
  // .mbrd is a file somebody can edit.
  const rows = arrangeEntries(stub({ arrangement: () => 'herringbone' })).filter(e => e.check != null);
  assert.equal(rows.filter(r => r.check).length, 0);
});

test('Rearrange selection is absent when there is no selection', () => {
  const has = arrangeEntries(stub({ hasSelection: () => true }));
  const not = arrangeEntries(stub({ hasSelection: () => false }));
  assert.equal(has.find(e => e.label === 'Rearrange selection')?.hidden, false);
  assert.equal(not.find(e => e.label === 'Rearrange selection')?.hidden, true);
});

test('the spacing dial reads and writes the spacing setting', () => {
  let wrote = null;
  const rows = arrangeEntries(stub({
    settingNumber: key => (key === 'spacing' ? 44 : undefined),
    setSetting: (key, v) => { wrote = [key, v]; },
  }));
  const dial = rows.find(e => e.range);
  assert.ok(dial, 'no range row in the Arrange flyout');
  assert.equal(dial.range.get(), 44);
  dial.range.set(80);
  assert.deepEqual(wrote, ['spacing', 80]);
});

test('the pad offers every sheet the notes are printed on, and only those', () => {
  const rows = noteEntries(stub());
  assert.equal(rows.length, NOTE_TINTS);

  // Against tokens.css, which the old expectation never actually checked -
  // it was built character-for-character the same way noteEntries builds
  // the row, so it held however many sheets NOTE_TINTS named regardless of
  // what tokens.css declared. The failure to catch is a fifth sheet in one
  // file and not the other.
  const tokens = read(join(WEB, 'assets', 'css', 'tokens.css'));
  const sheets = new Set([...tokens.matchAll(/^\s*--note-(\d+):/gm)].map(m => Number(m[1])));
  assert.ok(sheets.size > 0, 'no --note-N tokens found - has tokens.css moved?');
  assert.deepEqual([...sheets].sort((a, b) => a - b),
    Array.from({ length: NOTE_TINTS }, (_, i) => i + 1),
    `tokens.css declares ${sheets.size} note sheets and NOTE_TINTS says ${NOTE_TINTS}`);

  for (const [i, row] of rows.entries()) {
    const named = /^var\((--note-\d+)\)$/.exec(row.swatch);
    assert.ok(named, `row ${i + 1} draws its chip as ${row.swatch}, not as a token`);
    assert.ok(tokens.includes(`${named[1]}:`), `${named[1]} is not declared in tokens.css`);
  }
});

test('picking a sheet asks for that sheet by number', () => {
  const asked = [];
  const rows = noteEntries(stub({ addNote: t => asked.push(t) }));
  for (const row of rows) row.action();
  assert.deepEqual(asked, [1, 2, 3, 4], 'the rows are one-based and in order');
});

test('the colour flyout ends with the picker it used to be', () => {
  // A shortcut past the dialog, never a replacement - any other colour
  // still needs the picker.
  const rows = colourEntries(stub());
  const last = rows[rows.length - 1];
  assert.match(last.label, /^Pick a colour/);
  assert.equal(rows.filter(r => r.swatch).length, 5);
});

// ---------------------------------------------------------------------------
// The one behaviour underneath the feature
// ---------------------------------------------------------------------------
//
// addNote() grew a third argument so the pad could ask for a sheet.
// Everything else calls it with two, so these tests confirm the old
// behaviour is unchanged.

test('a note asked for a sheet gets that sheet', () => {
  fresh();
  assert.equal(addNote({ x: 0, y: 0 }, '', 4).meta.tint, 4);
  assert.equal(addNote({ x: 0, y: 0 }, '', 1).meta.tint, 1);
});

test('a note asked for nothing still comes off the pad in order', () => {
  fresh();
  const tints = Array.from({ length: NOTE_TINTS + 1 }, () => addNote({ x: 0, y: 0 }).meta.tint);
  assert.deepEqual(tints, [1, 2, 3, 4, 1], 'the cycle is what every drop and paste gets');
});

test('a sheet the pad does not have falls back to the cycle', () => {
  // Not clamped: four tints are a set of sheets, not a scale, so there's no
  // nearest one to round a 9 to.
  fresh();
  addNote({ x: 0, y: 0 });                                   // takes tint 1
  for (const bad of [0, -1, 9, 1.5, null, undefined, 'red']) {
    fresh();
    addNote({ x: 0, y: 0 });
    assert.equal(addNote({ x: 0, y: 0 }, '', bad).meta.tint, 2, `${bad} should have cycled`);
  }
});

// ---------------------------------------------------------------------------
// The renderer the panel is drawn by
// ---------------------------------------------------------------------------

test('ui/menu.js can draw the two row kinds these lists use', () => {
  // The builders emit `swatch` and `range` entries; menu.ts turns them into
  // rows. Nothing else uses either kind yet, so a dead-code tidy-up would
  // leave the flyouts drawing blank lines.
  const menu = read(join(JS, 'ui', 'menu.ts'));
  assert.match(menu, /entry\.swatch/, 'the renderer no longer handles a swatch row');
  assert.match(menu, /entry\.range/, 'the renderer no longer handles a range row');
  assert.match(menu, /export function openAnchored/, 'the anchored open has gone');
});

test('the flyout wears the menu panel and no shape of its own', () => {
  // Used to assert the opposite: an `.is-flyout` block squaring two
  // corners. That second shape escaped - openAnchored() applied it to every
  // anchored menu, drawing the settings panel's colour picker with a side
  // missing. One shape now; this checks the variant hasn't come back.
  const css = read(join(WEB, 'assets', 'css', 'menu.css'));
  assert.doesNotMatch(css, /\.is-flyout/, 'a second panel shape is back in menu.css');
  assert.match(css, /#ctx-menu, #ctx-child\s*\{/, 'the menu panel has no rule');
  assert.match(css, /\.ctx-chip\s*\{/, 'the colour chips have no rule');
  assert.match(css, /\.ctx-range\s*\{/, 'the spacing row has no rule');
});

test('the spacing dial is drawn as a slider on this paper, not the browser default', () => {
  // The ruled track and lozenge live in sidebar.css, named per slider rather
  // than per panel. quality.css squares that lozenge at the plain whimsy end
  // off the same list - one list in two files, so a .ctx-range missing from
  // either is a slider from the browser or one that kept its diamond.
  const bar = /:is\(([^)]*)\)\s*input\[type="range"\]/;
  const named = css => css.match(bar)?.[1].split(',').map(s => s.trim()) ?? [];

  const sidebar = named(read(join(WEB, 'assets', 'css', 'sidebar.css')));
  assert.ok(sidebar.includes('.ctx-range'), `sidebar.css draws sliders for ${sidebar.join(', ')}`);

  const whimsy = read(join(WEB, 'assets', 'css', 'quality.css'))
    .match(/data-whimsy="2"\]\s*:is\(([^)]*)\)\s*input\[type="range"\]/)?.[1]
    .split(',').map(s => s.trim()) ?? [];
  assert.deepEqual(whimsy, sidebar, 'the whimsy override and the slider rule name different sliders');
});
