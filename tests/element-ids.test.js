// The contract between the markup and the stylesheets, which nothing else checks.
//
// The CSS in this app addresses the furniture by id. Over five hundred selector
// occurrences across the sheets name eighty-odd distinct ids: #toolbar, #bin,
// #viewer, #search-hits, #ctx-menu. Most of those are literal id="..." in
// web/index.html; the rest are on nodes a module builds at runtime and hands an
// id to.
//
// Neither half is checked by anything. Rename an element in index.html, or move
// the line in ui/search.js that says `node.id = 'search'`, and the rules that
// styled it stop matching. There is no error. No console warning, no failed
// request, no parse failure - the selector is still perfectly valid CSS, it just
// describes a node that no longer exists. What you get is the thing drawn
// unstyled: a dialog with no chrome, a button at the browser's default size, a
// panel that used to be positioned and is now wherever it happened to land. It
// looks like a layout bug rather than a rename, which is why it costs an
// afternoon rather than a minute.
//
// This is the same shape of problem as the icon sprite, and it is checked the
// same way - tests/icons.test.js is the sibling to read. Both directions matter:
//
//   1. Every id a selector names resolves to something. Either a literal id in
//      index.html, or a name on the JS_BUILT table below. This is the half that
//      catches a rename.
//
//   2. Every name on JS_BUILT is really built by a module under web/assets/js/,
//      and is really asked for by a selector. This is the half that stops the
//      table from becoming a list of excuses - an allow-list nobody prunes is
//      an allow-list that eventually allows everything, and the first direction
//      is only as strong as the second keeps it.
//
// What is deliberately *not* asserted: that every id in index.html has a rule.
// Thirty-odd do not - the whole #mobile-header-* family, the #ask-*/#pick-*
// dialog controls, #version, #file-input, #nojs. They are handles for JS, not
// hooks for CSS, and "has an id" carries no information about whether anything
// styles it. Flagging them would be flagging the normal case.
//
// The stylesheets are walked rather than listed, because the CSS is mid-split by
// subsystem and a hardcoded list would go stale on the next file. Reading the
// directory means a new sheet is covered the moment it exists.

import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WEB, JS, read, walk } from './helpers.js';

const CSS_DIR = join(WEB, 'assets', 'css');
const html = read(join(WEB, 'index.html'));

/**
 * The ids on nodes no HTML file contains, because a module makes them.
 *
 * Each is a real element with real rules written against it; the only thing that
 * separates it from #toolbar is that the DOM node is created in JavaScript, so
 * grepping index.html for it finds nothing. The value is what the node *is*,
 * which is the part of this table worth reading - the module that builds it is
 * checked below rather than written here, so that a builder moving between
 * modules does not silently make this comment a lie.
 */
const JS_BUILT = {
  'appearance-fonts': 'the font list, poured into a slot the settings schema declares',
  'bin-ghost': 'the card that flies into the bin as it is deleted',
  'conn-chip': 'the little editor that follows a selected connection',
  'ctx-child': 'the hover submenu flown out beside a fold - the menu node again, once',
  'ctx-menu': 'the right-click menu - every menu in the app is this one node',
  'exit-layer': 'the overlay an exit animation is drawn on, above everything',
  'fence-ghost': 'the preview rectangle drawn while a fence is being placed',
  'fence-prompt': 'the name-this-fence prompt',
  'ghost-whimsy-stops': 'the whimsy-tier gradient stops inside a ghost card',
  'library': 'the board switcher',
  'search': 'the Find panel',
  'search-field': 'the Find input',
  'search-hits': 'the Find results list',
  'web': 'the SVG layer every connection is drawn into',
  'whimsy-stop-labels': 'the tick labels under the whimsy slider',
};

/**
 * Every id a *selector* names, with the sheet it was named in.
 *
 * Walked a character at a time rather than matched, because the naive pattern is
 * wrong in a way that looks right: `#[a-z-]+` over a stylesheet also matches
 * every hex colour literal in it - #fff, #a38686, #1c1917 - and this codebase
 * has enough of those to bury the real answer in a hundred and thirty phantoms.
 * The distinction is positional, not lexical: an id only means an id in selector
 * text. So the text before each `{` is the only thing read, comments are dropped
 * first so that prose about a colour is not scanned, and at-rule preludes are
 * skipped because `@media (min-width: 700px)` is not a selector. A declaration
 * ends at its `;` and a rule at its `}`, which is what keeps a property value
 * from ever being mistaken for a prelude.
 */
function selectorIds(src) {
  const out = [];
  let buf = '';
  for (const ch of src.replace(/\/\*[\s\S]*?\*\//g, '')) {
    if (ch === '{') {
      const selector = buf.trim();
      buf = '';
      if (!selector || selector.startsWith('@')) continue;
      for (const m of selector.matchAll(/#([A-Za-z_][\w-]*)/g)) out.push(m[1]);
      continue;
    }
    if (ch === '}' || ch === ';') { buf = ''; continue; }
    buf += ch;
  }
  return out;
}

/** [id, sheet] for every id-selector occurrence in every stylesheet. */
const styled = walk(CSS_DIR, ['.css']).flatMap(rel =>
  selectorIds(read(join(WEB, rel))).map(id => [id, rel]));

/** Every id written literally into the markup, in order, duplicates kept. */
const declared = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
const inHtml = new Set(declared);

/**
 * Every id some module under web/assets/js/ hands to a node, with the module.
 *
 * Four forms, and only four, because a fifth would have to guess. `node.id =` and
 * `setAttribute('id', …)` are how a node is given one; `getElementById` is how a
 * node built elsewhere is found again, which counts because something has to
 * have built it; and the settings schema declares two of its own by data - a
 * `slot` the panel fills in later, and the `stopsId` on the whimsy slider.
 *
 * An id assembled from pieces - `'exit-' + kind`, `` `${prefix}-fill` `` - is
 * invisible to all four and always will be. That is fine here: no *id* in the
 * CSS is built that way (the interpolated names in this codebase are all
 * classes), and a regex loose enough to catch one would be loose enough to
 * confirm anything. If that ever changes, the honest fix is another explicit
 * form, not a wider pattern.
 */
const BUILD_FORMS = [
  /\.id\s*=\s*'([\w-]+)'/g,
  /setAttribute\('id',\s*'([\w-]+)'\)/g,
  /getElementById\('([\w-]+)'\)/g,
  /\bid:\s*'([\w-]+)',\s*type:\s*'slot'/g,
  /\bstopsId:\s*'([\w-]+)'/g,
];

const built = walk(JS, ['.js', '.ts']).flatMap(rel => {
  const src = read(join(WEB, rel));
  return BUILD_FORMS.flatMap(re => [...src.matchAll(re)].map(m => [m[1], rel]));
});

test('every id the CSS styles is an element that exists', () => {
  // Guards the guard: an extractor that matched nothing would let anything
  // through, and this one is a hand-rolled walk over a syntax, which is exactly
  // the sort of thing that quietly starts returning an empty list.
  const distinct = new Set(styled.map(([id]) => id));
  assert.ok(distinct.size > 60,
    `only ${distinct.size} distinct ids found in the CSS - has the extractor broken?`);
  assert.ok(styled.length > 400, `only ${styled.length} id selectors found`);
  assert.ok(declared.length > 90,
    `only ${declared.length} ids found in index.html - has the markup moved?`);

  const orphans = [...new Map(styled.map(([id, sheet]) => [id, sheet]))]
    .filter(([id]) => !inHtml.has(id) && !(id in JS_BUILT))
    .map(([id, sheet]) => `#${id} (${sheet})`);
  assert.deepEqual(orphans, [],
    `these selectors name nothing: ${orphans.join(', ')}. Either the element was ` +
    'renamed and the rule needs to follow it, or the rule outlived the element ' +
    'and should go. If a module builds the node at runtime, add it to JS_BUILT ' +
    'in this file.');
});

test('every id on the JS_BUILT table is really built by a module', () => {
  assert.ok(built.length > 40, `only ${built.length} built ids found under ${JS} - has the sweep broken?`);

  const makes = new Set(built.map(([id]) => id));
  const stale = Object.keys(JS_BUILT).filter(id => !makes.has(id));
  assert.deepEqual(stale, [],
    `nothing under web/assets/js/ builds: ${stale.map(id => `#${id}`).join(', ')}. ` +
    'The node is gone, so the rules written against it are dead - delete the ' +
    'selector and the entry, or fix the name in whichever module lost it.');
});

test('the JS_BUILT table carries nothing that does not need to be on it', () => {
  // Two ways an entry stops earning its place, and both leave it looking
  // harmless. A node that moved into index.html is now checked by the first
  // test on its own merits; an entry kept beside it is a second, weaker answer
  // that would go on covering the id after the markup dropped it again. And an
  // entry no selector asks about is not part of a CSS contract at all - it is a
  // JS handle, and this file has no business having an opinion about it.
  const asked = new Set(styled.map(([id]) => id));
  const redundant = Object.keys(JS_BUILT).filter(id => inHtml.has(id));
  assert.deepEqual(redundant, [],
    `index.html already declares: ${redundant.map(id => `#${id}`).join(', ')} - ` +
    'drop the JS_BUILT entry, the markup covers it.');

  const unasked = Object.keys(JS_BUILT).filter(id => !asked.has(id));
  assert.deepEqual(unasked, [],
    `no stylesheet mentions: ${unasked.map(id => `#${id}`).join(', ')} - ` +
    'JS_BUILT is the list of runtime nodes the CSS styles, not of every id the ' +
    'app makes. Drop the entry.');
});

test('no id is declared twice in index.html', () => {
  // Invalid HTML, and it fails the way this whole file is about: getElementById
  // returns the first one, every id selector matches both, and which of the two
  // you are looking at depends on which one you found. The document is one
  // file, so this is cheap to keep true.
  const seen = new Set();
  const twice = declared.filter(id => (seen.has(id) ? true : (seen.add(id), false)));
  assert.deepEqual(twice, [], `declared more than once: ${twice.join(', ')}`);
});
