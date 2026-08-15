// The keyboard, the toggle and the hover child - three rules ui/menu.ts states
// in prose and did not keep.
//
// None of them can be driven from here: the menu is a module of closures over
// document, and there is no browser in this suite. What is checkable is the
// shape of each repair against the source, which is what tests/font-tokens.js
// and tests/appearance.js already do for the pairs they hold together. Each
// test below names the failure it is standing in front of, so that a future
// edit that reintroduces it fails against a sentence rather than a regex.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { JS, read } from './helpers.js';

const menu = read(join(JS, 'ui', 'menu.ts'));
const flyout = read(join(JS, 'ui', 'flyout.ts'));
const search = read(join(JS, 'ui', 'search.ts'));

/** Source with its comments taken off - most of these rules are also argued. */
const code = src => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

test('the menu only takes a keystroke when it has the keyboard', () => {
  // The capture-phase keydown is on the *window* and acted whenever any panel
  // was up - including a flyout that declined focus on the way in, which is
  // openAnchored()'s whole reason for defaulting `focus` to false. Dwell on the
  // toolbar's Note button, press Ctrl+K, type `cat`: every letter reached
  // typeAhead(), matched a row, focused it, and was eaten by preventDefault().
  // The caret left the field and the word never arrived.
  assert.match(code(menu), /const ownsKeyboard = \(\) =>\s*!!lastOpts\.focus \|\| insideMenu\(document\.activeElement\)/,
    'ownsKeyboard() is gone or no longer asks both questions');
  const handler = code(menu).slice(code(menu).indexOf("addEventListener('keydown'"));
  const escape = handler.indexOf("=== 'Escape'");
  const guard = handler.indexOf('if (!ownsKeyboard()) return;');
  const arrows = handler.indexOf("'ArrowDown'");
  assert.ok(guard > 0, 'the keydown handler no longer asks whether the menu has the keyboard');
  assert.ok(escape > 0 && escape < guard,
    'Escape moved behind the focus guard - a hover panel must still be dismissable');
  assert.ok(guard < arrows,
    'the arrow keys are ahead of the focus guard again');
});

test('a menu button is a toggle for its own menu and nothing else', () => {
  // justDismissed() recorded which *element* dismissed the menu and not which
  // *menu* it dismissed, so pressing a second menu button while the first was
  // open closed one and opened neither: the capture pointerdown named the
  // second button as the dismisser, and that button's own opener read it as "I
  // am the toggle that just closed". Font then Highlight in the note composer;
  // More then the palette picker on the toolbar.
  assert.match(code(menu), /let menuOwner: Element \| null = null;/,
    'the menu no longer records which button it hangs off');
  assert.match(code(menu), /if \(!dismissed\.owner \|\| !el\.contains\(dismissed\.owner\)\) return false;/,
    'justDismissed() is back to answering for a menu that was not this button\'s');
  assert.match(code(menu), /dismissed = \{ by: e\.target, at: performance\.now\(\), owner: menuOwner \}/,
    'the dismissal record dropped the owner');
});

test('the hover child is torn down with the page it hangs off', () => {
  // swap() removed the root node and left the child on screen hanging off
  // nothing, with childRow pointing at a detached button and childFrom at a
  // detached panel - and the only thing that clears those compares childFrom
  // against a live panel, so the orphan outlived every page turn.
  const swap = code(menu).slice(code(menu).indexOf('function swap('));
  const closed = swap.indexOf('closeChild();');
  const removed = swap.indexOf('node.remove()');
  assert.ok(closed > 0 && closed < removed,
    'swap() tears down the root without closing the child first');
});

test('a keyboard press on a flown-out fold still drills in', () => {
  // The "already flown out" guard was keyed on the row rather than on the route,
  // so leaving the pointer on the Edit fold, arrowing back onto it and pressing
  // Enter was a dead press - the worst answer available on a focused row.
  assert.match(code(menu), /const byKey = e\.detail === 0;/,
    'the row handler no longer tells a keyboard activation from a click');
  assert.match(code(menu), /if \(entry\.sub && child && childRow === btn && !byKey\) return;/,
    'the flown-out guard swallows keyboard activations again');
});

test('the arrow keys walk the panel that holds focus', () => {
  // All three keyboard routes queried the root and only the root. The child is
  // a sibling of the root on the body, so a keyboard inside it walked the rows
  // behind it instead - focus jumping out of the panel it was in, one row at a
  // time.
  assert.match(code(menu), /function focusRows\(\)/, 'focusRows() is gone');
  for (const fn of ['moveFocus', 'focusEnd', 'typeAhead']) {
    const body = code(menu).slice(code(menu).indexOf(`function ${fn}(`), code(menu).indexOf(`function ${fn}(`) + 900);
    assert.ok(body.includes('focusRows()'), `${fn}() queries the root panel directly again`);
  }
});

test('a flyout stays open while the pointer is inside its submenu', () => {
  // #ctx-child is a sibling of #ctx-menu on the body, so closest('#ctx-menu')
  // called a pointer inside a submenu "anywhere else" and started the 250 ms
  // close timer under it. The same trap insideMenu() documents from the other
  // side; latent only because no FLYOUTS builder uses `sub` today.
  assert.match(code(flyout), /closest\?\.\('#ctx-menu, #ctx-child'\)/,
    'onOver() treats the hover child as outside the flyout again');
});

test('the Find button is a toggle and does not eat a typed query', () => {
  // search.ts's capture-phase closer is the justDismissed() trap CLAUDE.md
  // names. Tapping Find with "chair" typed closed the palette and the click
  // then built a fresh empty one, so open()'s own `if (node)` branch - the one
  // that keeps the query - was unreachable from any button in the app.
  assert.match(code(search), /export function open\(from: Element \| null = null\)/,
    'open() no longer takes the button that asked for it');
  assert.match(code(search), /dismissedBy = e\.target as Node \| null;/,
    'the palette stopped recording what closed it');
  assert.match(code(search), /from\.contains\(dismissedBy\)/,
    'open() no longer declines to rebuild the palette its own button just closed');
});

test('the Feed aims its menu at the tile that was pressed', () => {
  // Every selection-wide row this menu draws - Delete item, Copy, Tags, A tour
  // stop, Anchor - acts on the canvas selection, and nothing in the Feed had
  // ever set one. Select a card on the canvas, switch to Feed, long-press a
  // different tile, tap Delete item: the card selected on the canvas died and
  // the one under the thumb stayed. With nothing selected the row did nothing.
  //
  // The same call openMenuAt() makes in canvas/input.ts, on the same rule every
  // file manager follows.
  const feed = code(read(join(JS, 'ui', 'feed.ts')));
  assert.match(feed, /function openTileMenu\(x: number, y: number, id: string\)/,
    'the Feed opens its menu without retargeting again');
  assert.match(feed, /if \(!selection\.has\(id\)\) select\(\[id\]\);/,
    'openTileMenu() no longer retargets the selection');
  assert.match(feed, /cmds\?\.contextMenu\(x, y, id, selection\.size, \{ mobile: true \}\)/,
    'the Feed is back to telling the menu a hardcoded count');
  // Both routes in - the mouse's contextmenu and the finger's hold timer.
  assert.equal((feed.match(/openTileMenu\(/g) || []).length, 3,
    'one of the two ways into the Feed menu bypasses the retarget');
});
