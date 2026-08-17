// The palette without color-mix(), which is the whole of what WebKit below 16.2
// can render of this app's colour.
//
// Two halves, and both of them exist because the failure is silent. A stylesheet
// that has fallen out of step with its fallback looks perfect on every machine
// anybody here runs, and wrong only on a phone that is not in the room - so
// nothing about editing tokens.css would tell you that the block at the foot of
// it now says something different from the block at the top.
//
// The first half holds the two lists against each other: every channel-form
// token against the hex it was taken from, in both directions, and every
// color-mix() in the app against a fallback that covers it. The second half is
// the evaluator in ui/legacy-color.js, which is arithmetic and can simply be
// run - including the premultiplied-alpha identity that the whole rgb() spelling
// rests on.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { WEB, read, appCss } from './helpers.js';
import { _internals } from '../web/assets/js/ui/legacy-color.ts';

const CSS_DIR = join(WEB, 'assets', 'css');
const sheets = readdirSync(CSS_DIR).filter(f => f.endsWith('.css'));
const tokens = read(join(CSS_DIR, 'tokens.css'));

/** Comments carry example code, and an example is not a declaration. */
const uncommented = text => text.replace(/\/\*[\s\S]*?\*\//g, ' ');

const CONDITION = '@supports not (color: color-mix(in srgb, red, blue))';

// ---------------------------------------------------------------------------
// The channel tokens
// ---------------------------------------------------------------------------

/** Every `--x: #hex` in a block, keyed by the selector that opened it. */
function hexesByScope(text) {
  const out = new Map();
  let scope = null;
  for (const line of uncommented(text).split('\n')) {
    const opens = line.match(/^(:root[^{]*)\{/);
    if (opens) { scope = opens[1].trim(); continue; }
    if (line.startsWith('}')) { scope = null; continue; }
    const decl = line.match(/^\s*--([a-z0-9-]+):\s*(#[0-9a-fA-F]{3,8})\s*;/);
    if (decl && scope) {
      if (!out.has(scope)) out.set(scope, new Map());
      out.get(scope).set(decl[1], decl[2]);
    }
  }
  return out;
}

/** Every `--x-c: R G B` inside the @supports block, keyed the same way. */
function channelsByScope(text) {
  const start = uncommented(text).indexOf(CONDITION);
  const body = text.slice(start);
  const out = new Map();
  let scope = null;
  for (const line of uncommented(body).split('\n')) {
    const opens = line.match(/^\s{2}(:root[^{]*)\{/);
    if (opens) { scope = opens[1].trim(); continue; }
    const decl = line.match(/^\s*--([a-z0-9-]+)-c:\s*([\d]+)\s+([\d]+)\s+([\d]+)\s*;/);
    if (decl && scope) {
      if (!out.has(scope)) out.set(scope, new Map());
      out.get(scope).set(decl[1], [+decl[2], +decl[3], +decl[4]]);
    }
  }
  return out;
}

const hex2rgb = h => {
  const s = h.slice(1);
  const wide = s.length >= 6;
  const at = i => parseInt(wide ? s.substr(i * 2, 2) : s[i] + s[i], 16);
  return [at(0), at(1), at(2)];
};

test('every channel token is the colour it was taken from', () => {
  const hexes = channelsByScope(tokens);
  const source = hexesByScope(tokens);
  assert.ok(hexes.size >= 4, 'the four palettes should each carry a channel block');

  for (const [scope, channels] of hexes) {
    const from = source.get(scope);
    assert.ok(from, `${scope} declares channel tokens but no colours`);
    for (const [name, rgb] of channels) {
      // --select and --accent-fg are derived rather than declared, and are
      // checked by their own test below.
      if (name === 'select' || name === 'accent-fg') continue;
      const literal = from.get(name);
      assert.ok(literal, `--${name}-c has no --${name} in ${scope}`);
      assert.deepEqual(rgb, hex2rgb(literal),
        `--${name}-c in ${scope} says ${rgb.join(' ')} and --${name} is ${literal}`);
    }
  }
});

test('no colour in a palette has been given a channel token and then lost it', () => {
  // The other direction, and the one that actually bites: a repalette adds
  // --accent-warm to a block and nothing here fails, so the fallback quietly
  // keeps painting the old palette's amber.
  const hexes = channelsByScope(tokens);
  const source = hexesByScope(tokens);
  const base = hexes.get(':root');
  assert.ok(base, 'the base palette must carry channel tokens');

  for (const [scope, channels] of hexes) {
    if (scope === ':root') continue;
    const declared = source.get(scope) || new Map();
    for (const name of base.keys()) {
      if (name === 'select' || name === 'accent-fg') continue;
      // A palette that does not restate a colour inherits the base one, and
      // then must not restate its channel form either.
      if (!declared.has(name)) continue;
      assert.ok(channels.has(name),
        `${scope} sets --${name} but not --${name}-c, so the fallback keeps the base palette's`);
    }
  }
});

test('--select-c and --accent-fg-c follow what they are derived from', () => {
  const hexes = channelsByScope(tokens);
  const source = hexesByScope(tokens);
  for (const [scope, channels] of hexes) {
    const from = source.get(scope);
    // --select is var(--accent), so its channel form is the accent's.
    assert.deepEqual(channels.get('select'), channels.get('accent'),
      `--select-c in ${scope} has come away from --accent-c`);
    // --accent-fg is 45% of the sheet into white.
    const paper = hex2rgb(from.get('paper'));
    const want = paper.map(v => Math.round(v * 0.45 + 255 * 0.55));
    assert.deepEqual(channels.get('accent-fg'), want,
      `--accent-fg-c in ${scope} is not 45% of --paper into white`);
  }
});

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

test('every stylesheet that mixes a colour also says what to do without it', () => {
  for (const file of sheets) {
    const text = read(join(CSS_DIR, file));
    const body = uncommented(text);
    if (!/color-mix\(/.test(body)) continue;
    assert.ok(body.includes(CONDITION),
      `${file} uses color-mix() and has no ${CONDITION} block`);
  }
});

test('nothing inside a fallback block reaches for color-mix again', () => {
  // The mistake that would make the whole exercise pointless, and an easy one:
  // copy a rule down into the block and forget to convert one of its colours.
  for (const file of sheets) {
    const body = uncommented(read(join(CSS_DIR, file)));
    const at = body.indexOf(CONDITION);
    if (at < 0) continue;
    const after = body.slice(at + CONDITION.length);
    assert.ok(!/color-mix\(/.test(after),
      `${file} still mixes a colour inside its own fallback block`);
  }
});

test('a fallback never names a channel token that no palette declares', () => {
  // rgb(var(--nonexistent) / 40%) is invalid at computed-value time, which on
  // the browser this is for means the property silently computes to nothing -
  // the exact failure the fallback was written to prevent, reintroduced by a
  // typo. Nothing in a browser would report it.
  const declared = new Set();
  for (const map of channelsByScope(tokens).values()) {
    for (const name of map.keys()) declared.add(`--${name}-c`);
  }
  const css = uncommented(appCss());
  const used = new Set(css.match(/--[a-z0-9-]+-c\b/g) || []);
  for (const name of used) {
    assert.ok(declared.has(name), `${name} is used but declared by no palette`);
  }
});

test('every --lc- token a stylesheet reads is one the script writes', () => {
  const writes = new Set(_internals.BLENDS.map(b => b[0]));
  const css = uncommented(appCss());
  const used = new Set(css.match(/--lc-[a-z0-9-]+/g) || []);
  assert.ok(used.size > 0, 'the fallback blocks should read blend tokens');
  for (const name of used) {
    assert.ok(writes.has(name),
      `${name} is read by a stylesheet and computed by nobody`);
  }
  for (const name of writes) {
    assert.ok(used.has(name), `${name} is computed and read by nobody`);
  }
});

test('every --lc- token is read with a fallback colour behind it', () => {
  // A blend token is written by script, and script may not have run - at first
  // paint, or at all. These are mostly backgrounds on chrome that sits over the
  // board, so resolving to nothing is not a quiet degradation.
  const css = uncommented(appCss());
  for (const match of css.matchAll(/var\(\s*(--lc-[a-z0-9-]+)\s*([,)])/g)) {
    assert.equal(match[2], ',', `${match[1]} is read with no fallback behind it`);
  }
});

test('the script retakes a channel token for every one the stylesheet declares', () => {
  // The stylesheet can only carry the four named palettes. A pigment picked in
  // the Appearance panel, or one ui/pigments.js pulled out of a photograph, is
  // written inline as --accent alone - so --accent-c has to be retaken from the
  // resolved colour or every tint in the app keeps following the palette the
  // board is no longer wearing. Both directions: a channel token nobody retakes
  // goes stale, and one retaken for a colour that has no channel form is a
  // property written for nothing.
  const declared = new Set();
  for (const map of channelsByScope(tokens).values()) {
    for (const name of map.keys()) declared.add(`--${name}`);
  }
  const retaken = new Set(_internals.CHANNEL_TOKENS);
  for (const name of declared) {
    assert.ok(retaken.has(name),
      `${name}-c is declared in tokens.css and never retaken, so a hand-picked colour leaves it behind`);
  }
  for (const name of retaken) {
    assert.ok(declared.has(name), `${name}-c is retaken and declared by no palette`);
  }
});

test('the tokens the script fixes up are the ones tokens.css mixes', () => {
  // Both directions. A new two-colour token in tokens.css that nobody adds to
  // MIXED_TOKENS is a colour that resolves to nothing below the floor.
  const mixed = new Set();
  for (const line of uncommented(tokens).split('\n')) {
    const decl = line.match(/^\s*(--[a-z0-9-]+):\s*color-mix\(([^;]*)\)\s*;/);
    if (!decl) continue;
    // The alpha-only ones are restated in rgb() in the @supports block and are
    // not the script's business.
    if (/,\s*transparent\s*\)?\s*$/.test(decl[2])) continue;
    mixed.add(decl[1]);
  }
  const handled = new Set(_internals.MIXED_TOKENS);
  for (const name of mixed) {
    // --accent-fg is written out in channel form instead; see its test above.
    if (name === '--accent-fg') continue;
    assert.ok(handled.has(name),
      `${name} is a two-colour mix that legacy-color.js does not fix up`);
  }
  for (const name of handled) {
    assert.ok(mixed.has(name), `${name} is fixed up and mixed nowhere`);
  }
});

// ---------------------------------------------------------------------------
// The evaluator
// ---------------------------------------------------------------------------

const { parse, evaluate, css } = _internals;

test('a colour mixed with transparent is that colour at that alpha', () => {
  // The identity the entire rgb() spelling rests on: mixing is done on
  // premultiplied values, transparent premultiplies to nothing, so what comes
  // back is the original colour and nothing but its alpha has moved. If this
  // ever stopped being true, ninety-nine fallbacks would be wrong at once.
  const got = evaluate('in srgb, #31261b 42%, transparent');
  assert.deepEqual([got.r, got.g, got.b], [49, 38, 27]);
  assert.ok(Math.abs(got.a - 0.42) < 1e-9);
  assert.equal(css(got), 'rgb(49 38 27 / 42%)');
});

test('a two-colour mix lands where the arithmetic says', () => {
  const got = evaluate('in srgb, #000000 50%, #ffffff');
  assert.deepEqual([Math.round(got.r), Math.round(got.g), Math.round(got.b)], [128, 128, 128]);
  assert.equal(got.a, 1);
});

test('a nested mix resolves from the inside out', () => {
  // Harsh's actual shape: the sheet is a mix of the accent into stock, and the
  // wells are a mix of the ink into that. The engine hands the whole nest back
  // as one string, which is the property this module is built on.
  const got = evaluate(
    'in srgb, color-mix(in srgb, #b94900 13%, #000) 9%, color-mix(in srgb, #b94900 4%, #fafbfc)');
  assert.ok(got, 'a nested mix must resolve');
  assert.ok(got.r > 0 && got.r < 255);
  assert.equal(got.a, 1);
});

test('the share may be written on either side', () => {
  const first = evaluate('in srgb, #000000 25%, #ffffff');
  const second = evaluate('in srgb, #000000, #ffffff 75%');
  assert.equal(Math.round(first.r), Math.round(second.r));
});

test('hex comes in four lengths and all of them parse', () => {
  assert.deepEqual(parse('#fff'), { r: 255, g: 255, b: 255, a: 1 });
  assert.deepEqual(parse('#ffffff'), { r: 255, g: 255, b: 255, a: 1 });
  assert.deepEqual(parse('#31261b'), { r: 49, g: 38, b: 27, a: 1 });
  const short = parse('#0008');
  assert.deepEqual([short.r, short.g, short.b], [0, 0, 0]);
  assert.ok(Math.abs(short.a - 0x88 / 255) < 1e-9);
});

test('rgb() parses in both spellings', () => {
  assert.deepEqual(parse('rgb(1, 2, 3)'), { r: 1, g: 2, b: 3, a: 1 });
  assert.deepEqual(parse('rgb(1 2 3)'), { r: 1, g: 2, b: 3, a: 1 });
  const withAlpha = parse('rgb(1 2 3 / 50%)');
  assert.equal(withAlpha.a, 0.5);
});

test('something that is not a colour is not guessed at', () => {
  // The caller leans on null meaning "leave this token alone", so a wrong guess
  // here would write a colour over one somebody picked by hand.
  assert.equal(parse('var(--accent)'), null);
  assert.equal(parse('inherit'), null);
  assert.equal(parse(''), null);
  assert.equal(evaluate('in srgb, #fff'), null);
});

test('a fully transparent result stays transparent rather than dividing by zero', () => {
  const got = evaluate('in srgb, transparent 50%, transparent');
  assert.deepEqual(got, { r: 0, g: 0, b: 0, a: 0 });
});

test('splitting arguments respects the nesting', () => {
  assert.deepEqual(_internals.args('a, b, c'), ['a', 'b', 'c']);
  assert.deepEqual(_internals.args('in srgb, f(x, y) 9%, g(z, w)'),
    ['in srgb', 'f(x, y) 9%', 'g(z, w)']);
});
