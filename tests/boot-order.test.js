// The order main.ts brings the app up in.
//
// main.ts's boot is about forty init*() calls, and a dozen of them are in the
// place they are for a stated reason - "Before initSidebar()", "After
// initAudio()", "after initMenu() because the close hook it registers would
// otherwise be overwritten". Every one of those was a comment and nothing else,
// which meant the invariant they describe was held up by whoever read them.
//
// Getting one wrong fails *silently*, and usually in one state rather than at
// boot: the volume slider paints at the wrong value, the flyouts stop closing,
// the hint cards animate out of nodes that are not mounted yet. There is no
// browser-driven suite to catch any of that (see CONTRIBUTING.md), and a
// reordering is exactly the kind of edit that looks safe in a diff.
//
// So the constraints are data here, the way tests/layers.test.js holds the
// layering graph and the BASE list. That list *is* the split rather than a note
// about it, and this table *is* the boot order rather than a note about it. Each
// row carries the reason, because a constraint without one is a rule nobody can
// safely delete.
//
// **What this deliberately does not do is compute the order.** A resolver was
// the obvious shape and is the wrong one here: main.ts's boot is interleaved
// with the viewport, the command surface, two `if (!isPatch)` branches and five
// injection calls, and it reads as a narrative that explains itself. Turning
// that into a table of declared needs would trade a boot a person can read for
// machinery, on a file with no test of its behaviour at all. This checks the
// hand-written order against its own stated reasons, which is the half that was
// missing.
//
// Adding an init with an ordering requirement means adding a row. An init with
// no requirement needs nothing - most of them have none, and saying so by
// absence is the point.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MAIN = join(import.meta.dirname, '..', 'web', 'assets', 'js', 'main.ts');

/**
 * Every call in main.ts's boot that something else is ordered against, in the
 * order the file makes them.
 *
 * Read off the source rather than listed here, so the two cannot disagree - the
 * whole failure mode this file exists for is a list that stops matching the
 * thing it describes. Only top-level calls count: a name inside a callback or a
 * subscription runs later and is not part of the sequence.
 */
function bootSequence() {
  const src = readFileSync(MAIN, 'utf8');
  const order = [];
  for (const line of src.split('\n')) {
    // Column zero, or behind one of the two `if (!isPatch)` guards, which are
    // the only conditional calls in the block and still hold their place in it.
    const m = /^(?:if \(!isPatch\) )?([a-zA-Z][\w]*)\(/.exec(line);
    if (m) order.push(m[1]);
  }
  return order;
}

/**
 * X must be called before Y, and why.
 *
 * The reason is the load-bearing column. Each is quoted from or condensed out of
 * the comment sitting over that call in main.ts, so a reader who wants to delete
 * a row can see what they would be deciding.
 */
const BEFORE = [
  ['initOverlays', 'initErrors',
    'a toast is how an error is reported, and until initOverlays runs notify.ts '
    + 'forwards to nobody - so an exception raised before it is silently dropped'],
  ['initErrors', 'initStorage',
    'everything after initErrors is inside the top-level handler\'s reach, and '
    + 'the session restore is the part most worth having in it'],
  ['armQuality', 'initItems',
    'the quality flags are written onto <html> and fill `quality` for canvas/*, '
    + 'and a card built before that reads a level nobody set'],
  ['buildPanel', 'initAppearance',
    'the panel is generated, and ui/appearance.ts takes the whimsy slider, the '
    + 'palette menu and three hosts out of it by id'],
  ['buildPanel', 'initAudio',
    'canvas/audio.ts takes the volume slider out of the panel by id'],
  ['buildPanel', 'initSidebar',
    'ui/sidebar.ts takes the board name field out of the panel by id'],
  ['buildPanel', 'initHud',
    'the save button the glass does not own is in the generated panel'],
  ['initFonts', 'initAppearance',
    'so the type menus are built once with the board\'s own faces already in '
    + 'them rather than built empty and rebuilt a tick later'],
  ['initItems', 'initGhosts',
    'the hint sweep animates nodes out, and they have to be mounted by the time '
    + 'it can fire'],
  ['initItems', 'watchQuality',
    'moving the dial remounts every card, so it needs the module that mounts them'],
  ['initStills', 'watchQuality',
    'moving the dial asks the freeze question again, so it needs the module '
    + 'that answers it'],
  ['initTour', 'initInput',
    'so the arrow and Escape keys have a runner to ask by the time the handler '
    + 'can fire'],
  ['initAudio', 'initNowPlaying',
    'initAudio is what reads the stored volume, and the bar\'s slider paints '
    + 'itself from that value on the way up'],
  ['initNowPlaying', 'initTimeline',
    'the CSS rule that steps the player up over the strip is a general sibling '
    + 'combinator, and this is the order the two elements sit in - see the note '
    + 'over #timeline-strip in index.html'],
  ['initMenu', 'initFlyouts',
    'the panel a flyout opens is ui/menu.ts\'s, and the close hook initFlyouts '
    + 'registers would otherwise be overwritten on init'],
  ['initToolbar', 'initFlyouts',
    'it marks the bar\'s own markup with aria-haspopup'],
  ['initToolbar', 'initStickerWindow',
    'the toolbar is what opens the sticker pad'],
];

test('every stated boot-order constraint holds in main.ts', () => {
  const order = bootSequence();
  const at = name => order.indexOf(name);

  const broken = [];
  for (const [first, second, why] of BEFORE) {
    const a = at(first);
    const b = at(second);
    if (a === -1) { broken.push(`${first} is not called in main.ts at all`); continue; }
    if (b === -1) { broken.push(`${second} is not called in main.ts at all`); continue; }
    if (a > b) broken.push(`${first} must run before ${second}: ${why}`);
  }
  assert.deepEqual(broken, []);
});

test('nothing in the table is called twice, which would make "before" meaningless', () => {
  const order = bootSequence();
  const named = new Set(BEFORE.flatMap(([a, b]) => [a, b]));
  const twice = [...named].filter(n => order.filter(x => x === n).length > 1);
  assert.deepEqual(twice, []);
});

test('the boot is still one block near the top of the file', () => {
  // A guard on the guard. bootSequence() reads column-zero calls, so a boot
  // that grew a second half further down - inside an async start(), say - would
  // be checked against an order that no longer describes it. initStorage() is
  // the last thing wired; anything after it is lifecycle rather than wiring.
  const order = bootSequence();
  const end = order.indexOf('initStorage');
  assert.ok(end > 0, 'initStorage is the end of the wiring block');
  for (const [, second] of BEFORE) {
    assert.ok(order.indexOf(second) <= end,
      `${second} is wired after initStorage, so this table no longer describes the boot`);
  }
});
