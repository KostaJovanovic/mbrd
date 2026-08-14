// What a board is allowed to do to the interface.
//
// `settings.appearance.vars` is the only part of a .mbrd that reaches the
// browser as CSS rather than as content, and a .mbrd is a file that arrives
// from outside. These are the cases that used to get through, plus the parity
// check that keeps the allowlist honest as tokens.css grows.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { TOKENS, safeVars } from '../web/assets/js/ui/look.ts';
import { WEB, read } from './helpers.js';

// ---------------------------------------------------------------------------
// The two attacks
// ---------------------------------------------------------------------------

test('a board cannot set an ordinary CSS property', () => {
  // `display: none` on :root is the whole app gone, the moment the file opens,
  // with no script involved and nothing on screen to explain it.
  assert.deepEqual(safeVars({ display: 'none' }), {});
  assert.deepEqual(safeVars({ 'background-image': 'url(https://example.invalid/x)' }), {});
  assert.deepEqual(safeVars({ position: 'fixed', opacity: '0' }), {});
});

test('a board cannot make the app fetch anything', () => {
  // The privacy claim in the README is "nothing is uploaded". A URL in a token
  // that app.css substitutes somewhere is an outbound request that says the
  // board was opened, and when.
  assert.deepEqual(safeVars({ '--paper': 'url(https://example.invalid/opened)' }), {});
  assert.deepEqual(safeVars({ '--item-bg': 'image-set("https://example.invalid/x" 1x)' }), {});
  assert.deepEqual(safeVars({ '--font-body': 'local(x), url(https://example.invalid/f.woff2)' }), {});
});

test('a value cannot end its own declaration', () => {
  assert.deepEqual(safeVars({ '--paper': 'red; background-image: url(https://example.invalid/x)' }), {});
  assert.deepEqual(safeVars({ '--paper': 'red} :root{display:none' }), {});
  assert.deepEqual(safeVars({ '--paper': 'r\\65 d' }), {});
});

// ---------------------------------------------------------------------------
// ...without breaking a real look
// ---------------------------------------------------------------------------

test('the values a look actually carries all survive', () => {
  const look = {
    '--accent': '#8a4b2a',
    '--paper': 'rgb(245, 238, 224)',
    '--ink-2': 'oklch(0.42 0.03 60)',
    '--radius': '13px',
    '--grid-alpha': '0.18',
    '--density': '1.05',
    '--font-body': "'Geist', system-ui, sans-serif",
    '--shadow-1': '0 1px 2px rgba(0, 0, 0, 0.08)',
    '--ease-back': 'cubic-bezier(0.34, 1.56, 0.64, 1)',
    '--sidebar-w': 'clamp(260px, 30%, 460px)',
    '--select': 'color-mix(in srgb, #8a4b2a 60%, transparent)',
  };
  assert.deepEqual(safeVars(look), look);
});

test('one bad token costs the token, not the look', () => {
  const out = safeVars({ '--accent': '#123456', display: 'none', '--radius': '4px' });
  assert.deepEqual(out, { '--accent': '#123456', '--radius': '4px' });
});

test('non-string values are dropped rather than coerced', () => {
  assert.deepEqual(safeVars({ '--radius': 4 }), {});
  assert.deepEqual(safeVars({ '--radius': null }), {});
  assert.deepEqual(safeVars({ '--radius': { toString: () => 'url(x)' } }), {});
});

test('absent or malformed vars give an empty look', () => {
  assert.deepEqual(safeVars(undefined), {});
  assert.deepEqual(safeVars(null), {});
  assert.deepEqual(safeVars('vars'), {});
});

test('a value cannot be a document', () => {
  assert.deepEqual(safeVars({ '--paper': '#aabbcc '.repeat(40) }), {});
});

// ---------------------------------------------------------------------------
// Drift
// ---------------------------------------------------------------------------

test('the allowlist is exactly the tokens tokens.css declares', () => {
  // The same bargain as sw.js's SHELL. A token added to the stylesheet and not
  // here is one the Appearance panel can set but a saved board silently loses
  // on the way back in; a name here that the stylesheet dropped is a rule
  // guarding nothing. Neither shows up anywhere else.
  const css = read(join(WEB, 'assets', 'css', 'tokens.css'));
  const declared = new Set([...css.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map(m => m[1]));

  const missing = [...declared].filter(t => !TOKENS.has(t)).sort();
  const stale = [...TOKENS].filter(t => !declared.has(t)).sort();

  assert.deepEqual(missing, [], 'declared in tokens.css but not allowed in a look');
  assert.deepEqual(stale, [], 'allowed in a look but no longer in tokens.css');
});

test('the pre-paint anti-flash guard carries look.js\'s grammar and function allowlist', () => {
  // The inline script in index.html applies a saved look before ui/look.js can
  // load, so it must filter the same way - a poisoned localStorage could
  // otherwise apply display:none or a url() token before first paint (AUD-15).
  // It cannot import the module, so it carries the same grammar and function
  // list by hand; this holds the two together, like the dev-host regex does for
  // sw.js and util.js.
  const html = read(join(WEB, 'index.html'));
  const look = read(join(WEB, 'assets', 'js', 'ui', 'look.ts'));

  const SAFE_VALUE_SRC = "/^[-a-z0-9#%.,()/+*_'\" ]{1,160}$/i";
  assert.ok(look.includes(SAFE_VALUE_SRC), 'look.js SAFE_VALUE moved - update the anti-flash guard');
  assert.ok(html.includes(SAFE_VALUE_SRC), 'the anti-flash guard lost the shared value grammar');

  const lookBlock = look.match(/SAFE_FN = new Set\(\[([\s\S]*?)\]\)/)[1];
  const lookFns = [...lookBlock.matchAll(/'([a-z0-9-]+)'/g)].map(m => m[1]).sort();
  const htmlAlt = html.match(/SAFE_FN = \/\^\(([a-z0-9|-]+)\)\$\//)[1];
  const htmlFns = htmlAlt.split('|').sort();
  assert.deepEqual(htmlFns, lookFns, 'the anti-flash guard and look.js name different functions');

  // And the guard must also require a custom-property key, so display:none, which
  // is not a token url() can hide behind, cannot be applied either.
  assert.match(html, /\^--\[a-z0-9-\]\+\$/i, 'the anti-flash guard no longer requires a custom-property key');
});

test('the appearance panel no longer builds a density slider', () => {
  const source = read(join(WEB, 'assets', 'js', 'ui', 'appearance.ts'));
  assert.ok(!source.includes("label: 'Panel density'"));
  assert.ok(source.includes("label: 'Panel width'"));
});

test('the palette compares pictures by hash, without minting an object URL', () => {
  // ui/appearance.js is one of the three modules that touch a browser global at
  // import time, so this is asked of the source rather than of the module - the
  // same shape as the density-slider check above.
  //
  // The invariant: the walk that answers "have the sampled pictures changed?"
  // runs on every 'items' event, and assetURL() *mints* a blob URL on first use
  // and holds it for the session. Resolving inside the walk created one per
  // picture on the board - four hundred on a four-hundred-photo board, none of
  // them necessarily rendered - which is the laziness storage/assets.js exists
  // to preserve. Hashes are identity enough, and the URLs are resolved for the
  // handful actually read.
  const source = read(join(WEB, 'assets', 'js', 'ui', 'appearance.ts'));
  // Comments stripped: this one names assetURL() to explain why it is not called.
  const code = line => line.replace(/\/\/.*$/, '');
  const walk = source.match(/function pictureHashes\(\)[\s\S]*?\n}/)[0]
    .split('\n').map(code).join('\n');
  assert.ok(walk.includes('getAsset('), 'the walk should test registration, not resolve');
  assert.ok(!walk.includes('assetURL('), 'the walk must not mint an object URL per picture');

  const key = source.match(/function sourceKey\([^)]*\)[\s\S]*?\n}/)[0];
  assert.ok(key.includes('pictureHashes()'), 'the comparison key is built from hashes');

  // And the resolve that does happen is of the slice, not of the board.
  assert.match(source, /hashes\.slice\(0, sourceCount\(\)\)\.map\(assetURL\)/);
});

// ---------------------------------------------------------------------------
// Dynamic
// ---------------------------------------------------------------------------
//
// The gate itself is pure and tested in layout-settings.test.js. What is asked
// here is that the look model actually goes through it - the same shape as the
// checks above, because ui/appearance.js touches a browser global at import
// time and cannot be loaded in Node.

test('the board only ever colours itself through the three-picture gate', () => {
  const source = read(join(WEB, 'assets', 'js', 'ui', 'appearance.ts'));
  const strip = block => block.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

  // Every unasked-for run goes through autoRecolour(), which is the only thing
  // that asks the gate. A second bus handler calling recolourFromBoard() direct
  // would be a board colouring itself off one photograph again, and nothing on
  // screen would say why.
  const auto = strip(source.match(/function autoRecolour\(\)[\s\S]*?\n}/)[0]);
  assert.ok(auto.includes('autoPaletteReady('), 'the automatic path asks the gate');
  assert.ok(auto.includes('dynamicOn()'), 'and tells it whether the board is already dynamic');

  const calls = [...strip(source).matchAll(/recolourFromBoard\(/g)].length;
  // Four, and each one is a person: autoRecolour, the Dynamic entry, the whimsy
  // axis moving under an already-extracted palette, and the definition itself.
  assert.equal(calls, 4, 'a new caller of recolourFromBoard() needs a reason in this test');
  for (const fn of ['goDynamic', 'reshade']) {
    assert.ok(strip(source.match(new RegExp(`function ${fn}\\(\\)[\\s\\S]*?\\n}`))[0])
      .includes('recolourFromBoard('), `${fn} extracts without the floor`);
  }
  // Starting over is not a request for colour, so it goes through the gate.
  assert.ok(strip(source.match(/export function resetAppearance\(\)[\s\S]*?\n}/)[0])
    .includes('autoRecolour()'));
});

test('Dynamic is a state the menu reads, not a flag it remembers', () => {
  const source = read(join(WEB, 'assets', 'js', 'ui', 'appearance.ts'));
  // `auto` is permission and `derived` is provenance; neither is "the board is
  // wearing its pictures' colours right now", which is what the menu shows.
  // A look carried in from an older version has pigments and no `derived` flag,
  // and the menu has to say Dynamic on those boards too.
  assert.match(source,
    /const dynamicOn = \(\) => autoOn\(current\) && PALETTE_TOKENS\.some\(/);

  // And the entry never becomes a palette name: nothing writes it to
  // `current.palette`, so no board can save a data-palette no stylesheet answers
  // to and open in a look nobody can name.
  const controls = read(join(WEB, 'assets', 'js', 'ui', 'appearance-controls.ts'));
  const wire = controls.match(/export function wirePalette\(\)[\s\S]*?\n}\n/)[0];
  assert.ok(!wire.includes('.palette ='), 'the menu sets no palette of its own');
  // The branch, whatever the control is made of. It used to read `sel.value`
  // off a <select>; the row is a picker now - a button that opens ui/menu.ts,
  // because an <option> cannot paint the palette's own colours - so the value
  // arrives on the event that button dispatches. What is pinned is unchanged
  // and is the whole point of the test: Dynamic goes to goDynamic(), and only a
  // real palette name is ever handed to setPalette().
  assert.match(wire, /if \(value === DYNAMIC\) d\.goDynamic\(\);\s*\n\s*else d\.setPalette\(value\)/);
});
