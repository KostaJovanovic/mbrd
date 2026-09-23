// What a board is allowed to do to the interface.
//
// `settings.appearance.vars` is the only part of a .mbrd that reaches the
// browser as CSS, and a .mbrd is a file from outside. Covers the attacks that
// used to get through, plus parity checks that keep the allowlist honest.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { TOKENS, safeVars } from '../web/assets/js/ui/look.ts';
import {
  PALETTE_TOKENS, TYPOGRAPHY_TOKENS, AXIS_TOKENS,
} from '../web/assets/js/layout-settings.ts';
import { ROOT, WEB, read } from './helpers.js';

/**
 * tokens.css down to the point where it stops describing the look.
 *
 * Section 7 is the WebKit<16.2 fallback inside `@supports not`: derived
 * tokens, not part of the look API. Cut here or the parity tests below would
 * count it as fourteen new pigments per palette.
 */
const lookTokens = () => {
  const css = read(join(WEB, 'assets', 'css', 'tokens.css'));
  const at = css.indexOf('@supports not (color: color-mix(in srgb, red, blue))');
  return at < 0 ? css : css.slice(0, at);
};

// ---------------------------------------------------------------------------
// The two attacks
// ---------------------------------------------------------------------------

test('a board cannot set an ordinary CSS property', () => {
  // `display: none` on :root is the whole app gone the moment the file opens.
  assert.deepEqual(safeVars({ display: 'none' }), {});
  assert.deepEqual(safeVars({ 'background-image': 'url(https://example.invalid/x)' }), {});
  assert.deepEqual(safeVars({ position: 'fixed', opacity: '0' }), {});
});

test('a board cannot make the app fetch anything', () => {
  // The README claims "nothing is uploaded" - a URL in a token app.css
  // substitutes is an outbound request revealing the board was opened.
  assert.deepEqual(safeVars({ '--paper': 'url(https://example.invalid/opened)' }), {});
  assert.deepEqual(safeVars({ '--item-bg': 'image-set("https://example.invalid/x" 1x)' }), {});
  assert.deepEqual(safeVars({ '--font-body': 'local(x), url(https://example.invalid/f.woff2)' }), {});
});

test('a look that still says "Same as display" for the body reads as the default', () => {
  // The option left the body font list (research/old/done-2026-09-15.md, R6).
  assert.deepEqual(safeVars({ '--font-body': 'var(--font-display)' }), {});
  assert.deepEqual(safeVars({ '--font-body': 'var( --font-display )' }), {});
  // The display face may still point anywhere it could before.
  assert.deepEqual(safeVars({ '--font-display': 'var(--font-sans)' }), { '--font-display': 'var(--font-sans)' });
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
  // Same bargain as sw.js's SHELL: a token added to the stylesheet and not
  // here is one a saved board silently loses on the way back in.
  const css = lookTokens();
  const declared = new Set([...css.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map(m => m[1]));

  const missing = [...declared].filter(t => !TOKENS.has(t)).sort();
  const stale = [...TOKENS].filter(t => !declared.has(t)).sort();

  assert.deepEqual(missing, [], 'declared in tokens.css but not allowed in a look');
  assert.deepEqual(stale, [], 'allowed in a look but no longer in tokens.css');
});

/**
 * Every custom property a set of blocks in tokens.css declares.
 *
 * Comments come off first - this file discusses token names in prose inside
 * the very blocks being read.
 */
function declaredIn(pattern) {
  const css = lookTokens().replace(/\/\*[\s\S]*?\*\//g, '');
  const out = new Set();
  for (const block of css.matchAll(pattern)) {
    for (const decl of block[2].matchAll(/(--[a-z0-9-]+)\s*:/g)) out.add(decl[1]);
  }
  return out;
}

const WHIMSY_BLOCKS = /:root\[data-whimsy="(\d)"\]\s*\{([\s\S]*?)\n\}/g;
const PALETTE_BLOCKS = /:root\[data-palette="([a-z0-9-]+)"\]\s*\{([\s\S]*?)\n\}/g;

test('PALETTE_TOKENS covers every token a palette block sets', () => {
  // A pigment set by a [data-palette] block but missing here is one
  // dropPigments()/setPalette() leave inline after a switch - looks like the
  // palette is wrong rather than the list being short.
  const declared = declaredIn(PALETTE_BLOCKS);
  assert.ok(declared.size >= 10, `only ${declared.size} tokens found - has the block shape moved?`);
  const missing = [...declared].filter(t => !PALETTE_TOKENS.includes(t)).sort();
  assert.deepEqual(missing, [], 'set by a [data-palette] block and not in PALETTE_TOKENS');
  // The list is allowed to be wider: --accent-fg/--accent-text are derived from
  // the accent per whimsy tier, not per palette, so they travel without being
  // written in a block.
  const extra = PALETTE_TOKENS.filter(t => !declared.has(t));
  assert.deepEqual(extra, ['--accent-fg', '--accent-text'],
    'PALETTE_TOKENS carries a name no palette block sets, and it is not one of the documented two');
});

test('the whimsy axis owns every token only a whimsy block sets', () => {
  // AXIS_TOKENS used to hold only three of the sixty tokens the [data-whimsy]
  // blocks declare, so a saved --item-shadow or --tilt-max survived every move
  // of the slider. Rule: the axis owns what only the axis declares; a token a
  // palette block also sets belongs to the palette instead.
  const whimsy = declaredIn(WHIMSY_BLOCKS);
  assert.ok(whimsy.size >= 40, `only ${whimsy.size} tokens found - has the block shape moved?`);
  const owned = new Set([...PALETTE_TOKENS, ...TYPOGRAPHY_TOKENS]);
  const want = [...whimsy].filter(t => !owned.has(t)).sort();
  assert.deepEqual([...AXIS_TOKENS].sort(), want,
    'AXIS_TOKENS and the [data-whimsy] blocks have drifted - a token set per tier '
    + 'and missing here goes on ignoring the slider');
});

// The combined selectors of section 3b: one palette dressed for one end of the
// axis. Whimsy attribute first, deliberately - see the test below.
const COMBO_BLOCKS = /:root\[data-whimsy="([02])"\]\[data-palette="([a-z0-9-]+)"\]\s*\{([\s\S]*?)\n\}/g;

test('every palette is dressed at both ends of the axis', () => {
  // A bare `:root[data-whimsy="0"]` has the same specificity as
  // `:root[data-palette="orca"]` but comes later, so it would win and paint the
  // default pastel over Orca's colours. The (0,3,0) combined selectors in
  // section 3b stop that - a palette missing one wears somebody else's colours,
  // silently.
  const css = lookTokens().replace(/\/\*[\s\S]*?\*\//g, '');
  const palettes = [...css.matchAll(PALETTE_BLOCKS)].map(m => m[1]);
  assert.ok(palettes.length >= 3, `only ${palettes.length} palettes found - has the block shape moved?`);

  const combos = new Map();
  for (const m of css.matchAll(COMBO_BLOCKS)) {
    combos.set(`${m[1]}/${m[2]}`, [...m[3].matchAll(/(--[a-z0-9-]+)\s*:/g)].map(d => d[1]));
  }

  const undressed = [];
  for (const tier of ['0', '2']) {
    for (const name of palettes) if (!combos.has(`${tier}/${name}`)) undressed.push(`${tier}/${name}`);
  }
  assert.deepEqual(undressed, [],
    'a palette with no block at this tier renders in the default look\'s pigments there '
    + '- regenerate with tools/gen-tier-palettes.mjs');

  // And a combo may only set pigment. Anything else in one is a token the
  // palette switch will not clear, pinned by a selector no slider can outrank.
  for (const [key, tokens] of combos) {
    const stray = tokens.filter(t => !PALETTE_TOKENS.includes(t)).sort();
    assert.deepEqual(stray, [], `${key} sets something that is not a pigment`);
  }
});

test('the combined tier-and-palette selectors are invisible to the two parity tests', () => {
  // The two tests above read blocks by regex and would misread a combo block -
  // PALETTE_BLOCKS as a fifth palette, AXIS_TOKENS as per-tier palette tokens.
  // They're blind to 3b only because whimsy comes first in its selector; that's
  // a property of this file's formatting, not of CSS, so it's asserted here.
  const sample = ':root[data-whimsy="0"][data-palette="orca"] {\n  --accent: #80b6af;\n}';
  assert.equal(sample.match(new RegExp(PALETTE_BLOCKS.source)), null,
    'a combo block now reads as a palette block - PALETTE_TOKENS parity is counting section 3b');
  assert.equal(sample.match(new RegExp(WHIMSY_BLOCKS.source)), null,
    'a combo block now reads as a whimsy block - AXIS_TOKENS parity is counting section 3b');
});

test('the pre-paint anti-flash guard carries look.js\'s grammar and function allowlist', () => {
  // The inline script in index.html applies a saved look before ui/look.ts can
  // load, so a poisoned localStorage could apply display:none or a url()
  // before first paint (AUD-15) unless it filters the same way. It can't
  // import the module, so it carries the grammar and function list by hand.
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

  // The guard must also require a custom-property key, so display:none cannot
  // be applied either.
  assert.match(html, /\^--\[a-z0-9-\]\+\$/i, 'the anti-flash guard no longer requires a custom-property key');
});

test('the anti-flash guard holds whimsy and palette to their shapes too', () => {
  // `dataset.whimsy`/`dataset.palette` used to be written straight out of
  // localStorage while the quality dial nearby was held to its three stops.
  // All three reach the page as `[data-*]` attributes, so all three should be
  // checked the same way - whimsy a stop on a three-point axis, palette a
  // short slug, same rules as readLook().
  const html = read(join(WEB, 'index.html'));
  const look = read(join(WEB, 'assets', 'js', 'ui', 'look.ts'));

  assert.match(html, /\/\^\[0-2\]\$\/\.test\(String\(s\.whimsy\)\)/,
    'the anti-flash guard writes data-whimsy without checking it');
  const PALETTE_SRC = '/^[a-z0-9-]{1,24}$/i';
  assert.ok(look.includes(PALETTE_SRC), 'look.js moved its palette-id pattern - update the anti-flash guard');
  assert.ok(html.includes(PALETTE_SRC), 'the anti-flash guard writes data-palette without checking it');

  // The guard spells the three stops as a character class it can't import from
  // WHIMSY - a fourth stop is where the two would disagree.
  const stops = look.match(/WHIMSY = \[([^\]]*)\]/)[1].split(',').length;
  assert.equal(stops, 3, `WHIMSY has ${stops} stops - the inline /^[0-2]$/ no longer covers it`);
});

test('the desktop title bar puts on the look by the same rules', () => {
  // desktop/chrome/look.ts is the third copy. The bar is its own page, so the
  // pre-paint script never runs there. It imports the token filter from
  // ui/look.ts, and web/ exports no reader for the other three, so it writes
  // those checks out, and this holds them to index.html's.
  const html = read(join(WEB, 'index.html'));
  const bar = read(join(ROOT, 'desktop', 'chrome', 'look.ts'));

  assert.match(bar, /import \{ safeVars \} from '\.\.\/\.\.\/web\/assets\/js\/ui\/look\.ts';/,
    'the bar no longer takes the token filter from ui/look.ts');
  for (const src of ['/^[0-2]$/', '/^[a-z0-9-]{1,24}$/i', '/^(light|balanced|full)$/']) {
    assert.ok(html.includes(src), `index.html's pre-paint script lost ${src} - update the bar too`);
    assert.ok(bar.includes(src), `desktop/chrome/look.ts does not check with ${src} as index.html does`);
  }
});

test('the appearance panel no longer builds a density slider', () => {
  const source = read(join(WEB, 'assets', 'js', 'ui', 'appearance.ts'));
  assert.ok(!source.includes("label: 'Panel density'"));
  assert.ok(source.includes("label: 'Panel width'"));
});

const PICTURE_PALETTE = join(WEB, 'assets', 'js', 'ui', 'picture-palette.ts');

test('the palette compares pictures by hash, without minting an object URL', () => {
  // Asked of the source, like the density-slider check above: the property is
  // what the walk calls, not what it returns.
  //
  // The walk answering "have the sampled pictures changed?" runs on every
  // 'items' event, and assetURL() mints a blob URL on first use. Resolving
  // inside the walk would mint one per picture on the board - hashes are
  // identity enough, and URLs are resolved only for the handful actually read.
  const source = read(PICTURE_PALETTE);
  // Comments stripped: one names assetURL() to explain why it isn't called.
  const code = line => line.replace(/\/\/.*$/, '');
  const walk = source.match(/function pictureHashes\(\)[\s\S]*?\n}/)[0]
    .split('\n').map(code).join('\n');
  assert.ok(walk.includes('getAsset('), 'the walk should test registration, not resolve');
  assert.ok(!walk.includes('assetURL('), 'the walk must not mint an object URL per picture');

  // The body, not the signature - `sourceKey(hashes = pictureHashes())`'s
  // default parameter satisfied the old check even with an empty body.
  const decl = source.match(/function sourceKey\([\s\S]*?\n}/)[0];
  const body = decl.slice(decl.indexOf('{') + 1);
  assert.ok(body.includes('hashes'), 'the comparison key is built from the hashes it was handed');
  assert.ok(body.includes('sourceCount()'),
    'and from the source dial - a key over every picture is a key that never settles');
  assert.ok(!body.includes('assetURL('), 'the key must not mint an object URL either');

  // The resolve that does happen is of the slice, which sourceCount() caps at
  // ALL_SOURCES_MAX - all samplePixels() will ever read. Not at MAX_SOURCES:
  // that clamp is what made "Every photo" read 24.
  assert.match(source, /hashes\.slice\(0, sourceCount\(\)\)\.map\(assetURL\)/);
});

// ---------------------------------------------------------------------------
// Dynamic
// ---------------------------------------------------------------------------
//
// The gate is pure and tested in layout-settings.test.js; this asks that the
// look model actually goes through it, checked against source since
// ui/appearance.ts can't be loaded in Node. The extraction itself is in
// ui/picture-palette.ts, so the callers are counted across the two.

test('the board only ever colours itself through the three-picture gate', () => {
  const source = read(join(WEB, 'assets', 'js', 'ui', 'appearance.ts'));
  const palette = read(PICTURE_PALETTE);
  const strip = block => block.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

  // Every unasked-for run goes through autoRecolour(), the only thing that
  // asks the gate. A second bus handler calling recolourFromBoard() direct
  // would colour the board off one photograph silently.
  const auto = strip(palette.match(/function autoRecolour\(\)[\s\S]*?\n}/)[0]);
  assert.ok(auto.includes('autoPaletteReady('), 'the automatic path asks the gate');
  assert.ok(auto.includes('dynamicOn()'), 'and tells it whether the board is already dynamic');

  const calls = [...strip(source + palette).matchAll(/recolourFromBoard\(/g)].length;
  // Four callers: autoRecolour, the Dynamic entry, the whimsy axis, and the
  // definition itself. A new one needs a reason here.
  assert.equal(calls, 4, 'a new caller of recolourFromBoard() needs a reason in this test');
  for (const fn of ['goDynamic', 'reshade']) {
    assert.ok(strip(source.match(new RegExp(`function ${fn}\\(\\)[\\s\\S]*?\\n}`))[0])
      .includes('recolourFromBoard('), `${fn} extracts without the floor`);
  }
  // Starting over is not a colour request either, so it also goes through the gate.
  assert.ok(strip(source.match(/export function resetAppearance\(\)[\s\S]*?\n}/)[0])
    .includes('autoRecolour()'));
});

test('Dynamic is a state the menu reads, not a flag it remembers', () => {
  const source = read(PICTURE_PALETTE);
  // `auto` is permission and `derived` is provenance; neither means "the board
  // is wearing its pictures' colours right now", which is what the menu shows -
  // and an older board with pigments but no `derived` flag still needs to.
  assert.match(source,
    /const dynamicOn = \(\) => autoOn\(d\.current\(\)\) && PALETTE_TOKENS\.some\(/);

  // The entry never becomes a palette name: nothing writes it to
  // `current.palette`, so no board saves a data-palette nothing can name.
  const controls = read(join(WEB, 'assets', 'js', 'ui', 'appearance-controls.ts'));
  const wire = controls.match(/export function wirePalette\(\)[\s\S]*?\n}\n/)[0];
  assert.ok(!wire.includes('.palette ='), 'the menu sets no palette of its own');
  // The branch, not the control: it used to read `sel.value` off a <select>,
  // now a picker button dispatches the value instead. What's pinned is
  // unchanged: Dynamic goes to goDynamic(), a real name goes to setPalette().
  assert.match(wire, /if \(value === DYNAMIC\) d\.goDynamic\(\);\s*\n\s*else d\.setPalette\(value\)/);
});

test('the picture palette loads without a browser and reads the source dial', async () => {
  // Moved out of ui/appearance.ts so it could be asked in Node at all (R22).
  const { setSetting } = await import('../web/assets/js/state.ts');
  const { sourceCount, ALL_SOURCES_MAX, ALL_SOURCES_STOP } =
    await import('../web/assets/js/ui/picture-palette.ts');
  const { MAX_SOURCES } = await import('../web/assets/js/ui/pigments.ts');
  assert.equal(ALL_SOURCES_STOP, MAX_SOURCES + 1, 'the "all" stop sits one past the last number');
  setSetting('paletteSources', 3);
  assert.equal(sourceCount(), 3);
  setSetting('paletteSources', 0);
  assert.equal(sourceCount(), ALL_SOURCES_MAX, '0 is every picture, up to the cap');
  setSetting('paletteSources', 12);
});
