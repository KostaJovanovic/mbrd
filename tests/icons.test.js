// The icon sprite, and the one thing that can go wrong with it quietly.
//
// Every icon in the app is a <symbol> in web/assets/icons.svg, reached by name:
//
//   <svg class="ico"><use href="assets/icons.svg#i-note"/></svg>
//
// A name that does not match anything in the sprite is not an error anywhere. No
// console warning, no failed request - the browser fetches the file, finds no
// such id, and draws nothing. What you get is a 16x16 hole where an icon was
// meant to be, on whichever menu entry or button happens to be spelled wrong,
// which is exactly the kind of thing that ships. So the references are checked
// against the sprite here instead.
//
// The other direction too: a symbol nobody references is a drawing that is
// downloaded by every visitor and seen by none. Not a bug, but the sprite is
// meant to be the set of icons the app *has*, and a set nothing prunes stops
// being that within a few changes.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WEB, JS, read, walk } from './helpers.js';

const sprite = read(join(WEB, 'assets', 'icons.svg'));
const html = read(join(WEB, 'index.html'));
const menu = read(join(JS, 'ui', 'menu.ts'));

/** Every id the sprite defines. */
// Attribute order is the author's choice, not the format's - so this reads the
// whole tag and picks the id out of it. Requiring id to come first made a
// `<symbol viewBox="..." id="...">` invisible to every check in this file at
// once, including the two directions below: an unseen symbol is neither missing
// nor an orphan.
const defined = new Set(
  [...sprite.matchAll(/<symbol\b([^>]*)>/g)]
    .map(m => (/\bid="([^"]+)"/.exec(m[1]) ?? [])[1])
    .filter(Boolean));

/**
 * Every icon the app asks for, with where it asked.
 *
 * Three shapes, because there are three ways in: markup written by hand in
 * index.html, the name handed to icon() or put in an `icon:` field by a module
 * that builds a row, and the same <use href> written into a string by a module
 * that builds its own markup.
 *
 * **All three are swept over every module rather than listed**, and it is worth
 * saying why. The href sweep was a list of two files, and the day the volume
 * slider moved from index.html into ui/playlist.js the sprite grew an orphan
 * that this file reported as a symbol nobody asks for - the reference was real
 * and simply not being looked at. The other two were still lists of two files
 * afterwards, and cost exactly the same thing again the day the timeline strip
 * grew a table of icons: two symbols the app uses every time it draws a step,
 * reported here as symbols nobody wants.
 *
 * Held to names beginning `i-`, which is the sprite's own convention and is what
 * separates these from the note toolbar's `al-center` and the rest, which are
 * class names for a different mechanism and are not in the sprite at all.
 */
const iconNames = (text, where) => [
  ...[...text.matchAll(/href="assets\/icons\.svg#([^"]+)"/g)],
  ...[...text.matchAll(/icon: '(i-[a-z0-9-]+)'/g)],
  ...[...text.matchAll(/icon\('(i-[a-z0-9-]+)'/g)],
].map(m => [m[1], where]);

const referenced = [
  ...iconNames(html, 'index.html'),
  ...walk(JS, ['.js', '.ts']).flatMap(rel => iconNames(read(join(WEB, rel)), rel)),
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
  // SVG is XML, so this is a parse error, and a parse error takes down the
  // whole file rather than the comment - every icon in the app disappears at
  // once, with no console warning and no failed request. It has happened once,
  // in the sticker sprite (tests/stickers.test.js carries the same check), and
  // the thing that caused it was a section heading written as a rule of
  // hyphens: the house style everywhere else in this codebase, and illegal
  // here. Hence the ═ rules above.
  for (const [, inner] of sprite.matchAll(/<!--([\s\S]*?)-->/g)) {
    assert.ok(!inner.includes('--'), `two hyphens inside a comment: "${inner.trim().slice(0, 48)}"`);
  }
});

test('every symbol is drawn to the same box', () => {
  // The spec that is not in CSS. Stroke and fill are inherited properties and
  // live on .ico in base.css, so they are written once; the viewBox cannot be,
  // and a symbol drawn in a different one is scaled to the wrapper's 16px and
  // arrives at a weight nothing else in the set is at.
  //
  // Attributes read in either order. The regex used to require id before
  // viewBox, so `<symbol viewBox="0 0 24 24" id="i-x">` - the order half the
  // drawing tools emit - was invisible to this check and to the two below it.
  // The count assertion hid it: a symbol the regex could not see was a symbol
  // it did not count either.
  const symbols = [...sprite.matchAll(/<symbol\b([^>]*)>/g)]
    .map(([, attrs]) => ({
      id: (/\bid="([^"]+)"/.exec(attrs) ?? [])[1],
      box: (/\bviewBox="([^"]+)"/.exec(attrs) ?? [])[1],
    }));
  assert.equal(symbols.length, defined.size, 'a symbol the attribute scan cannot see');
  for (const { id, box } of symbols) {
    assert.ok(id, `a symbol with no id: viewBox ${box}`);
    assert.equal(box, '0 0 16 16', `${id} is drawn in ${box}`);
  }
});

test('the sprite is in the service worker shell', () => {
  // Hand-kept list, and the kind that goes stale exactly this way: an app that
  // opens offline with every button blank looks broken in a way that has
  // nothing to do with icons. See SHELL in web/sw.js.
  const sw = readFileSync(join(WEB, 'sw.js'), 'utf8');
  assert.match(sw, /'\.\/assets\/icons\.svg'/);
});

test('no icon is drawn twice', () => {
  // The whole point of the file. Two <symbol>s with the same path data are two
  // drawings of one thing that will drift, which is the state index.html was in
  // before the sprite existed - three close crosses and two pens, each a few
  // characters different from its twin.
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
  // A column that is a column only where somebody remembered reads as a menu
  // with pieces missing, and the eye stops using it. Every entry that draws a
  // row carries one; separators are not rows.
  //
  // Counted off `label:`, which is what makes an entry an entry. The two are
  // written on the same object, so an entry that gained a label without an icon
  // shows up here as a count that does not match.
  // Checked per entry rather than by counting. Two totals compared is a balance
  // that balances: one entry losing its icon while another gains a second key
  // leaves the sums equal and the menu with a hole in the column. So each
  // `label:` is walked out to the object literal that holds it, and that object
  // is asked for its own icon.
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
  // The one icon whose insides used to be addressed from the page. A <use>
  // renders into a shadow tree no selector can reach, so the open/shut swap had
  // to move out to the wrappers - two of them, one per state. If these ever
  // collapse back into a single <svg>, chrome.css goes on matching nothing and
  // the padlock draws both shackles at once, in silence.
  assert.match(html, /class="ico lock-open"[^>]*><use href="assets\/icons\.svg#i-lock-open"/);
  assert.match(html, /class="ico lock-shut"[^>]*><use href="assets\/icons\.svg#i-lock-shut"/);
});

test('nothing draws an icon inline any more', () => {
  // Except the origin mark, which cannot: quality.css picks one of its three
  // rings by whimsy tier, and that is a rule reaching inside the drawing - the
  // one thing an external <use> forbids. It is 36 units across and is a marker
  // on the board rather than an icon on a button, so it is not in the set that
  // moved. Everything else in index.html is a reference.
  // Comments out first: several of them talk about the markup they replaced,
  // and a note explaining why there is no longer an inline <svg> here should not
  // read as one.
  const markup = html.replace(/<!--[\s\S]*?-->/g, '');
  const inline = [...markup.matchAll(/<svg\b[^>]*>/g)].map(m => m[0]);
  const strays = inline.filter(tag => !tag.includes('class="ico') && !tag.includes('id="origin-mark"'));
  assert.deepEqual(strays, [], `inline icons left in index.html: ${strays.join(' ')}`);
});
