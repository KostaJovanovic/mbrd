// @ts-nocheck - TypeScript migration debt, not a judgement about this file.
//
// The tree was renamed from .js to .ts mechanically, which moved 104 modules in
// one step and annotated none of them. This module is carried unchecked so that
// npm run typecheck stays green and keeps meaning something, rather than going
// red and being ignored. Converting this module IS deleting this block and
// fixing what tsc then says - tests/ts-debt.test.js holds the count and lets it
// only fall.
// Mounts board items into #world and keeps their DOM in sync with state.
//
// Culling keeps the DOM proportional to what is on screen rather than to the
// size of the board. A node that scrolls out of view is detached, and then
// either kept or thrown away: kept if its media is mid-playback, so a video
// that leaves and re-enters the viewport carries on where it was, and thrown
// away otherwise, because rebuilding a still card costs a few DOM nodes while
// holding one costs whatever it had decoded. See disposable() and discard().
//
// What a card is *made of* is canvas/item-dom.ts, which this file calls and
// which never calls back. The seam is when against what: this module owns the
// node map, the culling, the pooling and the arithmetic that puts a card where
// it goes; that one owns the elements. build() below is the single place they
// meet, and its four lines after buildItem() are exactly the four things a
// builder cannot know - that there is a map to register in, a shadow layer, a
// viewport to be placed against, and a selection.

import {
  board, byId, selection, bus, renameItem, visualStackOrder, travelling, isFence,
  isPinned, settlesIn,
} from '../state.ts';
import { quality } from '../quality.ts';
import { itemRadius, rotatedExtents } from '../geometry.ts';
import { buildContent } from './renderers.ts';
import {
  buildItem, buildShadow, buildTitleControls, farKind, itemAccessibleName,
  resetTilt, restingTilt, setGrips, wantsHead, writeFit,
} from './item-dom.ts';
import { POSTER_TIME } from './video.ts';
import { clearDisplay } from './display.ts';
import { releasePlayers } from './audio.ts';
import { flyOut } from './exit-anim.ts';
import * as spatial from './spatial.ts';

// The three pure questions about what a card says. They were exported from here
// before they moved down, and canvas/renderers.js, ui/ and tests/items.test.js
// all still ask this module - so they are re-exported by name, the way state.ts
// re-exports what it has split downward and for the same reason: an export that
// stops existing should break loudly at the door rather than quietly at a call
// site.
export { farKind, itemAccessibleName, wantsHead };

/**
 * Above this many items in one delete, the fly-out is skipped: a fifty-item
 * delete should not spawn fifty animating clones, so past the cap they just
 * vanish the way every delete used to.
 */
const EXIT_ANIM_CAP = 12;

/** id -> element, including elements currently detached by culling. */
const nodes = new Map();
/** id -> lightweight geometry twin painted below the complete item stack. */
const shadows = new Map();
let worldEl = null;
let shadowLayerEl = null;
let vp = null;

/**
 * The set of ids currently carrying the hover lift.
 *
 * The group that lifts is the group that travels: a hover raises the item and
 * everything that a drag of it would carry - the stickies on a photo, the cards
 * in a fence - so what answers the pointer is the object you would pick up.
 * travelling() is exactly that set, and using it rather than a second reading of
 * the same two relations is what keeps the lift and the drag from ever
 * disagreeing about where one object stops.
 *
 * It goes one way, which is the whole of the rule. Both halves of travelling()
 * are downward - to riders, never to a host, and to contents, never to the fence
 * around them - so pointing at one note in a stack lifts that note and its own
 * riders while the card beneath stays put, and pointing at a card inside a
 * region lifts the card and leaves the region where it is. Only the region
 * itself raises the region.
 *
 * The pointer never reaches a fence's face (it refuses events, see items.css),
 * so in practice this fires from the name plate: a hand on the label lifts the
 * area it names, which is the one gesture that says what a fence holds without
 * moving anything.
 */
let lastHoverId = null;
let hoverGroup = new Set();
function setHoverLift(id, on) {
  nodes.get(id)?.classList.toggle('is-hover', on);
  shadows.get(id)?.classList.toggle('is-hover', on);
}
/**
 * Told which cards the pointer is on, whenever that changes.
 *
 * One subscriber, for canvas/web.js, which lifts a card's connections out of the
 * rest of the board while the pointer is on it. A callback rather than an event
 * on the board's bus for the reason the web's own move hook gives: this fires on
 * pointer moves, and anything every module can hear is something one of them
 * will eventually answer with a rebuild.
 *
 * The *group*, not the id: a sticky rides on the card it is pinned to and lifts
 * with it, so a hand on the note is a hand on the photograph, and the
 * photograph is the end a connection is drawn to.
 */
let hoverWatcher = null;
export function onHoverItem(fn) { hoverWatcher = fn; }

function setHoverGroup(id) {
  if (id === lastHoverId) return;
  // The pin badge, and the reason it is worked out here rather than written
  // onto the node when the item is built: pinning is a fact about two items and
  // it changes without either of them being rebuilt - a host deleted, an undo,
  // a card dragged out from under a note. Hover is the only moment the badge is
  // visible, so hover is the only moment it has to be right, and asking then
  // costs one measurement of one item instead of a class that can go stale.
  //
  // On the hovered item alone, not on the group. The lift already says "these
  // move together"; this says "and this one is fixed to that one", which is
  // only true of the thing under the pointer.
  nodes.get(lastHoverId)?.classList.remove('is-pinned');
  clearTimeout(settleWatch);
  lastHoverId = id;
  paintPinBadge(id);
  const next = new Set(id ? travelling([id]) : []);
  for (const gid of hoverGroup) if (!next.has(gid)) setHoverLift(gid, false);
  for (const gid of next) if (!hoverGroup.has(gid)) setHoverLift(gid, true);
  hoverGroup = next;
  hoverWatcher?.(hoverGroup);
}

/**
 * Write the pin badge onto the hovered item, and come back for it if the item
 * is still settling.
 *
 * The one timer this feature has, and it is here rather than in sticky.js
 * because it is not about the rule - it is about the *badge*, which is a thing
 * on screen and only visible while the pointer is on the card. A hand resting
 * on a note it dropped eight seconds ago should see it become pinned; without
 * this it would have to leave and come back for the class to be recomputed.
 *
 * One outstanding timer at a time, cleared by the next hover change, so there
 * is nothing to cancel on a delete or a board swap - the item stops being
 * hovered and the callback finds no node.
 */
let settleWatch = 0;
function paintPinBadge(id) {
  const it = byId(id);
  nodes.get(id)?.classList.toggle('is-pinned', isPinned(it));
  const left = settlesIn(it);
  // +50ms, so the callback lands the far side of the comparison rather than on
  // the exact millisecond it turns over.
  if (left) settleWatch = setTimeout(() => paintPinBadge(id), left + 50);
}

/**
 * How much board is kept mounted beyond the edge of the screen, to hide pop-in.
 *
 * In *screen* pixels, converted to world units per call - and that conversion is
 * the whole point. It was a flat 400 world units, which is a margin that does
 * not shrink as you zoom in: at 100% it meant holding about two and a half
 * screens' worth of cards, and at 200% five, because the visible world rectangle
 * halves with every doubling of the zoom while a world-space margin stays the
 * size it was. The pop-in it is hiding happens in screen pixels - you see a card
 * arrive a certain distance from the edge of the display, not a certain distance
 * across the board - so this is the unit it should have been in all along.
 */
const CULL_MARGIN_PX = 300;

/**
 * And a ceiling on it in world units, which is the number this used to be.
 *
 * Below about three-quarter zoom a constant screen margin is *wider* on the
 * board than the flat 400 was, and out there it would be buying nothing: the
 * visible slice of board is already enormous, cards are a few pixels across, and
 * their chrome has been dropped entirely. So the screen-space rule applies where
 * it helps - at 100% and in - and the old world-space one caps it beyond that.
 * The result is never worse than what was here before at any zoom.
 */
const CULL_MARGIN_MAX = 400;

/**
 * That margin in world units at the current zoom.
 *
 * The guard is not defensive noise. `vp` arrives in initItems(), and this is
 * reachable from a repaint that a subsystem can schedule before the wiring in
 * main.js has got that far - at which point an unguarded read is a TypeError
 * during boot rather than a margin. canvas/web.js carries the same one-liner
 * with the same guard for its own `vp` and always did; this copy had drifted
 * away from it, which is the shape of bug a duplicated line exists to produce.
 * Change one and change the other.
 */
const cullMargin = () => Math.min(CULL_MARGIN_PX / (vp ? vp.zoom : 1), CULL_MARGIN_MAX);

/**
 * An item's entry in the spatial cull index: a circumscribed square, centre and
 * full size, matching the precise test sync() runs (itemRadius + 2). Registering
 * by the circumscribed radius rather than the tight box is what makes a rotated
 * card index by the corner it actually reaches, so the grid never drops an item
 * the precise test would have kept - see canvas/spatial.js.
 */
const cullBox = item => {
  const r = itemRadius(item) + 2;
  return { id: item.id, x: item.x, y: item.y, w: 2 * r, h: 2 * r };
};

/**
 * Bring the spatial cull index up to date with a membership change.
 *
 * A delta names exactly what arrived and left, so the index touches only those;
 * without one - a load, or any emitter that names no change - it rebuilds from
 * the whole board, which is always right if slower. Either way it is off the
 * per-frame path: this runs on 'items' and 'layout', never on a pan or zoom,
 * where the whole point of the index is to avoid walking every item.
 */
function reindex(delta) {
  if (delta && (delta.added || delta.removed)) {
    for (const id of delta.removed || []) spatial.remove(id);
    for (const id of delta.added || []) {
      const item = byId(id);
      if (item) spatial.update(id, cullBox(item));
    }
  } else {
    spatial.rebuild(board.items.map(cullBox));
  }
}

export function initItems(world, viewport) {
  worldEl = world;
  shadowLayerEl = world.querySelector('#item-shadows');
  vp = viewport;
  bus.on('items', delta => { reconcile(delta); reindex(delta); sync(); });
  bus.on('geom', ids => {
    for (const id of ids) {
      placeNode(id);
      // The one per-item index write on a hot path: a moved card has to change
      // cells or the next cull would look for it where it no longer is. byId is
      // O(1) now (state.js), and a null item just removes it from the index.
      const item = byId(id);
      spatial.update(id, item && cullBox(item));
    }
    sync();
  });
  bus.on('item', id => rebuild(id));
  // A per-item fit change comes through 'item' (rebuild re-reads fitMode). The
  // board-wide default changes nothing about an item, so it arrives as a plain
  // 'settings' and only the data-fit attribute needs rewriting - no rebuild, no
  // reflow of the media itself. Items with their own meta.fit keep it.
  bus.on('settings', key => {
    if (key !== 'mediaFit') return;
    for (const [id, el] of nodes) {
      const item = byId(id);
      if (item && (item.type === 'image' || item.type === 'video')) writeFit(el, item);
    }
  });
  // A layout-mode switch rewrites every item's geometry through writeLayout()
  // and announces it with 'layout' alone - no 'geom' per id, no 'items'. The old
  // whole-board scan read board.items fresh and never noticed; the index has to
  // be told, or the next cull would hunt the new layout in the old layout's
  // cells. The view change the switch also fires runs its own sync(); this makes
  // sure the index that sync reads is the one the new layout put things in.
  bus.on('layout', () => { reindex(); sync(); });
  bus.on('selection', paintSelection);
  // The shadow twin lives in its own layer, so no CSS :hover on the card can
  // reach it. Mirror the hover onto it here: one delegated pair on the world,
  // tracking which item the pointer is over, so the twin lifts with the card
  // instead of being left behind as a second card (see .item-shadow.is-hover).
  world.addEventListener('pointerover', e => setHoverGroup(itemIdFromEvent(e.target)));
  world.addEventListener('pointerout', e => {
    if (!itemIdFromEvent(e.relatedTarget)) setHoverGroup(null);
  });
  // Arrow rather than the function itself: onChange hands its listener the
  // viewport, and sync() reads its argument.
  //
  // The cull is the zoom-out hot path - visibleRect grows past syncedRect every
  // frame and this falls through to a full sync() - and the main.js profiler
  // does not wrap it, so its cost was invisible. When mbrd.perf is armed
  // (cullProfile.on), each frame records its own time and whether it ran a full
  // sync; off, it is a single boolean read and the plain call, same as ever.
  //
  // resnap() rides the same listener rather than one of its own: it has to run
  // after syncView(), because a card that has only just been mounted has no
  // snapped transform yet, and it costs a single boolean read on every frame
  // that is not the settling one. See the note above deviceSnap().
  vp.onChange(() => {
    if (!cullProfile.on) { syncView(); resnap(); return; }
    const t = performance.now();
    syncView();
    resnap();
    cullProfile.ms += performance.now() - t;
    cullProfile.runs++;
  });
  reconcile();
  reindex();
  sync();
}

export function nodeFor(id) { return nodes.get(id); }

/**
 * The item something being dropped would stick to, wearing the selection ring
 * while it is aimed at. Null clears it.
 *
 * One at a time, and the caller clears it when the gesture ends. Written here
 * rather than by each gesture because the mark belongs to a node and this
 * module owns the nodes - and because there are two gestures now: a note or
 * sticker dragged across the board (canvas/input.js) and a shape dragged out of
 * the sticker window (ui/sticker-window.js), which cannot see into the other's
 * closure. Two copies of one mark is two chances for one of them to be left on.
 */
let stickTargetId = null;
export function showStickTarget(host) {
  const id = host?.id ?? null;
  if (id === stickTargetId) return;
  if (stickTargetId) nodes.get(stickTargetId)?.classList.remove('is-stick-target');
  stickTargetId = id;
  if (id) nodes.get(id)?.classList.add('is-stick-target');
}

/** Subscribe to view changes (pan/zoom); returns the unsubscribe. */
export function onViewChange(fn) { return vp?.onChange(fn); }

/**
 * The client-space box of an item, computed rather than measured.
 *
 * getBoundingClientRect() answers the same question, and for a one-off it is
 * the right call. This exists for the caller that asks on every view frame -
 * the note toolbar, which has to stay over its note through a pan - because
 * there the read is not free: the view has just written #world's transform, so
 * nothing about the page's geometry is still valid and the browser flushes
 * layout for the whole tree before it can answer. Once per frame, for the
 * length of an edit.
 *
 * Nothing has to be measured, because everything is already known. placeBox()
 * puts the box at item.x/y, sizes it w by h and turns it by -rot, so its
 * extent is the standard rotated-rectangle pair, and vp.toScreen() carries the
 * centre across. The one adjustment is the frame: toScreen() answers in the
 * viewport's own coordinates and a position:fixed consumer wants the client's.
 */
export function screenBoxOf(item) {
  if (!vp || !item) return null;
  const { hw, hh } = rotatedExtents(item);
  const halfW = hw * vp.zoom, halfH = hh * vp.zoom;
  const c = vp.toScreen(item.x, item.y);
  const cx = vp.left + c.x, cy = vp.top + c.y;
  return {
    cx, cy,
    left: cx - halfW, right: cx + halfW,
    top: cy - halfH, bottom: cy + halfH,
  };
}

/**
 * The viewport's own client rectangle, from the cache the Viewport already
 * keeps. Same reason as above: it is refreshed by measure() on the two events
 * that can move it (a resize, a scroll), so asking the element every frame
 * would buy nothing but the layout flush.
 */
export function viewportClientRect() {
  if (!vp) return null;
  return {
    left: vp.left, top: vp.top,
    right: vp.left + vp.width, bottom: vp.top + vp.height,
  };
}

/**
 * The card holding the first end of a connection being drawn, or null.
 *
 * Owned here rather than in ui/toolbar.js, which is what actually decides it,
 * because a mark on a card has to survive the card being culled and rebuilt -
 * see the note in build(). ui/ hands the id down; this layer keeps it true.
 */
let pickedId = null;

export function setConnectPick(id) {
  if (pickedId === id) return;
  if (pickedId) nodeFor(pickedId)?.removeAttribute('data-pick');
  pickedId = id || null;
  if (pickedId) nodeFor(pickedId)?.setAttribute('data-pick', '');
}

/**
 * The card the draft line is currently aimed at, marked so it says so.
 *
 * The pick's opposite number, and deliberately *not* kept the way the pick is.
 * A pick is a decision and has to survive its card being culled and rebuilt; an
 * aim is where the pointer happens to be this moment, and a card that scrolled
 * off screen is not where the pointer is. So this writes the live node and
 * nothing more - build() knows about data-pick and has no business knowing
 * about this one.
 */
let aimedId = null;

export function setConnectAim(id) {
  if (aimedId === id) return;
  if (aimedId) nodeFor(aimedId)?.removeAttribute('data-aim');
  aimedId = id || null;
  if (aimedId) nodeFor(aimedId)?.setAttribute('data-aim', '');
}

/**
 * How far this card leans, as the fraction of `--tilt-max` it was dealt.
 *
 * Read off the live node, because that is the only place the number exists: the
 * lean is presentational, it is dealt from a bag when the card is built (see
 * tiltFactor), and it is dealt *again* when a card that was culled comes back.
 * Nothing stores it and nothing can - it is not the item's rotation, which is
 * geometry and lives in item.rot.
 *
 * An inline custom property, so this is a string read and not a computed style:
 * canvas/web.js asks for every connected card on every frame of a drag, and a
 * getComputedStyle there would be a style flush per card per frame.
 *
 * 0 for a card with no node - one that is culled is off screen, and a lean
 * nobody can see does not change where a line should stop.
 */
export function tiltOf(id) {
  const el = nodeFor(id);
  if (!el) return 0;
  return parseFloat(el.style.getPropertyValue('--item-tilt')) || 0;
}

/** The item id owning a DOM node, or null for canvas chrome. */
export function itemIdFromEvent(target) {
  const el = target instanceof Element ? target.closest('.item') : null;
  return el ? el.dataset.id : null;
}

/**
 * Throw a node away for good, rather than merely detaching it.
 *
 * The distinction this draws is the whole reason it exists. Culling detaches a
 * node and expects to put the same one back, media state and all - that is why
 * the cache is here. Everything else that removes a node is discarding it, and
 * a discarded card still owns a decoded video or audio stream and, if it had a
 * transport, a registered player. Dropping the reference is not enough: the
 * media element frees its buffers when its source goes, not when the last
 * reference to it does.
 */
function discard(el) {
  el.remove();
  releasePlayers(el);
  for (const m of el.querySelectorAll('video, audio')) {
    m.pause();
    m.removeAttribute('src');
    // Tells the element to re-read its (now absent) source, which is what
    // actually releases what it had buffered.
    m.load?.();
  }
  // The same bargain for pictures. An <img>'s decoded bitmap - naturalW x
  // naturalH x 4 bytes, uncapped by how small the card was drawn - is freed when
  // its src goes, not when the last reference to the element does. On a
  // memory-tight phone that difference is a full-resolution decode held until the
  // next GC, and a board panned across hundreds of photos discards that many at
  // once. Clearing the src (and the still twin's) hands the decode back now.
  for (const im of el.querySelectorAll('img')) im.removeAttribute('src');
}

/**
 * Whether a detached node can be dropped and rebuilt without anyone noticing.
 *
 * Anything at rest can: rebuilding is a few DOM nodes and an object URL that
 * the asset store still holds. What cannot is media that is doing something -
 * a video left playing, an audio scrubbed to the middle of a track - because
 * the cache exists precisely so that panning away from a playing clip and back
 * does not restart it.
 */
function disposable(el) {
  for (const m of el.querySelectorAll('video, audio')) {
    // POSTER_TIME, not zero. Every desktop video is mounted at the poster
    // fragment, so `currentTime > 0` was true of a clip nobody had touched -
    // which made every video card on the board undisposable and left the nodes
    // map growing one detached <video> per card panned over, for the life of the
    // tab. An audio element carries no fragment and sits at 0, so the same
    // comparison is unchanged for it.
    if (!m.paused || m.currentTime > POSTER_TIME) return false;
  }
  // An embedded player is another origin, so there is no asking whether it is
  // playing - `paused` is not readable across one. Its presence is the answer
  // available: it only exists because somebody pressed Watch here, and
  // discarding the node would both stop whatever is running and throw away a
  // consent that is deliberately not written down anywhere else. Kept for the
  // same reason a playing clip is, on weaker evidence.
  if (el.querySelector('iframe')) return false;
  return true;
}

/**
 * Whether this node is making a noise right now.
 *
 * Narrower than disposable(), and the two answer different questions.
 * disposable() asks whether a node can be rebuilt without anyone noticing, and
 * a clip scrubbed to the middle and left there cannot - so it stays in the
 * cache, detached. This asks whether the node can be detached *at all*, and the
 * answer is no while it is playing: removing a media element from the document
 * runs the internal pause steps, so the cull would stop the sound. That is the
 * whole reason panning away from a playing clip used to kill it, and the reason
 * ui/nowplaying.js can offer to control something you cannot see.
 *
 * One node, in practice. registerPlayer()'s one-clip-at-a-time rule means there
 * is only ever one thing playing on a board, so this exempts exactly one card
 * from the cull - and it is off screen, so it is a card's worth of style and
 * layout with nothing to paint.
 */
function sounding(el) {
  for (const m of el.querySelectorAll('video, audio')) {
    if (!m.paused) return true;
  }
  return false;
}

/** Let go of one item's node and shadow, mounted or merely cached. */
function dropNode(id, el = nodes.get(id)) {
  if (!el) return;
  discard(el);
  nodes.delete(id);
  shadows.get(id)?.remove();
  shadows.delete(id);
}

/**
 * Drop cached nodes for items that are gone.
 *
 * A delta names the removed ids, so only their nodes are discarded - the common
 * case, an add or a delete of a handful, no longer walks the whole cache. Without
 * a delta (a load, or an emitter that names no change) it falls back to the diff
 * against the live board, which needs no payload to be correct.
 */
function reconcile(delta) {
  if (delta && delta.removed) {
    // A user delete (or redo of one) is the only path that names removed ids;
    // a load or clear reconciles by diff and reaches the else branch, so a
    // board swap never animates. Animate before dropNode discards the node -
    // flyOut clones it, so the snapshot survives the discard on the next line.
    if (delta.removed.length <= EXIT_ANIM_CAP) {
      for (const id of delta.removed) { const el = nodes.get(id); if (el) flyOut(el); }
    }
    for (const id of delta.removed) dropNode(id);
  } else {
    const live = new Set(board.items.map(i => i.id));
    for (const [id, el] of nodes) if (!live.has(id)) dropNode(id, el);
  }
  worldEl.classList.toggle('is-empty', board.items.length === 0);
}

/**
 * How many cards may be built from nothing in one frame.
 *
 * Building is the expensive half of this function by a wide margin - a card is
 * a few dozen elements, and a photograph's is an <img> the browser then has to
 * decode - where re-attaching a node that was merely detached is nearly free.
 * Zooming out is the case that matters: one notch of the wheel can bring two
 * hundred items inside the viewport at once, and building all of them between
 * two frames is one long stall exactly when the board is supposed to be
 * gliding.
 *
 * So a frame builds a handful and asks for another frame. The rest of that
 * zoom stays smooth and the board fills in over the next few frames, which
 * reads as loading rather than as juddering. Twelve is about what fits in the
 * slack of a frame on a mid-range laptop; the number is not delicate, and
 * anything from about eight to twenty behaves the same way.
 *
 * Twelve is what this shipped with and is what the quality dial's top stop asks
 * for; the lower stops trade a board that fills in later for a smoother zoom.
 * See BUILD_STEPS in quality.js.
 */
const buildBudget = () => quality.build;

/** Set when a sync ran out of budget, so the next frame knows to carry on. */
let catchUp = 0;

/**
 * How long the detach pass may be left undone while the view is in motion.
 *
 * Zooming out runs a full sync on every frame (see syncView), and the mount
 * half of it has a budget while the detach half has none: it walks everything
 * mounted, on every frame, for the whole gesture. The mount half cannot be put
 * off - a card that is not there is a hole in the picture - but nothing is
 * wrong with a card that is there a moment longer than it had to be.
 *
 * A throttle rather than a skip, and the distinction is the whole of it. Not
 * detaching at all while the view moves was the first shape of this and it is
 * the wrong one: a sustained pan across a large board never ends, so the
 * mounted set grows for as long as the hand keeps moving and the memory
 * ceiling this culling exists to hold is gone. Deferring it bounds the backlog
 * instead - at worst one window's worth of newly-arrived cards - and the
 * gesture still pays for it, just eight times a second rather than sixty.
 *
 * 120ms is roughly two of the viewport's settle windows and about seven frames.
 * Long enough that the walk stops being a per-frame cost, short enough that the
 * backlog is a handful of cards rather than a screenful.
 */
const DETACH_MS = 120;
let lastDetach = 0;
/**
 * A detach the throttle put off. Read by syncView(), which otherwise returns
 * early on the settling frame - the view has not moved since the last one,
 * which is exactly the condition for skipping, and exactly when the deferred
 * work has to be collected.
 */
let detachOwed = false;

/**
 * The padded rectangle the last sync mounted against, and the reason a pan is
 * not a walk over the whole board every frame.
 *
 * Everything inside this rectangle is already mounted. So while the part of the
 * board you can actually *see* stays within it, the answer this function would
 * arrive at is the answer it arrived at last time, and there is nothing to do -
 * which is the case on almost every frame of a pan, because the margin is a
 * couple of hundred pixels wide and a pan moves a few pixels per frame.
 *
 * Containment, with no slack of its own: the moment a visible edge reaches
 * ground the last sync did not cover, a card there would be missing, so that is
 * exactly when this has to run again. Zooming out grows the visible rectangle
 * and escapes almost at once; zooming in shrinks it and stays inside, which is
 * the right way round - zooming in never reveals anything new.
 *
 * Dropped on every path that changes what is mounted or where it is: an item
 * moving, arriving or leaving all come in through sync() itself, which forces.
 */
let syncedRect = null;

/** The view moved. Re-mount only if the screen has left what we last covered. */
function syncView() {
  if (!worldEl) return;
  // The exception to the containment guard: the view has stopped and the
  // throttle below owes a detach. Nothing has moved, so the guard would send
  // this frame away - and the settling frame is the last one that will be
  // offered until somebody touches the board again.
  const collecting = detachOwed && !vp.moving;
  if (syncedRect && !collecting) {
    const v = vp.visibleRect(0);
    if (v.x0 >= syncedRect.x0 && v.x1 <= syncedRect.x1 &&
        v.y0 >= syncedRect.y0 && v.y1 <= syncedRect.y1) return;
  }
  if (cullProfile.on) cullProfile.fullSyncs++;
  // No restack: looking around cannot change one item's rank against another, so
  // the whole-board paintStack() the event paths run would be O(n log n) of
  // arithmetic and a zIndex write per mounted node, spent every zoom frame to
  // arrive at the order that is already there. Fresh mounts still get their
  // rank from the cached index below.
  sync(false, true);
}

/**
 * Mount everything inside the padded viewport, detach everything outside it.
 *
 * `restack` is false on the pure view-change path (see syncView): stacking is a
 * fact about the items, not about where the eye is, so it is recomputed only
 * when an item moves, arrives or leaves - the callers that emit 'items'/'geom' -
 * and left alone on every frame of a pan or zoom.
 *
 * `viewPath` says the same thing about the *other* half: it is what lets the
 * detach pass be throttled while the view is in motion (see DETACH_MS). Named
 * separately from `restack` rather than inferred from it, because the two are
 * only incidentally the same caller today and a mount that leaves a deleted
 * item on screen is a much worse failure than a stale z-order.
 */
export function sync(restack = true, viewPath = false) {
  if (!worldEl) return;
  const r = vp.visibleRect(cullMargin());
  syncedRect = r;
  let built = 0;
  let owed = false;
  // Which items are on screen this pass. Filled by the mount loop and read by
  // the detach loop; the two used to be one loop over the whole board, and
  // splitting them is the point of the spatial index - the mount loop now visits
  // only what is near the viewport, and the detach loop only what is mounted.
  const onScreen = new Set();
  // Mount pass. queryRect() narrows the field from the whole board to the cells
  // the padded viewport touches; the precise test below is the same one the old
  // whole-board scan ran, now paid only for that handful of candidates.
  for (const id of spatial.queryRect(r)) {
    const item = byId(id);
    if (!item) continue;
    // The title card is not culled with the rest - it is handled once, below,
    // so it stays mounted off-screen (ui/mobile-header.js must always find its
    // node to style it) and never appears on the Mobile board.
    if (item.type === 'title') continue;
    // The circumscribed radius rather than the tight box: it costs no trig,
    // it is right at any rotation, and erring towards mounting something just
    // off screen is free where erring the other way is a visible pop-in.
    const half = itemRadius(item) + 2;
    const visible = item.x + half >= r.x0 && item.x - half <= r.x1 &&
                    item.y + half >= r.y0 && item.y - half <= r.y1;
    if (!visible) continue;   // in a shared cell, but its box misses the screen
    onScreen.add(id);
    const el = nodes.get(id);
    // Only a *new* node is rationed. Re-attaching one the detach loop merely
    // detached is a single append, so a pan across ground already visited costs
    // nothing and is never deferred. A deferred card has no node yet, so its
    // absence from a mounted state is nothing for the detach loop to undo.
    if (!el) {
      if (built >= buildBudget()) { owed = true; continue; }
      built++;
    }
    const node = el || build(item);
    // A node built during a view change carries no restack behind it, so it
    // takes its rank from the last one. Harmless on the restack path too - the
    // paintStack() below overwrites it a moment later with the fresh order.
    if (!el) node.style.zIndex = stackIndex.get(id) ?? 0;
    if (!node.isConnected) worldEl.append(node);
    const shadow = shadows.get(id);
    if (shadow && !shadow.isConnected) shadowLayerEl.append(shadow);
  }
  // The title card, kept mounted whatever the pan so its style always has a node
  // to land on. Desktop only: on Mobile it is left out of onScreen, so the
  // detach pass below unmounts it (the masthead is Mobile's title instead).
  if (board.layoutMode !== 'mobile') {
    const title = board.items.find(i => i.type === 'title');
    if (title) {
      onScreen.add(title.id);
      const node = nodes.get(title.id) || build(title);
      if (!node.isConnected) worldEl.append(node);
      const shadow = shadows.get(title.id);
      if (shadow && !shadow.isConnected) shadowLayerEl.append(shadow);
    }
  }
  // Detach pass. Walk what is mounted - bounded by the screen, not the board -
  // and let go of everything no longer on it. Three answers, not two: thrown
  // away, detached and kept for its media state, or - for the one clip actually
  // playing - left where it is, because detaching it would stop it. See
  // sounding().
  //
  // Keeping every one of them made memory proportional to the board a person had
  // *visited* rather than to what was on screen, which is the opposite of what
  // the culling is for: pan across a thousand photos and all thousand were still
  // held, decoded, for the life of the tab. The cache only ever earned its keep
  // for media that is mid-playback, so that is now all it holds - the nodes with
  // isConnected already false are that cache, and they are skipped, not rescanned.
  //
  // Throttled, but only while the view is actually moving and only on the view
  // path - see DETACH_MS. Every other caller is an item arriving, leaving or
  // moving, where the walk is the thing that makes the change visible.
  const now = performance.now();
  if (!viewPath || !vp?.moving || now - lastDetach >= DETACH_MS) {
    lastDetach = now;
    detachOwed = false;
    for (const [id, el] of nodes) {
      if (onScreen.has(id) || !el.isConnected) continue;
      // Before the shadow goes, so the card and its shadow stay in step. The
      // mount pass would put the shadow back on the way in, so either order
      // works; leaving both mounted is the one that needs no explaining.
      if (sounding(el)) continue;
      shadows.get(id)?.remove();
      if (disposable(el)) {
        discard(el);
        nodes.delete(id);
        shadows.delete(id);
      } else {
        el.remove();
      }
    }
  } else {
    detachOwed = true;
  }
  if (restack) paintStack();
  // Come back for the rest. One frame at a time and never more than one in
  // flight: another view change between now and then runs its own sync, which
  // is this same pass against a newer rectangle, and two of them queued would
  // build the same cards twice.
  if (owed) {
    if (!catchUp) catchUp = requestAnimationFrame(() => { catchUp = 0; sync(restack, viewPath); });
  } else if (catchUp) {
    cancelAnimationFrame(catchUp);
    catchUp = 0;
  }
}

/**
 * Dev-only instrumentation for the view-change cull, read by mbrd.perf.
 *
 * `runs` is every view frame while armed; `fullSyncs` the subset that fell
 * through to a full sync() (the zoom-out case); `ms` the total time in the
 * listener across those frames. avg = ms/runs is the cull's own per-frame cost,
 * the thing the main.js grid profiler never saw. Off by default - the listener
 * above pays one boolean read when it is.
 */
export const cullProfile = { on: false, ms: 0, runs: 0, fullSyncs: 0,
  reset() { this.ms = 0; this.runs = 0; this.fullSyncs = 0; } };

/**
 * Dev-only snapshot of what is mounted right now, for the memory readout. The
 * crash this measures is decoded-image and video-decoder memory, not frame
 * time, so it counts connected nodes, live <video> elements, and the decoded
 * size of every mounted <img> (naturalWidth x naturalHeight x 4 bytes - what
 * the browser actually holds, uncapped by how small the card is drawn).
 *
 * Cheap enough for the HUD to call a few times a second; never on a hot path.
 */
export function viewStats() {
  let mounted = 0, videos = 0, imgs = 0, imgBytes = 0;
  for (const el of nodes.values()) {
    if (!el.isConnected) continue;
    mounted++;
    videos += el.getElementsByTagName('video').length;
    for (const im of el.getElementsByTagName('img')) {
      if (im.naturalWidth) { imgBytes += im.naturalWidth * im.naturalHeight * 4; imgs++; }
    }
  }
  return { mounted, cached: nodes.size - mounted, videos, imgs, imgBytes };
}

/** Force-mount an item regardless of culling (used while dragging). */
export function ensureMounted(id) {
  const item = byId(id);
  if (!item) return null;
  const el = nodes.get(id) || build(item);
  if (!el.isConnected) worldEl.append(el);
  const shadow = shadows.get(id);
  if (shadow && !shadow.isConnected) shadowLayerEl.append(shadow);
  paintStack();
  return el;
}

/**
 * How tall this item's caption plate is, in world units. Zero if it has none.
 *
 * Read off the node rather than worked out, because the number is the
 * stylesheet's: a fence's name is set at `clamp(10.5px, 2.8cqi, 30.8px)` of the
 * region's own width, plus padding in em, so anything here that computed it
 * would be a second copy of that clamp to keep in step. `offsetHeight` is
 * measured before the world transform, so what comes back is already in world
 * units - the same reading canvas/notes.js takes for a note's text.
 *
 * Mounted first, since a plate that is not in the document has no height and
 * "not on screen" is not an answer to this question.
 *
 * The caller is the region-closing half of rearrange(): a fence's plate sits
 * across the top of its box, so a layout packed to the box's top edge puts its
 * first row *under the name*. This is how much room to leave it.
 */
export function barHeight(id) {
  const el = ensureMounted(id);
  const bar = el?.querySelector(':scope > .item-bar');
  return bar ? bar.offsetHeight : 0;
}

/**
 * One card, from nothing: built, registered, shadowed, placed and selected.
 *
 * The first two lines are canvas/item-dom.ts's - the lean and the tree of
 * elements - and everything after them is this module's, which is the whole of
 * the seam between the two files. The lean is dealt here rather than inside the
 * builder because the geometry twin has to carry the same one, and dealing it
 * twice would give a card and its shadow two different angles.
 *
 * `pickedId` is the first end of a connection being drawn, and it is held in
 * this module rather than in ui/toolbar.js precisely because of this function: a
 * card that is culled while it is picked is thrown away and rebuilt from nothing
 * when it comes back on screen, so a mark applied only to the live node would
 * quietly disappear the moment somebody panned away from it and back.
 */
function build(item) {
  const tilt = restingTilt(item);
  const el = buildItem(item, tilt, item.id === pickedId);

  nodes.set(item.id, el);
  // The title card carries its own drop shadow in CSS (box-shadow on
  // .title-card), because the 3:2 card is smaller than its snapped item box and
  // a twin placed at the box would sit taller than the card it shadows.
  // A ghost card is left out for the same reason as the title card, not a
  // different one: its silhouette is not the item box. At Softish it is clipped
  // to a torn polygon, and a rectangular twin would lay a clean shadow under a
  // ragged scrap. So the shadow is CSS on .ghost-card, where the clip is, and
  // each tier draws the one that fits it.
  // And at the bottom of the quality dial there is no twin for anything:
  // turning the shadow off in CSS alone would leave a second element per card
  // being built, placed and mirrored on every move in order to paint nothing.
  // A fence joins them, for a third reason: it is not a sheet of paper. A drop
  // shadow under a two-thousand-unit rectangle reads as an enormous card lying
  // on the board rather than as a region drawn on it, and it would be cast over
  // every card the fence contains.
  // And a sticker, for the first reason again and more so: its silhouette is a
  // star or an arrow, and a rounded rectangle laid under one is a card-shaped
  // halo around a shape that is not a card - the one thing the whole type is
  // trying not to be. Its shadow is a drop-shadow() on .sticker-art, which
  // follows the glyph.
  if (quality.shadows && !NO_TWIN.has(item.type)) {
    // Built there, placed here: placeBox() is arithmetic against the viewport,
    // which is what kept it on this side of the split.
    const twin = buildShadow(item, tilt);
    placeBox(twin, item);
    shadows.set(item.id, twin);
  }
  // The title card's pen and rename buttons live for the card's whole life - CSS
  // shows them on hover or selection. A child of .item, like the grips, so they
  // ride its transform and hold a constant on-screen size through --iz.
  if (item.type === 'title') buildTitleControls(el);
  place(el, item);
  if (selection.has(item.id)) { el.classList.add('is-selected'); setGrips(el, true); }
  return el;
}

/**
 * The types that get no geometry twin in #item-shadows.
 *
 * Every one of them for the same underlying reason: the twin is a rounded
 * rectangle at the item box, so it is only ever right for a type whose
 * silhouette *is* that box. Where it is not, the twin lays a card's shadow
 * under something that is not a card. The four cases are argued one by one at
 * the call site, which is where the shadow is decided; this is only the list.
 */
const NO_TWIN = new Set(['title', 'ghost', 'fence', 'sticker']);

/** Rebuild one item's content in place (note edits, renames). */
function rebuild(id) {
  const el = nodes.get(id);
  const item = byId(id);
  if (!el || !item) return;
  const body = el.querySelector('.item-body');
  // The old content is being thrown away, not detached, so it has to be let go
  // of properly first - replaceChildren would otherwise leave the card's former
  // <audio> registered under the volume control and holding its stream, once
  // per rename.
  releasePlayers(body);
  body.replaceChildren(buildContent(item));
  // data-fit lives on the outer .item and is otherwise only written in build(),
  // so a per-item fit change (which arrives as 'item' → rebuild) would rebuild
  // the picture but leave the old object-fit. Re-read it here.
  writeFit(el, item);
  // The bar is a sibling of the body, so replaceChildren above does not touch
  // it - only the caption inside it needs the new name. Patched rather than
  // rebuilt so the handle beside it keeps its identity, and with it any focus
  // the keyboard had put there.
  const label = el.querySelector('.item-bar > .item-label');
  if (label) {
    label.textContent = item.name || '';
    label.hidden = !item.name;
  }
  // The headline is the same string on the same schedule, and it is a sibling
  // too. A note is why this cannot be skipped as "renames only": a note's name
  // is its first line, rewritten on every edit, and an edit arrives here as an
  // ordinary re-render.
  const head = el.querySelector(':scope > .far-head');
  if (head) {
    head.querySelector('.fh-name').textContent = item.name || '';
    // The kind follows a rename too: the extension is read off item.name, so
    // renaming "sketch.png" to "sketch" changes what this card calls itself.
    head.querySelector('.fh-kind').textContent = farKind(item);
    head.hidden = !item.name;
  }
  // The accessible name follows the caption, or a renamed card would keep
  // announcing its old name (or "Untitled ..."). See AUD-09.
  el.setAttribute('aria-label', itemAccessibleName(item));
}

/**
 * Whether an item has a name you can get at.
 *
 * Everything except a sticky note. A note does carry a `name` - the first line
 * of its text, copied when it was created - but nothing on the board draws it,
 * so renaming one would be typing into a field with no visible effect. What a
 * note has instead is Edit text, which changes the line the name came from.
 */
export const canRenameItem = id => {
  const type = byId(id)?.type;
  return !!type && type !== 'note';
};

/**
 * Rename an item by typing on the name it is already showing.
 *
 * There are two places that name appears and they are not interchangeable. A
 * picture wears it on the caption plate across its foot; a card - audio, text,
 * or any of the ~1350 named formats - has no plate, because CSS hides it for
 * every type that has a card, and carries its name on the .card-name line
 * inside instead. Whichever one you can actually see is the one that turns
 * editable, so the rename happens where you are already looking rather than in
 * a dialog thrown over the top of it. The same bargain a sticky note makes -
 * see canvas/notes.js, which this follows.
 *
 * A card line normally shows the stem alone (renderers.js runs it through
 * baseName), but an edit puts the whole filename back on screen for as long as
 * it lasts. What gets committed is the item's name in full, and hiding half of
 * a string while someone edits it is how a .jpg goes missing without anyone
 * being told.
 */
export function editItemName(id) {
  const item = byId(id);
  if (!item || !canRenameItem(id)) return;
  const el = ensureMounted(id);
  const body = el?.querySelector('.item-body');
  if (!body) return;

  const field = el.querySelector('.card-name') || el.querySelector('.item-label');
  if (!field) return;
  // A picture that has lost its name still has its caption element - the bar
  // always builds one - but it is hidden, and typing into a hidden element is
  // typing into nothing. Shown for the length of the edit, and hidden again
  // below if nothing came of it.
  const wasHidden = field.hidden;
  field.hidden = false;

  el.classList.add('is-editing');
  // plaintext-only keeps pasted markup out of a name; not every engine has it.
  try { field.contentEditable = 'plaintext-only'; }
  catch { field.contentEditable = 'true'; }
  if (!field.isContentEditable) field.contentEditable = 'true';
  field.textContent = item.name;

  let done = false;
  let keep = true;

  const onKey = e => {
    e.stopPropagation();          // the canvas must not see Delete, space or Escape
    if (e.key === 'Enter') { e.preventDefault(); finish(); }
    else if (e.key === 'Escape') { keep = false; finish(); }
  };

  function finish() {
    if (done) return;
    done = true;
    // Read before anything is torn down: innerText is what the field *renders*,
    // and both the class and the editable flag being dropped below are things
    // stylesheets key off. A name is one line, so a pasted paragraph is
    // flattened into one rather than refused - the alternative is a caption
    // plate two thirds of a page tall - and renameItem() trims the ends.
    const typed = field.innerText.replace(/\s+/g, ' ');
    field.removeEventListener('keydown', onKey);
    field.removeEventListener('blur', finish);
    field.contentEditable = 'false';
    field.blur();
    el.classList.remove('is-editing');
    // Put the field back the way state has it *before* asking for the rename.
    // A name that comes back unchanged commits nothing and so fires no rebuild,
    // and without this the half-finished text would simply stay on screen.
    field.textContent = item.name;
    if (wasHidden && !item.name) field.hidden = true;
    // Escape abandons, and must not travel through renameItem() as an empty
    // string: empty means "put the original filename back", which is an edit of
    // its own and the opposite of cancelling one.
    const wasName = item.name;
    if (keep) renameItem(id, typed);
    // A cancel, or a rename that resolved to the same name, commits nothing and
    // fires no rebuild - so the field is left showing the full filename put on it
    // above instead of the stem a .card-name renders (baseName). Repaint to the
    // canonical caption. A real change already rebuilt via renameItem's 'item'.
    if (item.name === wasName) rebuild(id);
  }

  field.addEventListener('keydown', onKey);
  field.addEventListener('blur', finish);
  // Selected, not just focused: a rename usually replaces the name rather than
  // appends to it, and a 60-character filename is a long way to hold backspace.
  field.focus();
  const range = document.createRange();
  range.selectNodeContents(field);
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

// World y points up, CSS top points down - this negation is the only place the
// two conventions meet on the layout side (viewport.js handles the other half).
// Rotation is negated for the same reason: a positive angle is anticlockwise in
// the world, clockwise in CSS.
function place(el, item) {
  placeBox(el, item);
  el.style.zIndex = Math.round(item.z);
}

/** Apply the outer geometry shared by an item and its shadow twin. */
function placeBox(el, item) {
  el.style.left = (item.x - item.w / 2).toFixed(2) + 'px';
  el.style.top = (-item.y - item.h / 2).toFixed(2) + 'px';
  el.style.width = item.w.toFixed(2) + 'px';
  el.style.height = item.h.toFixed(2) + 'px';
  // Half the shorter side: the ceiling the browser puts on a border-radius.
  // CSS can express the cap (50%) but not *read* the capped result, and the
  // selection ring and its corner marks have to trace the corner that actually
  // got drawn - so the number is handed to them from here, where the size is
  // known. See --own-radius in canvas.css.
  el.style.setProperty('--half-min', (Math.min(item.w, item.h) / 2).toFixed(2) + 'px');
  // The same fact per axis, for anything that has to stay a share of the side it
  // sits on rather than of the shorter one. The corner grab boxes are why: they
  // are a constant size on screen, so on a small card four of them met in the
  // middle and the whole face resized. They now cap their lap onto the card at a
  // fraction of the side they lap along - which on a 400x60 banner has to be a
  // fraction of 400 across and of 60 down, not of 60 twice. A percentage cannot
  // say this: a percentage inside a grip resolves against the grip's own box,
  // which is itself already capped. See --grip-lap-x / -y in items.css.
  el.style.setProperty('--half-w', (item.w / 2).toFixed(2) + 'px');
  el.style.setProperty('--half-h', (item.h / 2).toFixed(2) + 'px');
  el.style.transform = itemTransform(item);
}

/* ---------------------------------------------------------------------------
   The device-pixel snap: why an item is not drawn exactly where it is.

   A card's border is one screen pixel wide and lands wherever the arithmetic
   puts it, which is nowhere in particular. An item sits at a fractional world
   coordinate, the layer is scaled by a fractional zoom and translated by a
   fractional pan, so each of a card's four edges falls at its own position
   *between* two device pixels and is drawn split across both of them. The width
   is right; the coverage is not. An edge at 0.9/0.1 reads as a black hairline
   and the opposite edge of the same card at 0.5/0.5 reads as two rows of grey -
   which is a card whose border is visibly heavier on two sides than the other
   two, at every zoom, and different again on the card beside it.

   Nothing in CSS can fix that, because nothing in CSS can move an edge onto the
   grid. So this does: each item is nudged by under a pixel and scaled by under a
   part in a thousand, so that the box it is actually drawn in begins and ends on
   whole device pixels. Everything inside the card - the ring, the inner rule,
   the caption plate - follows for free, because they are all measured from that
   box.

   **In `transform`, which nothing transitions.** The individual translate /
   rotate / scale properties on .item carry the hover lift, the resting lean and
   the drag tilt, and every one of them is animated (items.css). A sub-pixel
   correction that eases in over 200ms is a correction that is wrong for 200ms,
   sixty times a gesture. `transform` is already this module's - it carries
   item.rot - and has no transition on it, so the snap lands on the frame it is
   written. It also costs no layout: a translate and a scale are a compositor
   matrix, not a reflow, which is what makes it affordable to redo for every
   mounted card at once.

   **Only while the board is still.** The snap is a function of the zoom and the
   pan, so it would have to be recomputed on every frame of a gesture - and while
   the board is moving nobody is inspecting a hairline, and the layer is being
   resampled anyway. resnap() below runs on the settling frame instead, the same
   140ms hook that exchanges cheap drawing for proper drawing everywhere else.
   Mid-gesture the last settled offsets are simply left in place: they are stale
   by at most a pixel, on a board that is moving past at speed.

   **Not for anything rotated.** A leaning edge crosses a pixel row every few
   dozen pixels of its own length, so it is grey the whole way round at every
   position - there is no offset that aligns it and nothing here to win. An item
   with its own item.rot is left alone entirely. The whimsy tiers' resting lean
   is a CSS `rotate`, applied outside this transform, so a tilted card still gets
   the nudge and simply gains nothing from it - which is why the tier that
   depends on the edge, Harsh, stands its cards up (quality.css).

   **The drawn box is not the stored box**, by up to one device pixel. Resize
   arithmetic, the marquee and everything saved go on reading item.x/y/w/h, the
   same bargain the resting tilt already strikes and for the same reason: this is
   presentation. A hit test goes through the browser, which tests what is drawn.
   --------------------------------------------------------------------------- */

/**
 * How far this item has to move, and by how much it has to grow, for its drawn
 * box to land on whole device pixels. Null when there is nothing to do or
 * nothing to be gained.
 */
function deviceSnap(item) {
  if (!vp || item.rot) return null;
  const dpr = globalThis.devicePixelRatio || 1;
  const k = vp.zoom * dpr;                    // world px -> device px
  const w = item.w * k, h = item.h * k;       // the drawn size, in device px
  if (!(k > 0) || !(w >= 1) || !(h >= 1)) return null;
  // The top-left corner, in device pixels from the top-left of the window. The
  // viewport's own offset is in there because the device grid is the screen's,
  // not the element's.
  const p = vp.toScreen(item.x - item.w / 2, item.y + item.h / 2);
  const ax = (vp.left + p.x) * dpr;
  const ay = (vp.top + p.y) * dpr;
  // Round the size first, then place the rounded size so its near edge is whole:
  // both edges are then whole, which is the point - a snapped left edge over a
  // fractional width just moves the soft edge to the other side of the card.
  const W = Math.max(1, Math.round(w));
  const H = Math.max(1, Math.round(h));
  // The scale is about the centre, which does not move, so the translate is what
  // the corner still needs after the growth has been shared between both edges.
  return {
    dx: (Math.round(ax) - ax + (W - w) / 2) / k,
    dy: (Math.round(ay) - ay + (H - h) / 2) / k,
    sx: W / w,
    sy: H / h,
  };
}

/** The `transform` an item wears: its own rotation, and the snap under it. */
function itemTransform(item) {
  const rot = item.rot ? `rotate(${-item.rot}deg)` : '';
  const s = deviceSnap(item);
  if (!s) return rot;
  return `translate(${s.dx.toFixed(3)}px, ${s.dy.toFixed(3)}px)`
       + ` scale(${s.sx.toFixed(5)}, ${s.sy.toFixed(5)})${rot ? ' ' + rot : ''}`;
}

/**
 * Re-snap every mounted card to the device grid, now that the view has stopped.
 *
 * Cheap by construction: it walks what is mounted rather than the board, writes
 * one property per node, and writes nothing at all when the string has not
 * changed - which is most of the time on a pan that ends where a rung began.
 * Skipped outright while the view is in motion; the caller runs on every view
 * frame and this is the guard that makes that free.
 */
function resnap() {
  if (!worldEl || !vp || vp.moving) return;
  for (const [id, el] of nodes) {
    if (!el.isConnected) continue;
    // Connected, but not necessarily *here*. The note composer lifts a live card
    // out of the world layer and into a dialog (openComposer, canvas/notes.js),
    // where it is scaled by the dialog rather than placed by the board - so the
    // device-pixel snap, which is a correction against the world transform, has
    // nothing to correct and would overwrite the scale that is drawing the sheet.
    // A node outside the world layer is not on the board's transform at all.
    if (el.parentElement !== worldEl) continue;
    const item = byId(id);
    if (!item) continue;
    const t = itemTransform(item);
    if (el.style.transform !== t) el.style.transform = t;
    // The twin traces the same silhouette, so it takes the same correction - a
    // shadow half a pixel out from under its card is a second card.
    const shadow = shadows.get(id);
    if (shadow && shadow.style.transform !== t) shadow.style.transform = t;
  }
}

/**
 * Paint effective z-order for every mounted or cached node.
 *
 * Raw item.z remains the persisted order used to infer that a note lies on a
 * lower host. visualStackOrder() folds each inferred sticky chain into one
 * external layer, then orders its members internally so notes still draw above
 * their host. Repainting all nodes is necessary when one layer moves: every
 * layer it crosses changes relative rank even though those items emitted no
 * geometry event of their own.
 */
/**
 * id -> effective z-index, cached from the last restack.
 *
 * Read when sync() mounts a fresh node on a view-change frame, which does not
 * restack (see syncView): the new node still needs a rank, and the ranks did
 * not change, so it takes the one this remembers rather than forcing the whole
 * board to be recomputed for the sake of one card scrolling into view.
 */
let stackIndex = new Map();

// The two underlays inside #world, from canvas.css: #item-shadows at -1 and #web
// at -2. Named here because the fence band has to be sunk past both of them, and
// a bare -3 in the arithmetic below would be a number nobody could check.
const UNDERLAY_Z = -2;

function paintStack() {
  const order = visualStackOrder();
  // Every fence goes *below the shadow underlay*, not merely below every card.
  //
  // A fence is ground: it has a face, and the cards standing on it cast onto it,
  // which is the one thing a shared shadow layer cannot express while the ground
  // is in the same layer as the things standing on it. Left in the item stack, a
  // fence's paper covered the shadow of every card inside it - the region read as
  // a page with the cards printed flat on it rather than lying on it.
  //
  // Both underlays take no pointer (canvas.css says so for each), so passing
  // beneath them costs a fence nothing: its name plate is as pressable at -3 as
  // it was at 0. The band is contiguous and comes first out of
  // visualStackOrder(), so its size is where the first non-fence starts, and the
  // slice keeps its own order - largest region furthest back.
  // The frontmost fence lands exactly one below the lowest underlay and the rest
  // count down from it, so a board with no fences is written the same numbers it
  // always was.
  const band = order.findIndex(id => !isFence(byId(id)));
  const fences = band < 0 ? order.length : band;
  stackIndex = new Map(order.map((id, index) =>
    [id, index < fences ? index - fences + UNDERLAY_Z : index]));
  for (const [id, el] of nodes) el.style.zIndex = stackIndex.get(id) ?? 0;
}

function placeNode(id) {
  const el = nodes.get(id);
  const shadow = shadows.get(id);
  const item = byId(id);
  if (el && item) place(el, item);
  if (shadow && item) placeBox(shadow, item);
}

function paintSelection() {
  for (const [id, el] of nodes) {
    const on = selection.has(id);
    setGrips(el, on);
    el.classList.toggle('is-selected', on);
    // The twin tracks selection too, so a selected card's shadow holds still
    // under the pointer exactly as the card does (see .item-shadow in canvas.css).
    shadows.get(id)?.classList.toggle('is-selected', on);
  }
}

/** Repaint every mounted node from scratch - used after loading a board. */
export function resetItems() {
  for (const el of nodes.values()) discard(el);
  nodes.clear();
  shadows.clear();
  shadowLayerEl.replaceChildren();
  // The display copies are keyed by content hash and a new board is new content;
  // release the ones this session made so a long-lived PWA does not accumulate
  // them board after board (canvas/display.js).
  clearDisplay();
  // A new board gets a new pack, so its first three items carry a full set of
  // leans rather than whatever was left over from the last one.
  resetTilt();
  reconcile();
  reindex();
  sync();
}
