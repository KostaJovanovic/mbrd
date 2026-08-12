// Stickers, and the two things about them that can go wrong quietly.
//
// The first is *completeness*. A sticker is a note in every way sticky.js cares
// about, and the whole of that claim is one predicate - isSticky() - read from
// five places. A kind that sticks in stuckTo() but is not recognised by
// stuckFollowers() is a sticker that gets left behind when the card underneath
// it moves, and nothing about that fails: the star simply stays where it was
// while the photograph walks off. So the relation is exercised end to end here
// rather than at the predicate.
//
// The second is the *catalogue*. A shape id is written straight into a
// `<use href>`, where a name that matches nothing draws nothing at all - no
// warning, no failed request, a hole where the sticker was. The same hazard
// tests/icons.test.js exists for, and checked the same way: both directions,
// against the sprite.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  addItems, removeItems, byId, board, setBoardMode, undo,
  stuckTo, stuckFollowers, isRider, isSticky, isPinned, dragRoot,
  serializeBoard, loadBoard, snapshotGeom, applyGeom, commitGeom, unstickItems,
  resettle, ensureTitleCard, TITLE_ID,
  startSettling, settlesIn, SETTLE_MS,
} from '../web/assets/js/state.ts';
import { WEB } from './helpers.js';
import {
  STICKERS, stickerShape, stickerTint, STICKER_TINTS, STICKER_TINT_NAMES, STICKER_VIEWBOX,
} from '../web/assets/js/stickers/catalogue.ts';
import { fresh, note, photo, fence, sticker } from './state-fixtures.js';

beforeEach(() => {
  setBoardMode('desktop');
  fresh();
});

// ---------------------------------------------------------------------------
// The catalogue and the sprite
// ---------------------------------------------------------------------------

const sprite = readFileSync(join(WEB, 'assets', 'stickers.svg'), 'utf8');
const defined = new Set([...sprite.matchAll(/<symbol id="([^"]+)"/g)].map(m => m[1]));

test('the sprite draws every shape the catalogue lists', () => {
  // Guards the guard - a regex that matched nothing would pass everything.
  assert.ok(defined.size > 30, `only ${defined.size} symbols found - has the sprite moved?`);
  const missing = STICKERS.filter(s => !defined.has(s.id)).map(s => s.id);
  assert.deepEqual(missing, [], `no <symbol> for: ${missing.join(', ')}`);
});

test('the sprite carries no shape the catalogue does not offer', () => {
  const listed = new Set(STICKERS.map(s => s.id));
  const orphans = [...defined].filter(id => !listed.has(id));
  assert.deepEqual(orphans, [], `unreachable symbols: ${orphans.join(', ')}`);
});

test('no comment in the sprite holds two hyphens in a row', () => {
  // SVG is XML, so this is a parse error - and a parse error takes down the
  // *whole file*, not the comment. Every shape on every board then draws
  // nothing at once, with no console warning and no failed request to say why:
  // the browser fetches the sprite, fails to build a document out of it, and
  // every <use href> resolves to an id in a file that no longer exists.
  //
  // Not hypothetical. The section headings in this sprite were first written as
  // rules of hyphens, in the house style the rest of the codebase uses for
  // exactly that job, and forty-five shapes went invisible together.
  //
  // Matched loosely on purpose: a file that is already broken this way does not
  // tokenise into clean comments, so the check looks at everything between the
  // openers and the first closer rather than trusting the structure.
  for (const [, inner] of sprite.matchAll(/<!--([\s\S]*?)-->/g)) {
    assert.ok(!inner.includes('--'), `two hyphens inside a comment: "${inner.trim().slice(0, 48)}"`);
  }
});

test('every symbol is drawn to the box the renderers wrap it in', () => {
  // Five places build a <svg class="sticker-art"> around a <use> and set this
  // viewBox on the wrapper (STICKER_VIEWBOX). A symbol drawn to a different one
  // is scaled to that wrapper anyway and so arrives at a different weight from
  // every other sticker on the board - which is exactly the failure the icon
  // sprite's own box check exists for.
  const boxes = [...sprite.matchAll(/<symbol id="([^"]+)" viewBox="([^"]+)"/g)];
  assert.equal(boxes.length, defined.size, 'a symbol without a viewBox');
  for (const [, id, box] of boxes) {
    assert.equal(box, STICKER_VIEWBOX, `${id} is drawn to ${box}`);
  }
});

test('a shape only ever opts out of the paint in the one declared way', () => {
  // fill is inherited, and items.css sets it on the <svg> in the host document
  // because nothing there can select into an external <use>. A presentation
  // attribute on the path beats the inherited value, which is how the outline
  // over a body says it is ink - and also how a shape could accidentally be
  // pinned to one colour for good. So the only value allowed is currentColor,
  // which still follows the tint.
  //
  // Phosphor's own files also put fill="currentColor" on the root <svg> and
  // opacity="0.2" on the duotone background; the generator strips both, and
  // a stray one surviving would mean every shape came out one flat colour.
  for (const [, value] of sprite.matchAll(/\sfill="([^"]+)"/g)) {
    assert.equal(value, 'currentColor', `fill="${value}" pins a shape to one paint`);
  }
  assert.equal(/\sstroke=/.test(sprite), false, 'nothing here is stroked');
  assert.equal(/\sopacity=/.test(sprite), false, 'a duotone opacity survived the generator');
  assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(sprite), false, 'a hex colour in the sprite');
});

test('every shape has an ink layer', () => {
  // A duotone symbol is a paper body and an inked outline; a single-weight one
  // is the mark alone. Either way at least one path has to carry the ink, or
  // the shape is a paper silhouette on paper - invisible on the board, and
  // invisible in a way no test of the *sprite* would otherwise notice.
  for (const [, id, chunk] of sprite.matchAll(/<symbol id="([^"]+)"([\s\S]*?)<\/symbol>/g)) {
    assert.ok(chunk.includes('fill="currentColor"'), `${id} draws no ink`);
  }
});

test('every catalogue tint is one the palette actually has', () => {
  for (const s of STICKERS) {
    assert.ok(s.tint >= 1 && s.tint <= STICKER_TINTS, `${s.id} is born tint ${s.tint}`);
  }
});

test('every tint the palette has is one the menu can name', () => {
  // The menu's colour row is STICKER_TINT_NAMES by index, and the number it
  // writes into meta.tint is that index plus one. Nothing but the ordering ties
  // the words to the tokens, so a ninth --sticker-* with no name would be a
  // colour nothing could choose and a ninth name would set a colour that is not
  // there.
  assert.equal(STICKER_TINT_NAMES.length, STICKER_TINTS);
  const css = readFileSync(join(WEB, 'assets', 'css', 'tokens.css'), 'utf8');
  for (let n = 1; n <= STICKER_TINTS; n++) {
    assert.match(css, new RegExp(`--sticker-${n}\\s*:`), `no --sticker-${n} token`);
  }
});

test('an unknown shape or tint falls back rather than reaching the DOM', () => {
  assert.equal(stickerShape('s-not-a-shape'), null);
  assert.equal(stickerTint(99, 's-star'), 2);
  assert.equal(stickerTint('nonsense', 's-heart'), 1);
  assert.equal(stickerTint(5, 's-heart'), 5);
});

// ---------------------------------------------------------------------------
// Sticking - the completeness half
// ---------------------------------------------------------------------------

test('a sticker over a photo is stuck to it and travels with it', () => {
  const [pic] = addItems([photo({ x: 0, y: 0, w: 300, h: 300 })]);
  const [star] = addItems([sticker({ x: 0, y: 0 })]);
  assert.equal(isSticky(byId(star.id)), true);
  assert.equal(stuckTo(byId(star.id))?.id, pic.id);
  assert.equal(isRider(byId(star.id)), true);
  assert.deepEqual(stuckFollowers([pic.id]), [star.id]);
});

test('a sticker may stick to a fence, where a note may not', () => {
  const [f] = addItems([fence({ x: 0, y: 0, w: 800, h: 600 })]);
  // Kept apart, or the sticker measures the note as the nearest thing under it
  // and the fence never comes into the question.
  const [n] = addItems([note({ x: -200, y: 0 })]);
  const [star] = addItems([sticker({ x: 200, y: 0 })]);
  assert.equal(stuckTo(byId(n.id)), null);
  assert.equal(stuckTo(byId(star.id))?.id, f.id);
});

test('a sticker may stick to the title card, where a note may not', () => {
  ensureTitleCard();
  const title = byId(TITLE_ID);
  // Both over the card and clear of each other, so each is measured against the
  // title rather than against the other.
  const [n] = addItems([note({ x: title.x - 70, y: title.y })]);
  const [star] = addItems([sticker({ x: title.x + 70, y: title.y })]);
  assert.equal(stuckTo(byId(n.id)), null);
  assert.equal(stuckTo(byId(star.id))?.id, TITLE_ID);
});

test('a sticker on a note on a photo drags the photo', () => {
  const [pic] = addItems([photo({ x: 0, y: 0, w: 400, h: 400 })]);
  const [n] = addItems([note({ x: 0, y: 0 })]);
  const [star] = addItems([sticker({ x: 0, y: 0 })]);
  assert.equal(stuckTo(byId(star.id))?.id, n.id);
  assert.equal(dragRoot(byId(star.id)).id, pic.id);
});

test('a sticker survives a save and a reload still stuck', () => {
  const [pic] = addItems([photo({ x: 0, y: 0, w: 300, h: 300 })]);
  const [star] = addItems([sticker({ x: 0, y: 0 })]);
  const file = serializeBoard();
  const saved = file.items.find(i => i.id === star.id);
  assert.equal(saved.meta.stuckTo, pic.id);
  loadBoard(file);
  assert.equal(stuckTo(byId(star.id))?.id, pic.id);
});

// ---------------------------------------------------------------------------
// Deleting the host: stickers go with the card, notes stay behind
// ---------------------------------------------------------------------------

test('deleting a card takes its stickers and leaves its notes', () => {
  const [pic] = addItems([photo({ x: 0, y: 0, w: 400, h: 400 })]);
  const [n] = addItems([note({ x: -100, y: -100 })]);
  const [star] = addItems([sticker({ x: 100, y: 100 })]);
  assert.equal(stuckTo(byId(n.id))?.id, pic.id);
  assert.equal(stuckTo(byId(star.id))?.id, pic.id);

  removeItems([pic.id]);
  assert.equal(byId(pic.id), undefined);
  assert.equal(byId(star.id), undefined, 'the star was a remark about the photo');
  assert.ok(byId(n.id), 'the note is something somebody wrote');
});

test('the cascade stops at a surviving host', () => {
  // The naive version - stuckFollowers() then a filter to stickers - takes this
  // star too, because the note is a follower of the photo even though it is not
  // being deleted.
  const [pic] = addItems([photo({ x: 0, y: 0, w: 400, h: 400 })]);
  const [n] = addItems([note({ x: 0, y: 0 })]);
  const [star] = addItems([sticker({ x: 0, y: 0 })]);
  assert.equal(stuckTo(byId(star.id))?.id, n.id);

  removeItems([pic.id]);
  assert.ok(byId(n.id));
  assert.ok(byId(star.id), 'the note it is stuck to is still here');
});

test('the cascade is one undo entry', () => {
  const [pic] = addItems([photo({ x: 0, y: 0, w: 400, h: 400 })]);
  const [star] = addItems([sticker({ x: 0, y: 0 })]);
  removeItems([pic.id]);
  undo();
  assert.ok(byId(pic.id));
  assert.ok(byId(star.id));
});

test('a sticker on a sticker goes too', () => {
  const [pic] = addItems([photo({ x: 0, y: 0, w: 400, h: 400 })]);
  const [a] = addItems([sticker({ x: 0, y: 0 })]);
  const [b] = addItems([sticker({ x: 0, y: 0 })]);
  assert.equal(stuckTo(byId(b.id))?.id, a.id);
  removeItems([pic.id]);
  assert.equal(byId(a.id), undefined);
  assert.equal(byId(b.id), undefined);
});

// ---------------------------------------------------------------------------
// Pinning
// ---------------------------------------------------------------------------

test('a stuck item is pinned and Unstick sets it loose', () => {
  const [pic] = addItems([photo({ x: 0, y: 0, w: 400, h: 400 })]);
  const [star] = addItems([sticker({ x: 0, y: 0 })]);
  assert.equal(isPinned(byId(star.id)), true);

  unstickItems([star.id]);
  assert.equal(byId(star.id).meta.loose, true);
  assert.equal(isPinned(byId(star.id)), false);
  assert.equal(stuckTo(byId(star.id)), null);
  assert.deepEqual(stuckFollowers([pic.id]), [], 'a loose sticker does not travel');

  undo();
  assert.equal(byId(star.id).meta.loose, undefined);
  assert.equal(isPinned(byId(star.id)), true);
});

// ---------------------------------------------------------------------------
// Setting: stuck now, pinned in ten seconds
// ---------------------------------------------------------------------------

/**
 * Run `fn` as though `ms` had passed.
 *
 * The settle window is a comparison against Date.now() and nothing else - no
 * timer, no event - which is what makes it testable this cheaply. Restored in a
 * finally, so a throwing assertion cannot leave the clock wound forward for
 * every case after it.
 */
function later(ms, fn) {
  const real = Date.now;
  Date.now = () => real.call(Date) + ms;
  try { return fn(); } finally { Date.now = real; }
}

test('a freshly dropped item is stuck but not yet pinned', () => {
  const [pic] = addItems([photo({ x: 0, y: 0, w: 400, h: 400 })]);
  const [star] = addItems([sticker({ x: 0, y: 0 })]);
  startSettling([star.id]);

  // Stuck immediately, and that half must not wait: dragging the photograph
  // now has to take the star along.
  assert.equal(stuckTo(byId(star.id))?.id, pic.id);
  assert.deepEqual(stuckFollowers([pic.id]), [star.id]);

  // But not pinned, so a press on it takes hold of the star and not the photo.
  assert.equal(isPinned(byId(star.id)), false);
  assert.equal(dragRoot(byId(star.id)).id, star.id);
  assert.ok(settlesIn(byId(star.id)) > 0);
});

test('it pins once the window is up', () => {
  const [pic] = addItems([photo({ x: 0, y: 0, w: 400, h: 400 })]);
  const [star] = addItems([sticker({ x: 0, y: 0 })]);
  startSettling([star.id]);

  later(SETTLE_MS + 1, () => {
    assert.equal(isPinned(byId(star.id)), true);
    assert.equal(dragRoot(byId(star.id)).id, pic.id, 'a press now takes the photograph');
    assert.equal(settlesIn(byId(star.id)), 0);
  });
});

test('a drop restarts the window rather than topping it up', () => {
  addItems([photo({ x: 0, y: 0, w: 400, h: 400 })]);
  const [star] = addItems([sticker({ x: 0, y: 0 })]);
  startSettling([star.id]);

  // Nine seconds in, moved again: the clock goes back to the top, so a sticker
  // you keep adjusting never sets under your hand.
  later(SETTLE_MS - 1000, () => {
    const before = snapshotGeom([star.id]);
    applyGeom([{ ...before[0], x: 20 }]);
    commitGeom('Move', before, [star.id]);
    assert.equal(isPinned(byId(star.id)), false);
  });
  later(SETTLE_MS + 1, () => assert.equal(isPinned(byId(star.id)), false, 'still inside the new window'));
});

test('Unstick reaches an item that has not set yet', () => {
  // The window is exactly when you want this: it is how you say "leave it here
  // but do not fix it", without waiting for it to fix itself so you can unfix it.
  addItems([photo({ x: 0, y: 0, w: 400, h: 400 })]);
  const [star] = addItems([sticker({ x: 0, y: 0 })]);
  startSettling([star.id]);
  assert.equal(isPinned(byId(star.id)), false);

  unstickItems([star.id]);
  assert.equal(byId(star.id).meta.loose, true);
  later(SETTLE_MS + 1, () => assert.equal(isPinned(byId(star.id)), false, 'and it never sets'));
});

test('a board that has just loaded is already set', () => {
  // Absence of a stamp means set, not settling - a saved board has been sitting
  // still however long ago it was written, and opening one must not hand every
  // sticky on it ten seconds of being loose.
  addItems([photo({ x: 0, y: 0, w: 400, h: 400 })]);
  const [star] = addItems([sticker({ x: 0, y: 0 })]);
  startSettling([star.id]);
  assert.equal(isPinned(byId(star.id)), false);

  loadBoard(serializeBoard());
  assert.equal(isPinned(byId(star.id)), true);
});

test('a loose item is a fence member rather than a rider', () => {
  const [f] = addItems([fence({ x: 0, y: 0, w: 800, h: 600 })]);
  const [star] = addItems([sticker({ x: 0, y: 0 })]);
  assert.equal(isRider(byId(star.id)), true);
  unstickItems([star.id]);
  assert.equal(isRider(byId(star.id)), false);
  assert.ok(f);
});

test('a drop that finds a host clears the loose flag', () => {
  const [pic] = addItems([photo({ x: 0, y: 0, w: 400, h: 400 })]);
  const [star] = addItems([sticker({ x: 0, y: 0 })]);
  unstickItems([star.id]);

  // What the pointer gesture does on release: move it, resettle, commit. The
  // before snapshot carries loose:true and the after one carries it cleared,
  // which is what gives undo something to put back.
  const before = snapshotGeom([star.id]);
  assert.equal(before[0].loose, true);
  applyGeom([{ ...before[0], x: 40 }]);
  assert.deepEqual(resettle([star.id]), [star.id]);
  commitGeom('Move', before, [star.id]);
  assert.equal(byId(star.id).meta.loose, undefined);
  assert.equal(stuckTo(byId(star.id))?.id, pic.id);

  undo();
  assert.equal(byId(star.id).meta.loose, true, 'undo restores the decision, not a measurement');
  assert.equal(stuckTo(byId(star.id)), null);
});

test('a drop over nothing leaves a loose item loose', () => {
  addItems([photo({ x: 0, y: 0, w: 200, h: 200 })]);
  const [star] = addItems([sticker({ x: 0, y: 0 })]);
  unstickItems([star.id]);
  const before = snapshotGeom([star.id]);
  applyGeom([{ ...before[0], x: 900 }]);
  assert.deepEqual(resettle([star.id]), []);
  commitGeom('Move', before, [star.id]);
  assert.equal(byId(star.id).meta.loose, true);
});

test('the loose flag survives a save and a reload', () => {
  addItems([photo({ x: 0, y: 0, w: 400, h: 400 })]);
  const [star] = addItems([sticker({ x: 0, y: 0 })]);
  unstickItems([star.id]);
  const file = serializeBoard();
  assert.equal(file.items.find(i => i.id === star.id).meta.loose, true);
  loadBoard(file);
  assert.equal(isPinned(byId(star.id)), false);
  assert.ok(board.items.length);
});
