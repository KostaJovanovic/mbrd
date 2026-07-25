// Mounts board items into #world and keeps their DOM in sync with state.
//
// Nodes are cached by id and only *detached* when they scroll out of view, not
// destroyed - so a playing <video> or a scrubbed <audio> keeps its state when it
// leaves and re-enters the viewport. Culling keeps the DOM proportional to what
// is on screen rather than to the size of the board.

import { board, byId, selection, bus } from '../state.js';
import { buildContent, fitMode } from '../import/renderers.js';

/** id -> element, including elements currently detached by culling. */
const nodes = new Map();
let worldEl = null;
let vp = null;

/** World-space margin around the viewport kept mounted, to hide pop-in. */
const CULL_MARGIN = 400;

export function initItems(world, viewport) {
  worldEl = world;
  vp = viewport;
  bus.on('items', () => { reconcile(); sync(); });
  bus.on('geom', ids => { for (const id of ids) placeNode(id); sync(); });
  bus.on('item', id => rebuild(id));
  bus.on('selection', paintSelection);
  vp.onChange(sync);
  reconcile();
  sync();
}

export function nodeFor(id) { return nodes.get(id); }

/** The item id owning a DOM node, or null for canvas chrome. */
export function itemIdFromEvent(target) {
  const el = target instanceof Element ? target.closest('.item') : null;
  return el ? el.dataset.id : null;
}

/** Drop cached nodes for items that no longer exist. */
function reconcile() {
  const live = new Set(board.items.map(i => i.id));
  for (const [id, el] of nodes) {
    if (live.has(id)) continue;
    el.remove();
    nodes.delete(id);
  }
  worldEl.classList.toggle('is-empty', board.items.length === 0);
}

/** Mount everything inside the padded viewport, detach everything outside it. */
export function sync() {
  if (!worldEl) return;
  const r = vp.visibleRect(CULL_MARGIN);
  for (const item of board.items) {
    const half = Math.max(item.w, item.h) / 2 + 2;
    const visible = item.x + half >= r.x0 && item.x - half <= r.x1 &&
                    item.y + half >= r.y0 && item.y - half <= r.y1;
    const el = nodes.get(item.id);
    if (visible) {
      const node = el || build(item);
      if (!node.isConnected) worldEl.append(node);
    } else if (el && el.isConnected) {
      el.remove();
    }
  }
}

/** Force-mount an item regardless of culling (used while dragging). */
export function ensureMounted(id) {
  const item = byId(id);
  if (!item) return null;
  const el = nodes.get(id) || build(item);
  if (!el.isConnected) worldEl.append(el);
  return el;
}

function build(item) {
  const el = document.createElement('div');
  el.className = 'item';
  el.dataset.id = item.id;
  el.dataset.type = item.type;
  el.dataset.fit = fitMode(item.type);
  // Which colour off the sticky pad. CSS picks the tint from this.
  if (item.meta.tint) el.dataset.tint = item.meta.tint;
  // How far off square this one rests, as a fraction of whatever the whimsy
  // axis currently allows (--tilt-max). Presentational, so it stays out of
  // item.rot and the geometry model - see tiltFactor().
  el.style.setProperty('--item-tilt', tiltFactor().toFixed(3));

  const body = document.createElement('div');
  body.className = 'item-body';
  body.append(buildContent(item));
  el.append(body);

  // Inside .item-body, not .item: the body is what clips to the rounded
  // corners now that .item lets the resize handles hang outside it, and a
  // caption plate across the foot has to be clipped by that same curve.
  if (item.name) {
    const label = document.createElement('div');
    label.className = 'item-label';
    label.textContent = item.name;
    body.append(label);
  }

  // Eight handles: four corners, and four edges for resizing one axis alone.
  // The single-letter ones are the edges (see .grip-edge in app.css).
  for (const g of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']) {
    const grip = document.createElement('div');
    grip.className = g.length === 1 ? 'grip grip-edge' : 'grip';
    grip.dataset.g = g;
    el.append(grip);
  }

  nodes.set(item.id, el);
  place(el, item);
  el.classList.toggle('is-selected', selection.has(item.id));
  return el;
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
    tiltBag.push(0, -1, 1);
    // Shuffled, so the straight one is not always in the same position within
    // its three. Dealing them in order would put every third item square, and
    // in a grid arrangement that regularity reads as banding rather than as a
    // hand-pinned board.
    for (let i = tiltBag.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [tiltBag[i], tiltBag[j]] = [tiltBag[j], tiltBag[i]];
    }
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
  body.replaceChildren(buildContent(item));
  const label = el.querySelector('.item-label');
  if (label) label.textContent = item.name;
}

// World y points up, CSS top points down - this negation is the only place the
// two conventions meet on the layout side (viewport.js handles the other half).
// Rotation is negated for the same reason: a positive angle is anticlockwise in
// the world, clockwise in CSS.
function place(el, item) {
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
  el.style.transform = item.rot ? `rotate(${-item.rot}deg)` : '';
  el.style.zIndex = Math.round(item.z);
}

function placeNode(id) {
  const el = nodes.get(id);
  const item = byId(id);
  if (el && item) place(el, item);
}

function paintSelection() {
  for (const [id, el] of nodes) el.classList.toggle('is-selected', selection.has(id));
}

/** Repaint every mounted node from scratch - used after loading a board. */
export function resetItems() {
  for (const el of nodes.values()) el.remove();
  nodes.clear();
  // A new board gets a new pack, so its first three items carry a full set of
  // leans rather than whatever was left over from the last one.
  tiltBag.length = 0;
  reconcile();
  sync();
}
