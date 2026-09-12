// The palette without color-mix(), the whole of what WebKit below 16.2 can
// render. The failure is silent - a stylesheet out of step with its
// fallback looks perfect on every machine here and wrong only on a phone
// not in the room. First half: the channel tokens and color-mix() calls
// against their fallbacks. Second half: the evaluator in ui/legacy-color.ts,
// run directly.

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
  // The direction that actually bites: a repalette adds --accent-warm to a
  // block and nothing fails, so the fallback quietly keeps the old amber.
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
  // Easy mistake that would make the whole exercise pointless: copy a rule
  // into the block and forget to convert one of its colours.
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
  // rgb(var(--nonexistent) / 40%) silently computes to nothing on the
  // browser this is for - the exact failure the fallback prevents,
  // reintroduced by a typo nothing in a browser would report.
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
  // A blend token is written by script, which may not have run yet, or at
  // all. Mostly backgrounds over the board, so resolving to nothing is not
  // a quiet degradation.
  const css = uncommented(appCss());
  for (const match of css.matchAll(/var\(\s*(--lc-[a-z0-9-]+)\s*([,)])/g)) {
    assert.equal(match[2], ',', `${match[1]} is read with no fallback behind it`);
  }
});

test('the script retakes a channel token for every one the stylesheet declares', () => {
  // The stylesheet only carries the four named palettes. A hand-picked or
  // photo-extracted pigment is written inline as --accent alone, so
  // --accent-c must be retaken from the resolved colour or every tint keeps
  // following the palette the board no longer wears.
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
  // A new two-colour token in tokens.css not added to MIXED_TOKENS resolves
  // to nothing below the floor.
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
  // premultiplied values, transparent premultiplies to nothing, so only the
  // alpha moves.
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
  // Harsh's actual shape: the sheet mixes accent into stock, the wells mix
  // ink into that. The engine hands the whole nest back as one string.
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
  // The caller leans on null meaning "leave this token alone" - a wrong
  // guess would write over a hand-picked colour.
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
