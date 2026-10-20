// The wallpaper at Softish (research/wallpaper-graphics-2026-10-20.md): the
// family a palette picks, the tones, the stable pick, the board record, and
// every arrangement file held to the contract ui/wallpaper.ts and the CSP need.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { FAMILIES, PIECES, PIECE_NAMES, edgeShare, familyOf, wallpaperTones, pieceByName, pieceFor, pieceURL, tierSwitch, TONES } from '../web/assets/js/ui/wallpaper-pieces.ts';
import { normalizeWallpaper } from '../web/assets/js/board-schema.ts';
import { oklch, parseHex } from '../web/assets/js/color.ts';

const WEB = join(import.meta.dirname, '..', 'web');
const lch = h => oklch(...parseHex(h));

test('a palette picks its family by its accent', () => {
  assert.equal(familyOf(lch('#3f7a3a')), 'green');
  assert.equal(familyOf(lch('#2f5fb3')), 'blue');
  assert.equal(familyOf(lch('#c2402f')), 'red');
  assert.equal(familyOf(lch('#7a4bb0')), 'purple');
  assert.equal(familyOf(lch('#808080')), 'grey');
  assert.equal(familyOf(lch('#111111')), 'black');
  for (const hex of ['#ffd400', '#f08a24', '#f4a6c0', '#7a5230', '#fafafa']) {
    assert.ok(FAMILIES.includes(familyOf(lch(hex))), hex);
  }
});

test('the tones sink from the paper in the light and stay low-key in the dark', () => {
  const paper = lch('#e9edd8'), accent = lch('#3f7a3a');
  const light = wallpaperTones(paper, accent, false);
  for (const t of [...TONES, 'eye']) assert.match(light[t], /^#[0-9a-f]{6}$/, t);
  const L = TONES.map(t => lch(light[t]).L);
  assert.ok(L[0] > paper.L, 'the highlight is above the paper');
  for (let i = 1; i < L.length; i++) assert.ok(L[i] < L[i - 1], `tone ${TONES[i]} deeper than the one before`);
  const dark = wallpaperTones(lch('#23271d'), accent, true);
  const D = TONES.map(t => lch(dark[t]).L);
  assert.ok(D[0] > D[5], 'the dark set still runs from highlight to shade');
  assert.ok(D.every(v => v < 0.55), 'and stays low-key');
});

test('a board lands on the same arrangement every time, inside its family', () => {
  for (const family of FAMILIES) {
    const n = pieceFor('brd-abc', family);
    assert.equal(pieceFor('brd-abc', family), n);
    assert.ok(n >= 1 && n <= PIECES[family], `${family}: ${n}`);
  }
});

test('every piece has a name to be chosen by, and only real pieces can be chosen', () => {
  const all = FAMILIES.flatMap(f => Array.from({ length: PIECES[f] }, (_, i) => `${f}-${i + 1}`));
  assert.deepEqual(Object.keys(PIECE_NAMES).sort(), [...all].sort());
  for (const name of all) assert.ok(pieceByName(name), name);
  for (const bad of ['', 'pink', 'pink-0', 'pink-3', 'teal-1', 'pink-1x', '../pink-1']) assert.equal(pieceByName(bad), null, bad);
});

test('the zoom decides how much of the window each side takes', () => {
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  assert.ok(near(edgeShare(1), 0.1), 'a tenth each at 100%');
  assert.ok(near(edgeShare(0.8), 0.2));
  assert.equal(edgeShare(1.2), 0, 'gone at 120%');
  assert.equal(edgeShare(3), 0);
  assert.ok(near(edgeShare(0.6), 0.3));
  assert.equal(edgeShare(0.1), 0.3, 'never more than 30%');
});

test('the wallpaper record keeps only what it may', () => {
  const plain = { show: true, middle: false, harsh: false, asset: null, tone: false, piece: null };
  assert.deepEqual(normalizeWallpaper(undefined), plain);
  assert.deepEqual(normalizeWallpaper({ show: 0, middle: 1, harsh: 'yes', asset: 'nope', tone: 'yes', piece: 7 }), plain);
  const hash = 'a'.repeat(64);
  assert.deepEqual(normalizeWallpaper({ show: false, middle: true, harsh: true, asset: hash, tone: true, piece: 'pink-1' }),
    { show: false, middle: true, harsh: true, asset: hash, tone: true, piece: 'pink-1' });
});

test('a piece picked by hand is the board\'s, and a new board has none', () => {
  // It was a per-device pref, and every board opened after a choice wore it.
  // A record without the key - every board before it, and a new one - is the
  // palette's pick.
  assert.equal(normalizeWallpaper({ show: true }).piece, null);
  // Shaped like a name or dropped; whether this version has the piece is
  // ui/wallpaper.ts's question, so a newer version's name survives a save.
  assert.equal(normalizeWallpaper({ piece: 'teal-40' }).piece, 'teal-40');
  for (const bad of ['', 'pink', 'Pink-1', 'pink-1; x', '../pink-1', 'p'.repeat(40) + '-1']) {
    assert.equal(normalizeWallpaper({ piece: bad }).piece, null, bad);
  }
});

test('each whimsy tier reads its own wallpaper switch', () => {
  assert.equal(tierSwitch('0'), 'show');
  assert.equal(tierSwitch(1), 'middle');
  assert.equal(tierSwitch('2'), 'harsh');
  for (const off of [undefined, '', 'x', 0.5, 3]) assert.equal(tierSwitch(off), null, String(off));
});

// The art. Read as text: the app parses it with DOMParser, which node has not.
const COLOUR_ATTRS = /\s(fill|stroke|stop-color|flood-color|lighting-color|color)="([^"]*)"/g;
const CLASS_TONE = /^(f|k|s)-(hi|[1-5]|eye)$/;
// One <style> is allowed: preview colours for opening the file on its own,
// which parsePiece() removes. Only tone classes and the root's background.
const PREVIEW = /<style>((?:(?:svg\{background|\.f-(?:hi|[1-5]|eye)\{fill|\.k-(?:hi|[1-5]|eye)\{stroke|\.s-(?:hi|[1-5]|eye)\{stop-color):#[0-9a-f]{6}\})*)<\/style>/i;

for (const family of FAMILIES) {
  for (let n = 1; n <= PIECES[family]; n++) {
    const name = `${family}-${n}`;
    test(`${name}.svg keeps the contract`, () => {
      const path = join(WEB, pieceURL(family, n));
      assert.ok(existsSync(path), `no ${pieceURL(family, n)}`);
      const file = readFileSync(path, 'utf8');
      assert.ok(file.length <= 45 * 1024, `${file.length} bytes`);
      const svg = file.replace(PREVIEW, '');
      assert.match(svg, /<svg\b[^>]*\bviewBox="0 0 600 1000"/);
      assert.doesNotMatch(svg, /<svg\b[^>]*\s(width|height)="/, 'no fixed size on the root');
      assert.doesNotMatch(svg, /<(script|style|image|text|foreignObject|a|animate\w*|set)\b/i, 'a forbidden element');
      assert.doesNotMatch(svg, /\sstyle="|\son\w+="/i, 'an inline style or a handler (the CSP blocks both)');
      assert.doesNotMatch(svg, /(?:xlink:)?href="(?!#)/, 'a reference out of the file');
      for (const [, attr, value] of svg.matchAll(COLOUR_ATTRS)) {
        assert.ok(value === 'none' || /^url\(#[^)]+\)$/.test(value), `${attr}="${value}": colour comes from classes`);
      }
      assert.doesNotMatch(svg, /\bcurrentColor\b|\brgba?\(|#[0-9a-f]{3}(?:[0-9a-f]{3})?\b(?![-\w])/i, 'a literal colour');
      for (const [, id] of svg.matchAll(/\sid="([^"]+)"/g)) assert.ok(id.startsWith(`${name}-`), `id ${id}`);
      for (const [, list] of svg.matchAll(/\sclass="([^"]+)"/g)) {
        for (const cls of list.split(/\s+/)) assert.ok(cls === 'wp-item' || CLASS_TONE.test(cls), `class ${cls}`);
      }
      const items = [...svg.matchAll(/<g\b[^>]*\bclass="[^"]*\bwp-item\b[^"]*"[^>]*>/g)].map(m => m[0]);
      assert.ok(items.length <= 3, `${items.length} pieces`);
      for (const tag of items) assert.match(tag, /\sdata-pivot="-?\d+(?:\.\d+)?[\s,]+-?\d+(?:\.\d+)?"/, 'a piece without its pivot');
    });
  }
}
