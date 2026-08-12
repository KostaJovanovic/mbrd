// @ts-nocheck - TypeScript migration debt, not a judgement about this file.
//
// The tree was renamed from .js to .ts mechanically, which moved 104 modules in
// one step and annotated none of them. This module is carried unchecked so that
// npm run typecheck stays green and keeps meaning something, rather than going
// red and being ignored. Converting this module IS deleting this block and
// fixing what tsc then says - tests/ts-debt.test.js holds the count and lets it
// only fall.
// Which note is stuck to what, and what travels when something moves.
//
// A note is stuck to whatever it is lying on, and a stuck note travels with its
// host. Nothing about that is stored *in the board file* as a relation:
// stuckness is a fact about where two things are, and a file that also recorded
// it could disagree with its own geometry - a hazard with no upside, since the
// geometry is right there and the answer falls out of it.
//
// It is not recomputed on demand either, and that is the part worth naming. The
// relation is worked out from live geometry the first time anything asks, and
// then *remembered* until the note itself is handled. Which means moving a
// photo, resizing it, or dropping something else on top of it cannot quietly
// re-parent the notes lying on it - the pile you built stays the pile you
// built. Only picking up the note itself asks the question again.
//
// The memo is a runtime Map, not a field. It is seeded on load from each note's
// durable meta.stuckTo (see seedSticks), which is what keeps the first render
// after opening a board from measuring every note against every item; a note
// from an older file, with no such record, falls through to measuring and is
// the only thing that still pays for it.
//
// One thing *is* stored, and it is the exception that keeps the rule above
// honest: meta.loose, the flag that says "I unstuck this on purpose". A stuck
// item is now *pinned* - a drag on it takes hold of its host instead of itself -
// and the way out has to be a decision rather than a measurement, because the
// note you unstuck is almost always still lying on the card you unstuck it from.
// That is the normal case, not the odd one: you unstick a note in order to nudge
// it. So the positive relation stays measured, exactly as argued above, and only
// the negative override is written down. Absent means the ordinary thing.
//
// Third concern out of state.js, and the first that needed the board itself to
// go down before it could follow - see board-model.js. Nothing here commits or
// announces: these are questions about geometry, and the mutations that act on
// the answers stay in state.js.

import { overlapFraction } from './geometry.ts';
import { board, byId, isFurniture, TITLE_ID } from './board-model.ts';
import { isFence } from './fences.ts';

/**
 * What a note may not be stuck to: the app's own furniture, and a fence.
 *
 * The furniture half is argued at measureStick() below. A fence joins it for a
 * third reason, and the same one that keeps the title card out - a host is
 * something a note lies *on*, and a fence is a region a note lies *in*. A note
 * stuck to the fence around it would be pinned to a rectangle it was already
 * travelling with, so moving the fence would move it twice; and on Mobile, where
 * a fence is a full-width band, it would ride that band instead of taking its
 * place in the run. The note is in the fence already. It does not also stick.
 */
const cannotHost = (it, rider) => {
  // A sticker is the exemption, and it is a *sticker* exemption rather than a
  // general loosening - the two reasons above are still the right answer for a
  // note and are simply not answers about a sticker.
  //
  // The fence: a note on the fence around it would ride the full-width Mobile
  // band instead of taking its place in the run, which is wrong for a note and
  // exactly right for a sticker. A star on a region's face is decoration on the
  // region, and it should go where the region goes.
  //
  // The title card: a note stuck to it landed in the packed Mobile first row as
  // a rider nothing had treated as an obstacle. Same answer - a sticker is
  // decoration and is not meant to be an obstacle. It rides, nothing packs
  // around it, and layout.js parks the title card clear of the Mobile board
  // anyway, so a sticker on it goes along.
  //
  // A hint card is still refused. A hint is deleted the moment any real content
  // arrives, so a sticker stuck to one is a sticker stuck to something about to
  // stop existing - and unlike a note, whose delete leaves it behind, a sticker
  // would go with it (see the delete cascade in state.js).
  if (rider?.type === 'sticker') return it?.type === 'ghost';
  return isFurniture(it) || isFence(it);
};

/**
 * What kinds of thing stick: notes, and stickers.
 *
 * One predicate rather than the four separate `type === 'note'` tests this file
 * used to carry, and the same one is read in stacking.js, state.js's serializer
 * and layout.js. Completeness is the whole reason it is exported: a kind that
 * sticks in stuckTo() but is not recognised by stuckFollowers() is a thing that
 * gets left behind when its host moves, which is the one failure this relation
 * cannot have. Keeping the list in one place is what makes "all of them or none
 * of them" checkable instead of hopeful.
 *
 * A sticker is a note in every way this module cares about - a small thing laid
 * on top of a bigger thing, travelling with it, ordered above it. What it is
 * *not* is a card you can type into, and nothing here asks about that.
 */
export const isSticky = it => it?.type === 'note' || it?.type === 'sticker';

// ---------------------------------------------------------------------------
// Sticky notes that stick
//
// A note is stuck to whatever it is lying on, and a stuck note travels with its
// host. Nothing about that is stored *in the board file*: stuckness is a fact
// about where two things are, and a file that also recorded it could disagree
// with its own geometry - a hazard with no upside, since the geometry is right
// there and the answer falls out of it.
//
// It is not recomputed on demand either, and that is the part worth naming. The
// relation is worked out from live geometry the first time anything asks, and
// then *remembered* until the note itself is handled. Which means moving a
// photo, resizing it, or dropping something else on top of it cannot quietly
// re-parent the notes lying on it - the pile you built stays the pile you
// built. Only picking up the note itself asks the question again.
//
// The memo is a runtime Map, not a field. A board that has just loaded has an
// empty one and answers every question by measuring, which is exactly what the
// old always-measure version did, so a .mbrd needs no new key and one written
// by an older version is not missing anything.
// ---------------------------------------------------------------------------

/**
 * How much of a note has to be over an item before it counts as stuck.
 *
 * A twentieth of the note. Low on purpose: a sticky pressed onto the corner of
 * a photograph is stuck to that photograph, and anybody who put it there thinks
 * so. The floor exists to rule out the note that merely *touches* while it is
 * being dragged past, which at zero would grab a host for one frame and let go
 * again.
 */
export const STICK_MIN = 0.05;

/**
 * noteId -> hostId or null. Null is a real answer, "measured, and it is stuck to
 * nothing", and it has to survive as one: falling through to a fresh
 * measurement every time would make a loose note the one case that *does* get
 * re-parented by things moving underneath it.
 */
const sticks = new Map();

/**
 * The item a sticky note is stuck to, or null.
 *
 * Measured by area: more than STICK_MIN of the note's own surface lying over
 * the item. Area rather than the note's centre or its top corners, because
 * those are questions about three particular points and this is a question
 * about a sheet of paper lying on something - a note overlapping a photo's
 * corner by a third of itself is obviously stuck to it, and no test of the
 * centre will ever say so.
 *
 * A host must be a real item. The title card and the hint cards are the app's
 * own furniture: a note stuck to the title card travelled with it and, on
 * Mobile, landed in the packed first row as a rider nothing had treated as an
 * obstacle - while a note stuck to a hint was stuck to something deleted the
 * moment any real content arrived. layout.js parks the title card clear of the
 * Mobile board for the same reason, which fixed the obstacle end of it; this is
 * the stick end.
 *
 * Only notes stick, and only to something below them in the stack. A note
 * hidden behind the thing it claims to be stuck to would be a relationship
 * nobody could see, and being seen is the whole of the point. It costs nothing
 * to arrange, either: startMove() lifts whatever you drag to the top, so a note
 * dropped onto a photo is already above it. Where several candidates qualify -
 * a note on a note on a photo - the nearest one underneath wins, so a pile
 * hangs together in the order it was laid down.
 */
export function stuckTo(note) {
  if (!isSticky(note)) return null;
  // Unstuck on purpose. Everything downstream - riders, travel, the Mobile
  // placement, the stack order, the meta.stuckTo stamp - then treats this note
  // exactly as it treats one lying over nothing, which is the whole of the
  // implementation: no new code paths, one guard. The memo is deliberately not
  // consulted or written here; the flag outranks it, and clearing the flag
  // (see restick) is what lets the measurement speak again.
  if (note.meta?.loose) return null;
  if (sticks.has(note.id)) {
    const id = sticks.get(note.id);
    if (id === null) return null;
    const host = byId(id);
    // A remembered host that is no longer on the board - deleted, or undone
    // back out of existence. Measuring again is the lesser evil: the note did
    // not move, so the rule says leave it, but leaving it means a note that can
    // never stick to anything again until somebody happens to drag it.
    if (host) return host;
    sticks.delete(note.id);
  }
  const host = measureStick(note);
  sticks.set(note.id, host ? host.id : null);
  return host;
}

function measureStick(note) {
  let best = null;
  for (const it of board.items) {
    if (cannotHost(it, note) || it.id === note.id || (it.z || 0) >= (note.z || 0)) continue;
    if (best && (it.z || 0) < (best.z || 0)) continue;
    if (overlapFraction(note, it) > STICK_MIN) best = it;
  }
  return best;
}

/**
 * The item a prospective note box would stick to if let go as given, or null.
 *
 * The same rule as measureStick - the topmost item more than STICK_MIN covered -
 * but asked of a box that is not on the board yet, so a drag can decide to skip
 * the grid *before* it commits the move. No z compare is needed: startMove()
 * raised the dragged note to the top when the gesture began, so every other item
 * is already below it, and the box carries no z to compare anyway.
 *
 * Deliberately *not* guarded by meta.loose, unlike stuckTo(). This is the
 * question a drag in flight asks, and a drag that finds a host is precisely the
 * way back from Unstick - a loose note dropped on a card sticks again and pins.
 * Guarding it would take that door away, and the highlight under the pointer
 * would stop promising what the release is about to do. It also takes a bare
 * box rather than an item, so there would be no flag here to read.
 *
 * `rider` is what is being dropped, and it is here for one question: what a
 * sticker may stick to is wider than what a note may (see cannotHost). It is
 * the item where there is one and a bare `{ type }` stub where there is not -
 * a shape being dragged out of the sticker window is not on the board yet, and
 * its type is the only thing about it this needs to know. Omitted, the rule is
 * the note's, which is what every caller predating stickers wanted.
 */
export function wouldStick(box, excludeId, rider) {
  let best = null;
  for (const it of board.items) {
    if (cannotHost(it, rider) || it.id === excludeId) continue;
    if (best && (it.z || 0) < (best.z || 0)) continue;
    if (overlapFraction(box, it) > STICK_MIN) best = it;
  }
  return best;
}

/**
 * What this item would be stuck to if it were not loose - the measurement the
 * guard in stuckTo() skips.
 *
 * Exported for one caller: the mutation that clears meta.loose when a drop
 * finds a host (resettle(), in state.js). It cannot ask stuckTo(), because the
 * flag it is deciding whether to remove is exactly what stuckTo() refuses to
 * look past. The memo is left alone - this reads live geometry and nothing else,
 * so the caller is free to clear the flag and restick() afterwards.
 */
export function hostUnder(it) {
  return isSticky(it) ? measureStick(it) : null;
}

// ---------------------------------------------------------------------------
// Setting
//
// Stuck and pinned are the same relation a few seconds apart. An item is stuck
// the instant it lands - it travels with its host, rides it through a reflow,
// stacks above it - and that half cannot wait, because a photograph dragged
// straight after a note was dropped on it has to take the note along.
//
// What waits is *pinning*: the rule that a press on the item takes hold of its
// host instead. That one is a trap if it arrives instantly. You drop a sticky
// on a photograph, see it is two millimetres off, reach for it - and the
// photograph moves. Right-click, Unstick, nudge, and the thing you were doing
// three seconds ago has cost you four steps.
//
// So a freshly dropped item *lies* on its host for ten seconds before it sets
// to it. In that window it is stuck and free: pick it up, put it down, adjust
// it, take it off entirely. After it, the pile is one object and Unstick is the
// way back - which is what the pin was for in the first place, for the note you
// placed on Tuesday and are dragging a photograph past on Thursday.
//
// Runtime only, and it has to be. A board that has just loaded is a board that
// has been sitting still, however long ago it was written, so absence of a
// record means *set* rather than settling - which is also why nothing here is
// stored and forgetSticks() clears it with everything else.
//
// No timer, either, and that is worth saying because the obvious implementation
// has one. Nothing needs to *happen* at the ten-second mark: the two things
// that read this - the drag redirect and the hover badge - both ask at the
// moment they run, so a comparison against a stamp is the whole mechanism. A
// scheduled callback would only exist to tell the interface something it can
// work out for itself, and would then have to be cancelled on delete, on undo,
// on a board swap.
// ---------------------------------------------------------------------------

/**
 * How long an item lies where it was dropped before it sets to what is under
 * it.
 *
 * Ten seconds: long enough to cover "that is not quite where I meant" without
 * being long enough to forget the thing is going to change under you.
 */
export const SETTLE_MS = 10_000;

/** id -> when it was last let go. Absent means set, which is the ordinary case. */
const settling = new Map();

/**
 * Start the clock on these ids, because they have just been let go.
 *
 * Called with the same set restick() is - what a gesture actually drove, never
 * what it towed - and for the same reason: a note carried across the board by
 * the photograph underneath it was not put down, so its ten seconds are not
 * its to have again.
 */
export function startSettling(ids) {
  const now = Date.now();
  for (const id of ids) settling.set(id, now);
}

/** Is this item still lying where it was dropped rather than set to it? */
export function isSettling(it) {
  const at = it && settling.get(it.id);
  if (at === undefined) return false;
  if (Date.now() - at < SETTLE_MS) return true;
  // Swept on the way past rather than on a timer. Every id in here is asked
  // about within a frame or two of mattering, so the map cannot grow.
  settling.delete(it.id);
  return false;
}

/** How long until this item sets, in ms. Zero once it has. */
export function settlesIn(it) {
  const at = it && settling.get(it.id);
  return at === undefined ? 0 : Math.max(0, SETTLE_MS - (Date.now() - at));
}

/**
 * What this item is pinned to - fixed on, rather than merely lying on - or null.
 *
 * Stuck *and* set. The two come apart only for the few seconds after a drop;
 * everywhere else this is stuckTo() with a different name, which is the point
 * of Part 1: stuck comes to mean fixed, it just takes a moment about it.
 */
const pinnedTo = it => (isSettling(it) ? null : stuckTo(it));

/**
 * Is this item pinned - fixed in place on a host rather than lying loose or
 * still settling onto one?
 *
 * Its own predicate because three different doors ask it and answer
 * differently: a pointer drag redirects to the host, the arrow keys unstick and
 * nudge, and the command-driven geometry writes (align, distribute, rearrange,
 * the snap sweep) skip it. Three behaviours, one rule about what is true; the
 * rule wants one home even where the responses do not.
 */
export const isPinned = it => !!pinnedTo(it);

/**
 * The thing a press on `it` should actually take hold of: the top of its pile.
 *
 * Up rather than one step, because a sticker on a note on a photograph has to
 * move the photograph - the pile reads as one object under the pointer and
 * moving it in two goes would be the surprise. The walk stops at the first
 * thing that is not pinned, so a pile with a freshly dropped sticker on top of
 * it comes apart at exactly that sticker for ten seconds and nowhere else.
 *
 * It terminates for the same reason stuckFollowers() does: being stuck requires
 * a lower z, so the relation is a strict order and cannot close on itself.
 */
export function dragRoot(it) {
  for (let host = pinnedTo(it); host; host = pinnedTo(it)) it = host;
  return it;
}

/**
 * Forget what these notes were stuck to, so the next question measures again.
 *
 * Called with the ids a gesture *drove* - what the pointer or the arrow keys
 * actually had hold of - and never with the followers those ids dragged along.
 * That distinction is the feature: a note carried across the board by the photo
 * underneath it has not been moved relative to anything and must not be
 * re-parented, while a note you picked up and put down has been, and must.
 */
export function restick(ids) {
  for (const id of ids) sticks.delete(id);
}

/**
 * Nothing on the old board is a fact about the new one.
 *
 * The settle clocks go too, and that is the load-bearing half: a board being
 * opened has been sitting still however long ago it was written, so every item
 * on it is set. Leaving a stale stamp here would hand a freshly opened board
 * ten seconds in which its stickies were not pinned.
 */
export function forgetSticks() {
  sticks.clear();
  settling.clear();
}

/**
 * Seed the memo from what a loaded board wrote down.
 *
 * Stickiness is measured, not stored, everywhere *inside* a session - but a
 * pixel of geometry drift across a save/reload, or a Mobile layout that parked a
 * note a hair off its host, could drop the overlap under STICK_MIN and lose a
 * relationship the author plainly made. `meta.stuckTo` is the durable record
 * (stamped at serialize time); seeding it here makes the saved answer win over a
 * fresh measurement, while an older board with no such key measures as before.
 * A null is kept as the real answer "loose", exactly as the memo treats it.
 *
 * A record naming furniture is dropped rather than seeded. The memo is trusted
 * ahead of measurement, so a file written before measureStick() excluded the
 * title card would otherwise reintroduce from disk exactly the relation the
 * measurement now refuses - and a seeded memo is never re-measured while its
 * host is on the board.
 *
 * The title card is named by its constant rather than looked up, because it is
 * not on the board yet: loadBoard() runs this before main.js seeds the card, so
 * there is nothing to ask about the type. Hints need no such test - a load drops
 * every ghost, so a record naming one finds no host and simply measures again.
 */
export function seedSticks() {
  sticks.clear();
  // And every settle clock, which is the half that is not about the memo. A
  // board being opened has been sitting still however long ago it was written,
  // so everything on it is *set* - a stale stamp surviving a load would hand a
  // freshly opened board ten seconds in which its stickies were not pinned.
  // Here rather than only in forgetSticks(), because this is the function a
  // load actually calls; that one is the whole-teardown door.
  settling.clear();
  const furniture = new Set([TITLE_ID]);
  for (const it of board.items) if (isFurniture(it)) furniture.add(it.id);
  for (const it of board.items) {
    if (isSticky(it) && it.meta && 'stuckTo' in it.meta) {
      const hostId = it.meta.stuckTo ?? null;
      sticks.set(it.id, furniture.has(hostId) ? null : hostId);
    }
  }
}

/**
 * Where a note sits relative to its host, as a fraction of the host's size.
 *
 * Fractions rather than world units so the offset survives the host being a
 * different size in the other layout: a note pinned to a photo's top-left stays
 * at its top-left when Mobile shrinks the photo to fit a column. Read live at
 * the moment a layout is generated, never stored - the current geometry is the
 * truth, and freezing an offset would fight a note dragged around its host.
 */
function stuckOffset(note, host) {
  return { fx: (note.x - host.x) / (host.w || 1), fy: (note.y - host.y) / (host.h || 1) };
}

/**
 * The centre a stuck note takes in a target layout: its host's place there, plus
 * the offset it holds in the source layout. `hostSrc`/`hostDst` are the same host
 * measured in the two layouts.
 */
export function stuckPlacement(note, hostSrc, hostDst) {
  const off = stuckOffset(note, hostSrc);
  return { x: hostDst.x + off.fx * hostDst.w, y: hostDst.y + off.fy * hostDst.h };
}

/** A note stuck to something still on the board - one that rides, not packs. */
export function isRider(it) {
  return isSticky(it) && !!stuckTo(it);
}

/**
 * Place each rider on its host inside a target layout, in passes so a note stuck
 * to a note resolves only once its own host has a place. `place` is the target
 * geometry map, keyed by id; `build(note, hostSrc, hostDst)` returns the entry to
 * store. Returns the ids that never resolved - a deleted host, or a cycle - for
 * the caller to fall back on. hostSrc is read live (the source layout); hostDst
 * is the host's entry in `place`.
 */
export function attachRiders(riders, place, build) {
  const pending = new Set(riders.map(r => r.id));
  for (let grew = true; grew && pending.size;) {
    grew = false;
    for (const note of riders) {
      if (!pending.has(note.id)) continue;
      const host = stuckTo(note);
      if (!host) { pending.delete(note.id); continue; }
      if (pending.has(host.id)) continue;        // host is a rider, not placed yet
      const hostDst = place.get(host.id);
      if (!hostDst) continue;                     // host not laid out yet this pass
      // `host` itself, not byId(host.id). stuckTo() already returned the live
      // item, so the round trip bought nothing and cost the one thing an index
      // can be: out of date. It is the read that threw during a load, before
      // loadBoard() learned to drop the index where it swaps the array.
      place.set(note.id, build(note, host, hostDst));
      pending.delete(note.id);
      grew = true;
    }
  }
  return pending;
}

/**
 * The ids of the notes that have to come along when `ids` are moved.
 *
 * Transitive, so a note stuck to a note stuck to a photo travels with the
 * photo: a pile of stickies on a picture reads as one object, and having to
 * move it in two goes would be the surprise. The walk cannot loop - being stuck
 * requires a lower z, which makes the relation a strict order - but each note
 * leaves the pool as it joins, so termination is a property here rather than an
 * assumption about z.
 *
 * Anything already moving is left out, which is what keeps this from fighting a
 * multi-select drag: a note selected alongside its host is moved once, by the
 * selection, instead of once by the selection and again as a follower.
 */
export function stuckFollowers(ids) {
  const moving = new Set(ids);
  const pool = board.items.filter(i => isSticky(i) && !moving.has(i.id));
  const out = [];
  // Passes rather than one sweep: a note can only join once whatever it is
  // stuck to has joined, and the pool is in no particular order.
  for (let grew = true; grew;) {
    grew = false;
    for (let n = pool.length - 1; n >= 0; n--) {
      const host = stuckTo(pool[n]);
      if (!host || !moving.has(host.id)) continue;
      moving.add(pool[n].id);
      out.push(pool[n].id);
      pool.splice(n, 1);
      grew = true;
    }
  }
  return out;
}

