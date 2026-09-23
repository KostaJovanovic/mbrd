// Every icon is a <symbol> in web/assets/icons.svg, reached by name via
// <use href="assets/icons.svg#i-note">. A misspelled name is not an error
// anywhere - just a blank 16x16 hole - so references are checked against the
// sprite here, in both directions: unreferenced symbols are pruned too.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WEB, JS, read, walk } from './helpers.js';

const sprite = read(join(WEB, 'assets', 'icons.svg'));
const html = read(join(WEB, 'index.html'));
const menu = read(join(JS, 'ui', 'menu.ts'));

/** Every id the sprite defines. */
// Reads the whole tag rather than assuming id comes first - attribute order
// is the author's choice, and requiring a fixed order made some symbols
// invisible to every check in this file.
const defined = new Set(
  [...sprite.matchAll(/<symbol\b([^>]*)>/g)]
    .map(m => (/\bid="([^"]+)"/.exec(m[1]) ?? [])[1])
    .filter(Boolean));

/**
 * Every icon the app asks for, with where it asked. Three shapes: markup in
 * index.html, a <use href> built into a string, and a sprite URL held whole in
 * a single-quoted string for a script to hand to setAttribute() (the cleaning
 * glove's open and shut).
 *
 * Swept over every module rather than listed by hand - a hand-kept list of
 * files went stale twice already, reporting a real reference as an orphan.
 * Held to names beginning `i-`, the sprite's own convention, to exclude
 * things like the note toolbar's `al-center` class names.
 */
const iconNames = (text, where) => [
  ...[...text.matchAll(/href="assets\/icons\.svg#([^"]+)"/g)],
  ...[...text.matchAll(/'assets\/icons\.svg#(i-[a-z0-9-]+)'/g)],
].map(m => [m[1], where]);

/**
 * True when `at` in `src` sits in a comment: a line that opens with `//`, `/*`
 * or the `*` of a block comment, or a line whose `//` comes before `at`. A `//`
 * right after `:` is a URL and does not count.
 */
function inComment(src, at) {
  const start = src.lastIndexOf('\n', at - 1) + 1;
  const before = src.slice(start, at);
  return /^\s*(\/\/|\/\*|\*)/.test(before) || /(^|[^:])\/\//.test(before);
}

/**
 * Every quoted `i-…` literal in a module, outside comments. A module names an
 * icon in more ways than a few regexes can list - a lookup table
 * (conn-chip.ts's `fwd: 'i-arrow-fwd'`), a constant (drawer.ts's
 * `DRAWER_FACE`), an argument to a local helper (tour-edit.ts's
 * `iconButton(…, 'i-close', …)`) - and each shape the sweep did not know was a
 * name no test read. So every whole quoted literal counts, whatever holds it.
 */
const quotedIconNames = (src, where) =>
  [...src.matchAll(/(['"`])(i-[a-z0-9-]+)\1/g)]
    .filter(m => !inComment(src, m.index))
    .map(m => [m[2], where]);

const referenced = [
  ...iconNames(html, 'index.html'),
  ...walk(JS, ['.js', '.ts']).flatMap(rel => {
    const src = read(join(WEB, rel));
    return [...iconNames(src, rel), ...quotedIconNames(src, rel)];
  }),
];

test('the sprite defines something for every icon the app asks for', () => {
  // Guards the guard: a regex that matched nothing would let anything through.
  assert.ok(defined.size > 30, `only ${defined.size} symbols found - has the sprite moved?`);
  assert.ok(referenced.length > 40, `only ${referenced.length} references found`);

  const missing = referenced.filter(([name]) => !defined.has(name));
  assert.deepEqual(missing, [], `no <symbol> for: ${missing.map(m => m.join(' in ')).join(', ')}`);
});

test('the sprite carries nothing nobody asks for', () => {
  const asked = new Set(referenced.map(([name]) => name));
  const orphans = [...defined].filter(id => !asked.has(id));
  assert.deepEqual(orphans, [], `unreferenced symbols: ${orphans.join(', ')}`);
});

test('no comment in the sprite holds two hyphens in a row', () => {
  // SVG is XML, so two hyphens in a comment is a parse error that takes down
  // the whole sprite silently. It happened once, caused by a section heading
  // written as a rule of hyphens - the house style elsewhere, illegal here.
  for (const [, inner] of sprite.matchAll(/<!--([\s\S]*?)-->/g)) {
    assert.ok(!inner.includes('--'), `two hyphens inside a comment: "${inner.trim().slice(0, 48)}"`);
  }
});

/**
 * The one set drawn to a bigger box, and the only names allowed to be.
 *
 * The cleaning simulator's four are illustrations, not icons: three of them are
 * the thing in the hand at 56px for the length of the mode, with a gauge and a
 * load drawn over them, and a 16px glyph scaled three and a half times is a
 * blur. Named here one by one rather than by prefix, so a fifth has to be
 * argued for in this file - which is where "every symbol is one weight" is
 * being deliberately given up.
 */
const CLEAN_BOX = new Set([
  'i-clean-glove', 'i-clean-glove-held', 'i-clean-washer', 'i-clean-duster',
  'i-clean-can', 'i-clean-can-lid',
]);

test('every symbol is drawn to the same box', () => {
  // viewBox has no CSS equivalent - a symbol drawn to a different box is
  // scaled to the wrapper's 16px and lands at a different weight.
  // Reads attributes in either order: requiring id first made some symbols
  // invisible to this check, and the count assertion hid the gap.
  const symbols = [...sprite.matchAll(/<symbol\b([^>]*)>/g)]
    .map(([, attrs]) => ({
      id: (/\bid="([^"]+)"/.exec(attrs) ?? [])[1],
      box: (/\bviewBox="([^"]+)"/.exec(attrs) ?? [])[1],
    }));
  assert.equal(symbols.length, defined.size, 'a symbol the attribute scan cannot see');
  for (const { id, box } of symbols) {
    assert.ok(id, `a symbol with no id: viewBox ${box}`);
    assert.equal(box, CLEAN_BOX.has(id) ? '0 0 48 48' : '0 0 16 16',
      `${id} is drawn in ${box}`);
  }
});

test('the bigger box is not a door somebody walked through', () => {
  // Every name on the exception list has to exist, or the list is a licence
  // nobody is using and the next 48-box symbol slips in against a stale entry.
  const stale = [...CLEAN_BOX].filter(id => !defined.has(id));
  assert.deepEqual(stale, [], `on the 48-box list but not in the sprite: ${stale.join(', ')}`);
});

test('the sprite is in the service worker shell', () => {
  // A stale list here means an offline app opens with every button blank.
  // See SHELL in web/sw.js.
  const sw = readFileSync(join(WEB, 'sw.js'), 'utf8');
  assert.match(sw, /'\.\/assets\/icons\.svg'/);
});

test('no icon is drawn twice', () => {
  // Two <symbol>s with the same path data are two drawings of one thing that
  // will drift - the state index.html was in before the sprite existed.
  const shapes = [...sprite.matchAll(/<symbol\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/symbol>/g)]
    .map(([, id, body]) => [id, body.replace(/<!--[\s\S]*?-->/g, '').replace(/\s+/g, ' ').trim()]);
  const seen = new Map();
  for (const [id, body] of shapes) {
    const twin = seen.get(body);
    assert.equal(twin, undefined, `${id} is the same drawing as ${twin}`);
    seen.set(body, id);
  }
});

test('the right-click menu offers an icon on every entry', () => {
  // A column with gaps reads as broken and the eye stops using it. Every
  // entry that draws a row carries an icon; separators do not.
  // Checked per entry (walking each `label:` out to its enclosing object)
  // rather than by comparing totals - two equal totals can still hide one
  // entry that lost its icon while another gained a spare key.
  const labels = [...menu.matchAll(/\blabel:/g)];
  assert.ok(labels.length > 25, `only ${labels.length} entries found - has menu.ts moved?`);

  /** The `{ ... }` that immediately encloses this offset. */
  const enclosing = at => {
    let depth = 0, open = -1;
    for (let i = at; i >= 0; i--) {
      if (menu[i] === '}') depth++;
      else if (menu[i] === '{') { if (depth === 0) { open = i; break; } depth--; }
    }
    if (open === -1) return null;
    depth = 0;
    for (let i = open; i < menu.length; i++) {
      if (menu[i] === '{') depth++;
      else if (menu[i] === '}' && --depth === 0) return menu.slice(open, i + 1);
    }
    return null;
  };

  const bare = [];
  for (const m of labels) {
    const entry = enclosing(m.index);
    assert.ok(entry, `could not find the object literal around menu.ts:${m.index}`);
    if (!/\bicon:\s*'/.test(entry)) {
      bare.push((/\blabel:\s*'([^']*)'/.exec(entry) ?? [, `at offset ${m.index}`])[1]);
    }
  }
  assert.deepEqual(bare, [], `these menu entries draw a row with no icon: ${bare.join(', ')}`);
});

test('the padlock keeps its switch outside the shadow tree', () => {
  // A <use> renders into a shadow tree no selector can reach, so the
  // open/shut swap lives on two wrapper elements instead. Collapsing these
  // back into one <svg> makes chrome.css match nothing, silently.
  assert.match(html, /class="ico lock-open"[^>]*><use href="assets\/icons\.svg#i-lock-open"/);
  assert.match(html, /class="ico lock-shut"[^>]*><use href="assets\/icons\.svg#i-lock-shut"/);
});

test('nothing draws an icon inline any more', () => {
  // Except the origin mark: quality.css picks one of its three rings by
  // whimsy tier, which needs to reach inside the drawing, so it stays inline.
  // Comments are stripped first since some talk about the markup they replaced.
  const markup = html.replace(/<!--[\s\S]*?-->/g, '');
  const inline = [...markup.matchAll(/<svg\b[^>]*>/g)].map(m => m[0]);
  const strays = inline.filter(tag => !tag.includes('class="ico') && !tag.includes('id="origin-mark"'));
  assert.deepEqual(strays, [], `inline icons left in index.html: ${strays.join(' ')}`);
});
