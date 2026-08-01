// Mounts board items into #world and keeps their DOM in sync with state.
//
// Culling keeps the DOM proportional to what is on screen rather than to the
// size of the board. A node that scrolls out of view is detached, and then
// either kept or thrown away: kept if its media is mid-playback, so a video
// that leaves and re-enters the viewport carries on where it was, and thrown
// away otherwise, because rebuilding a still card costs a few DOM nodes while
// holding one costs whatever it had decoded. See disposable() and discard().

import {
  board, byId, selection, bus, renameItem, visualStackOrder, stuckFollowers,
} from '../state.js';
import { shuffle } from '../util.js';
import { quality } from '../quality.js';
import { itemRadius, rotatedExtents } from '../geometry.js';
import { buildContent, fitMode } from './renderers.js';
import { clearDisplay } from './display.js';
import { releasePlayers } from './audio.js';
import { flyOut } from './exit-anim.js';
import * as spatial from './spatial.js';

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
 * A hover raises the item and everything stuck on top of it - a photo lifts
 * its stickies with it, so the pile reads as one object - but never its host,
 * so pointing at one note in a stack lifts that note and its own riders while
 * the card beneath stays put. stuckFollowers() is exactly that upward set.
 */
let lastHoverId = null;
let hoverGroup = new Set();
function setHoverLift(id, on) {
  nodes.get(id)?.classList.toggle('is-hover', on);
  shadows.get(id)?.classList.toggle('is-hover', on);
}
function setHoverGroup(id) {
  if (id === lastHoverId) return;
  lastHoverId = id;
  const next = new Set(id ? [id, ...stuckFollowers([id])] : []);
  for (const gid of hoverGroup) if (!next.has(gid)) setHoverLift(gid, false);
  for (const gid of next) if (!hoverGroup.has(gid)) setHoverLift(gid, true);
  hoverGroup = next;
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

/** That margin in world units at the current zoom. */
const cullMargin = () => Math.min(CULL_MARGIN_PX / vp.zoom, CULL_MARGIN_MAX);

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
      if (item && (item.type === 'image' || item.type === 'video')) el.dataset.fit = fitMode(item);
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
  vp.onChange(() => {
    if (!cullProfile.on) { syncView(); return; }
    const t = performance.now();
    syncView();
    cullProfile.ms += performance.now() - t;
    cullProfile.runs++;
  });
  reconcile();
  reindex();
  sync();
}

export function nodeFor(id) { return nodes.get(id); }

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
    if (!m.paused || m.currentTime > 0) return false;
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

function build(item) {
  const el = document.createElement('div');
  el.className = 'item';
  el.dataset.id = item.id;
  el.dataset.type = item.type;
  el.dataset.fit = fitMode(item);
  // A named, self-describing card for assistive technology. The full
  // keyboard-selection model (roving tabindex, arrow navigation) is a separate,
  // browser-verified change; naming and role are the part that is safe to ship
  // without a focus-order regression. See AUD-09.
  el.setAttribute('role', 'group');
  el.setAttribute('aria-roledescription', 'board item');
  el.setAttribute('aria-label', itemAccessibleName(item));
  // Which colour off the sticky pad. CSS picks the tint from this.
  if (item.meta.tint) el.dataset.tint = item.meta.tint;
  // How far off square this one rests, as a fraction of whatever the whimsy
  // axis currently allows (--tilt-max). Presentational, so it stays out of
  // item.rot and the geometry model - see tiltFactor().
  const tilt = tiltFactor().toFixed(3);
  el.style.setProperty('--item-tilt', tilt);

  const body = document.createElement('div');
  body.className = 'item-body';
  body.append(buildContent(item));
  el.append(body);

  // The strip across the foot: the caption, and the handle that opens this
  // item's menu. One element holding both, because they share an edge and two
  // absolutely positioned boxes guessing at each other's height is how you get
  // a one-pixel step between them - which is exactly what the first attempt at
  // this looked like.
  //
  // On .item rather than in .item-body, and that is load-bearing: re-rendering
  // an item calls replaceChildren() on the body, so a bar built in there would
  // survive until the first redraw and then quietly vanish.
  el.append(bottomBar(item));

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
  if (quality.shadows && item.type !== 'title' && item.type !== 'ghost') {
    shadows.set(item.id, buildShadow(item, tilt));
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
 * A content-free copy of an item's outer geometry.
 *
 * All copies share #item-shadows, a layer below every real item. Keeping these
 * separate from the item stacking contexts is what prevents a high card's
 * shadow from being painted across a lower card.
 */
function buildShadow(item, tilt) {
  const el = document.createElement('div');
  el.className = 'item-shadow';
  el.dataset.id = item.id;
  el.dataset.type = item.type;
  el.style.setProperty('--item-tilt', tilt);
  placeBox(el, item);
  return el;
}

/**
 * The eight resize handles: four corners, and four edges for resizing one axis
 * alone. The single-letter ones are the edges (see .grip-edge in app.css).
 *
 * They exist for exactly as long as the card is selected, which is exactly as
 * long as they are drawn - CSS hides them otherwise, and there is no grabbing
 * one that is not on screen. They used to be built with the card and kept for
 * its life, which made them the largest single part of an item's DOM and the
 * least used: on a full screen of cards, a few hundred elements the browser
 * walked past on every style recalculation for nothing. That bill falls due on
 * every frame of a zoom, since the zoom is what item chrome is sized against.
 *
 * Built and dropped rather than built once and left, because a board is
 * something you sweep a marquee across: keeping them would mean every card the
 * marquee ever touched carrying its eight for the rest of the session, which is
 * the state this was trying to get out of. The churn is not per frame - a card
 * only changes hands when its selection actually changes, which is once per
 * sweep - so it is eight elements per card touched, not eight per card per
 * gesture.
 */
const GRIPS = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

function setGrips(el, want) {
  // The title card moves but does not resize: its size is the style's size dial,
  // not a drag on a corner. So it never gets grips, however it is selected.
  //
  // A ghost card is the same, for a different reason: it holds a fixed sentence
  // at a fixed 3:2, and it is leaving as soon as the board has anything on it.
  // There is nothing to gain by resizing one and a stretched hint looks broken.
  // Grips are the only way into a resize - canvas/input.js reaches it through
  // `.grip` and nothing else - so withholding them here is the whole lock.
  if (el.dataset.type === 'title' || el.dataset.type === 'ghost') want = false;
  if (!!el.dataset.grips === want) return;
  if (!want) {
    delete el.dataset.grips;
    for (const grip of el.querySelectorAll(':scope > .grip')) grip.remove();
    return;
  }
  el.dataset.grips = '1';
  for (const g of GRIPS) {
    const grip = document.createElement('div');
    grip.className = g.length === 1 ? 'grip grip-edge' : 'grip';
    grip.dataset.g = g;
    el.append(grip);
  }
}

/**
 * The title card's two pop-up buttons: a pen to the RIGHT that opens the shared
 * masthead style panel, and a T to the LEFT that drops into inline rename of the
 * board name (single tap). Renaming is also a double-tap of the card itself (see
 * the dblclick handler in input.js). Only the title card has them, built once and
 * kept - app.css shows them on hover or while the card is selected. Children of
 * `.item` like the grips, so they ride the card's transform and hold a constant
 * on-screen size through --iz. The clicks themselves are caught by
 * canvas/input.js (which owns cmds), the way grip and widget hits are - this only
 * draws the buttons.
 */
function buildTitleControls(el) {
  if (el.querySelector(':scope > .item-pen')) return;
  const pen = document.createElement('button');
  pen.type = 'button';
  pen.className = 'item-pen';
  pen.setAttribute('aria-label', 'Edit title style');
  pen.title = 'Edit title style';
  pen.innerHTML =
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M11.5 2.5l2 2L6 12l-3 1 1-3z"/><path d="M10 4l2 2"/></svg>';
  const rename = document.createElement('button');
  rename.type = 'button';
  rename.className = 'item-rename';
  rename.setAttribute('aria-label', 'Rename board');
  rename.title = 'Rename board';
  rename.textContent = 'T';
  el.append(pen, rename);
}

/**
 * The strip across the foot of a card: caption on the left, handle on the right.
 *
 * Always built, for every type. Which types show a *caption* is still a
 * question app.css answers - a sticky note has a name nothing draws - and CSS
 * reveals the handle only while this item is selected. Touch also has the
 * long-press route, so hiding the resting handle does not strand its actions.
 */
/**
 * A human word for an item's type, for the times it has no name of its own.
 * "Untitled picture" reads; "generic" does not.
 */
const TYPE_LABEL = {
  image: 'picture', video: 'video', audio: 'audio clip',
  note: 'note', model: 'model', link: 'link', embed: 'embed',
};

/**
 * The name assistive technology announces for a card.
 *
 * Cards were bare `<div class="item">` with no accessible name, and every
 * item's menu button was called only "Actions" - so a board read out as a run
 * of identical controls with no way to tell which was which. This gives each
 * card its own name: the item's, or a typed fallback. See AUD-09.
 */
export function itemAccessibleName(item) {
  const name = typeof item?.name === 'string' ? item.name.trim() : '';
  if (name) return name;
  return `Untitled ${TYPE_LABEL[item?.type] || 'item'}`;
}

function bottomBar(item) {
  const bar = document.createElement('div');
  bar.className = 'item-bar';
  bar.append(nameplate(item));
  return bar;
}

/**
 * The caption itself. Built in one place because a rename rebuilds it.
 *
 * Always present, empty when there is no name - so the bar has something to
 * lay out against, and [hidden] rather than absence is what makes the strip
 * shrink to just the handle. A rename can then fill it without the bar being
 * rebuilt around it.
 */
function nameplate(item) {
  const label = document.createElement('div');
  label.className = 'item-label';
  label.textContent = item.name || '';
  label.hidden = !item.name;
  return label;
}

/**
 * A number in [-1, 1] for an item, used as its resting tilt - freshly dealt,
 * so the board is pinned up a little differently every time you open it.
 *
 * A third of the board hangs straight, and the tilted two-thirds lean left and
 * right in equal numbers. That is a property of the *set*, not of any one
 * item, so these are dealt from a bag rather than rolled independently: one
 * slot of each kind per three items, reshuffled whenever it runs out. Rolling
 * independently would only hit those proportions on average, and a small board
 * - which is most boards - would miss them visibly.
 *
 * Over any whole group of three the split is exact. A board whose count is not
 * a multiple of three is off by at most one item, which is the best that
 * exists.
 *
 * Dealt here in build() rather than stored on the item, which also settles how
 * long a lean lasts: nodes are cached and only detached when culled, so an item
 * keeps its lean while you pan away and back, and only a reload or opening
 * another board re-deals the pack.
 *
 * It stays out of item.rot on purpose. rot is geometry - fit() reads it, the
 * resize handles work in its frame, a marquee tests against it, and it is
 * saved. This is presentation: the browser hit-tests the rotated box, so
 * pointing at a crooked item still works, and nothing that reasons about where
 * things *are* has to know the board is not square.
 */
const tiltBag = [];
/** Below this a tilted item reads as a straight one that missed, not a lean. */
const TILT_MIN = 0.4;

function tiltFactor() {
  if (!tiltBag.length) {
    // Shuffled, so the straight one is not always in the same position within
    // its three. Dealing them in order would put every third item square, and
    // in a grid arrangement that regularity reads as banding rather than as a
    // hand-pinned board.
    tiltBag.push(0, -1, 1);
    shuffle(tiltBag);
  }
  const dir = tiltBag.pop();
  return dir && dir * (TILT_MIN + Math.random() * (1 - TILT_MIN));
}

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
  el.dataset.fit = fitMode(item);
  // The bar is a sibling of the body, so replaceChildren above does not touch
  // it - only the caption inside it needs the new name. Patched rather than
  // rebuilt so the handle beside it keeps its identity, and with it any focus
  // the keyboard had put there.
  const label = el.querySelector('.item-bar > .item-label');
  if (label) {
    label.textContent = item.name || '';
    label.hidden = !item.name;
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
    if (keep) renameItem(id, typed);
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
  // known. See --own-radius in app.css.
  el.style.setProperty('--half-min', (Math.min(item.w, item.h) / 2).toFixed(2) + 'px');
  // The same fact per axis, for anything that has to stay a share of the side it
  // sits on rather than of the shorter one. The corner grab boxes are why: they
  // are a constant size on screen, so on a small card four of them met in the
  // middle and the whole face resized. They now cap their lap onto the card at a
  // fraction of the side they lap along - which on a 400x60 banner has to be a
  // fraction of 400 across and of 60 down, not of 60 twice. A percentage cannot
  // say this: a percentage inside a grip resolves against the grip's own box,
  // which is itself already capped. See --grip-lap-x / -y in app.css.
  el.style.setProperty('--half-w', (item.w / 2).toFixed(2) + 'px');
  el.style.setProperty('--half-h', (item.h / 2).toFixed(2) + 'px');
  el.style.transform = item.rot ? `rotate(${-item.rot}deg)` : '';
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

function paintStack() {
  stackIndex = new Map(visualStackOrder().map((id, index) => [id, index]));
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
    // under the pointer exactly as the card does (see .item-shadow in app.css).
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
  tiltBag.length = 0;
  reconcile();
  reindex();
  sync();
}
