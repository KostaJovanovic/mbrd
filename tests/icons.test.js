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

import { WEB, JS, read } from './helpers.js';

const sprite = read(join(WEB, 'assets', 'icons.svg'));
const html = read(join(WEB, 'index.html'));
const menu = read(join(JS, 'ui', 'menu.js'));
const fencePrompt = read(join(JS, 'ui', 'fence-prompt.js'));

/** Every id the sprite defines. */
const defined = new Set([...sprite.matchAll(/<symbol\s+id="([^"]+)"/g)].map(m => m[1]));

/**
 * Every icon the app asks for, with where it asked.
 *
 * Two shapes, because there are two ways in: markup written by hand in
 * index.html, and the name handed to icon() in the modules that build a row.
 */
const referenced = [
  ...[...html.matchAll(/href="assets\/icons\.svg#([^"]+)"/g)].map(m => [m[1], 'index.html']),
  ...[...menu.matchAll(/icon: '([^']+)'/g)].map(m => [m[1], 'ui/menu.js']),
  ...[...menu.matchAll(/icon\('([^']+)'/g)].map(m => [m[1], 'ui/menu.js']),
  ...[...fencePrompt.matchAll(/icon\('([^']+)'/g)].map(m => [m[1], 'ui/fence-prompt.js']),
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

test('every symbol is drawn to the same box', () => {
  // The spec that is not in CSS. Stroke and fill are inherited properties and
  // live on .ico in base.css, so they are written once; the viewBox cannot be,
  // and a symbol drawn in a different one is scaled to the wrapper's 16px and
  // arrives at a weight nothing else in the set is at.
  const boxes = [...sprite.matchAll(/<symbol\s+id="([^"]+)"\s+viewBox="([^"]+)"/g)];
  assert.equal(boxes.length, defined.size, 'a symbol without a viewBox');
  for (const [, id, box] of boxes) {
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
  const shapes = [...sprite.matchAll(/<symbol\s+id="([^"]+)"[^>]*>([\s\S]*?)<\/symbol>/g)]
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
  const labels = menu.match(/\blabel:/g) ?? [];
  const icons = menu.match(/\bicon: '/g) ?? [];
  assert.ok(labels.length > 25, `only ${labels.length} entries found - has menu.js moved?`);
  assert.equal(icons.length, labels.length,
    `${labels.length} entries but ${icons.length} icons`);
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
