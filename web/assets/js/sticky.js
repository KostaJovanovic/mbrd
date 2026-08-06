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
// Third concern out of state.js, and the first that needed the board itself to
// go down before it could follow - see board-model.js. Nothing here commits or
// announces: these are questions about geometry, and the mutations that act on
// the answers stay in state.js.

import { overlapFraction } from './geometry.js';
import { board, byId, isFurniture, TITLE_ID } from './board-model.js';
import { isFence } from './fences.js';

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
const cannotHost = it => isFurniture(it) || isFence(it);

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
  if (!note || note.type !== 'note') return null;
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
    if (cannotHost(it) || it.id === note.id || (it.z || 0) >= (note.z || 0)) continue;
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
 */
export function wouldStick(box, excludeId) {
  let best = null;
  for (const it of board.items) {
    if (cannotHost(it) || it.id === excludeId) continue;
    if (best && (it.z || 0) < (best.z || 0)) continue;
    if (overlapFraction(box, it) > STICK_MIN) best = it;
  }
  return best;
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

/** Nothing on the old board is a fact about the new one. */
export const forgetSticks = () => sticks.clear();

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
  const furniture = new Set([TITLE_ID]);
  for (const it of board.items) if (isFurniture(it)) furniture.add(it.id);
  for (const it of board.items) {
    if (it.type === 'note' && it.meta && 'stuckTo' in it.meta) {
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
  return it.type === 'note' && !!stuckTo(it);
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
  const pool = board.items.filter(i => i.type === 'note' && !moving.has(i.id));
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

