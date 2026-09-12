// The order main.ts brings the app up in.
//
// About a dozen of main.ts's forty init*() calls are ordered for a stated
// reason ("before initSidebar()", etc.), previously held up only by a comment.
// Getting one wrong fails silently and only in one state - a slider paints
// wrong, a flyout stops closing - and there's no browser-driven suite to catch
// it. So the constraints are data here (BEFORE), checked against main.ts's
// actual order, each row carrying its reason.
//
// This deliberately does not compute the order - a resolver is the wrong
// shape for a boot that reads as an interleaved narrative. It only checks the
// hand-written order against its own stated reasons. An init with no ordering
// requirement (most of them) needs no row.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MAIN = join(import.meta.dirname, '..', 'web', 'assets', 'js', 'main.ts');

/**
 * Every call in main.ts's boot that something else is ordered against, read
 * off the source so the two can't disagree. Only top-level calls count - a
 * name inside a callback runs later and isn't part of the sequence.
 */
function bootSequence() {
  const src = readFileSync(MAIN, 'utf8');
  const order = [];
  for (const line of src.split('\n')) {
    // Column zero, or behind one of the two `if (!isPatch)` guards - the only
    // conditional calls in the block, and they still hold their place.
    const m = /^(?:if \(!isPatch\) )?([a-zA-Z][\w]*)\(/.exec(line);
    if (m) order.push(m[1]);
  }
  return order;
}

/**
 * X must be called before Y, and why. The reason is the load-bearing column,
 * condensed from the comment over that call in main.ts, so deleting a row
 * means deciding something visible.
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
  ['initCuelume', 'buildPanel',
    'the Sounds dial paints itself from soundLevel() as the panel is generated, '
    + 'and until initCuelume runs that is the default rather than what was stored'],
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
  // A guard on the guard: bootSequence() reads column-zero calls, so a boot
  // that grew a second half deeper down would be checked against an order that
  // no longer describes it. initStorage() is the last thing wired.
  const order = bootSequence();
  const end = order.indexOf('initStorage');
  assert.ok(end > 0, 'initStorage is the end of the wiring block');
  for (const [, second] of BEFORE) {
    assert.ok(order.indexOf(second) <= end,
      `${second} is wired after initStorage, so this table no longer describes the boot`);
  }
});
