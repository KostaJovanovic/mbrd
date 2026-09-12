// Markup-to-stylesheet contract: every CSS id selector must resolve to a
// real element, and every JS_BUILT entry must be used. Same shape as
// icons.test.js. Stylesheets are walked, not listed — the CSS is mid-split
// and a hardcoded list would go stale.

import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WEB, JS, read, walk } from './helpers.js';

const CSS_DIR = join(WEB, 'assets', 'css');
const html = read(join(WEB, 'index.html'));

/**
 * The ids on nodes no HTML file contains, because a module makes them.
 *
 * Each is a real element with real rules against it - the only difference
 * from #toolbar is that the node is created in JavaScript, so grepping
 * index.html finds nothing. The value is what the node is; which module
 * builds it is checked below rather than written here, so a builder moving
 * between modules can't silently make this comment a lie.
 */
const JS_BUILT = {
  'appearance-fonts': 'the font list, poured into a slot the settings schema declares',
  'conn-chip': 'the little editor that follows a selected connection',
  'drawer-ghost': 'the copy of a card that follows the pointer out of the drawer',
  'drawer-window': 'the drawer of what you deleted - a floating window, built on open',
  'ctx-child': 'the hover submenu flown out beside a fold - the menu node again, once',
  'ctx-menu': 'the right-click menu - every menu in the app is this one node',
  'exit-layer': 'the overlay an exit animation is drawn on, above everything',
  'far-lands': 'the card at the edge of the board, placed once if anybody gets there',
  'fence-ghost': 'the preview rectangle drawn while a fence is being placed',
  'fence-prompt': 'the name-this-fence prompt',
  // Off the table on purpose: it was one hardcoded id on a node
  // canvas/renderers.ts builds for both canvas and Feed, so two could exist
  // at once and the Feed slider's aria-describedby resolved to the wrong
  // one. Styled through .whimsy-stops now, with a per-item id no stylesheet
  // can be written against.
  'library': 'the board switcher',
  'search': 'the Find panel',
  'search-field': 'the Find input',
  'search-hits': 'the Find results list',
  'tour-editor': 'the bar the tour is built from, which has nothing in it until there is a stop',
  'web': 'the SVG layer every connection is drawn into',
  'whimsy-stop-labels': 'the tick labels under the whimsy slider',
};

/**
 * Every id a *selector* names, with the sheet it was named in.
 *
 * Walked a character at a time rather than matched, since `#[a-z-]+` also
 * matches every hex colour literal (#fff, #a38686...), burying the real
 * answer in phantoms. The distinction is positional: only the text before
 * each `{` is read, comments dropped first, at-rule preludes skipped, and a
 * declaration ends at `;` so a property value is never mistaken for one.
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
 * Four forms, and only four, since a fifth would have to guess: `node.id =`
 * and `setAttribute('id', …)` assign one, `getElementById` finds one built
 * elsewhere, and the settings schema declares two by data (`slot`, `stopsId`).
 *
 * An id assembled from pieces (`'exit-' + kind`) is invisible to all four -
 * fine here, since no id in the CSS is built that way (interpolated names
 * here are all classes), and a looser regex would confirm anything.
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
  // Guards the guard: a hand-rolled walk that matched nothing would let
  // anything through, and could quietly start returning an empty list.
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
  // Two ways an entry stops earning its place, both looking harmless: a node
  // that moved into index.html is now covered by the first test on its own,
  // so a leftover entry is a second, weaker answer; and an entry no selector
  // asks about isn't part of a CSS contract at all, just a JS handle.
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
  // Invalid HTML: getElementById returns the first one, every id selector
  // matches both, and which you're looking at depends on which you found.
  const seen = new Set();
  const twice = declared.filter(id => (seen.has(id) ? true : (seen.add(id), false)));
  assert.deepEqual(twice, [], `declared more than once: ${twice.join(', ')}`);
});
