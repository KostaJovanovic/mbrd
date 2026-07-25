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

  const body = document.createElement('div');
  body.className = 'item-body';
  body.append(buildContent(item));
  el.append(body);

  if (item.name) {
    const label = document.createElement('div');
    label.className = 'item-label';
    label.textContent = item.name;
    el.append(label);
  }

  for (const g of ['nw', 'ne', 'sw', 'se']) {
    const grip = document.createElement('div');
    grip.className = 'grip';
    grip.dataset.g = g;
    el.append(grip);
  }

  nodes.set(item.id, el);
  place(el, item);
  el.classList.toggle('is-selected', selection.has(item.id));
  return el;
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
  reconcile();
  sync();
}
