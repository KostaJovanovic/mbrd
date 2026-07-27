// Mounts board items into #world and keeps their DOM in sync with state.
//
// Culling keeps the DOM proportional to what is on screen rather than to the
// size of the board. A node that scrolls out of view is detached, and then
// either kept or thrown away: kept if its media is mid-playback, so a video
// that leaves and re-enters the viewport carries on where it was, and thrown
// away otherwise, because rebuilding a still card costs a few DOM nodes while
// holding one costs whatever it had decoded. See disposable() and discard().

import {
  board, byId, selection, bus, renameItem, visualStackOrder,
} from '../state.js';
import { shuffle } from '../util.js';
import { itemRadius } from '../geometry.js';
import { buildContent, fitMode } from './renderers.js';
import { releasePlayers } from './audio.js';

/** id -> element, including elements currently detached by culling. */
const nodes = new Map();
/** id -> lightweight geometry twin painted below the complete item stack. */
const shadows = new Map();
let worldEl = null;
let shadowLayerEl = null;
let vp = null;

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

export function initItems(world, viewport) {
  worldEl = world;
  shadowLayerEl = world.querySelector('#item-shadows');
  vp = viewport;
  bus.on('items', () => { reconcile(); sync(); });
  bus.on('geom', ids => { for (const id of ids) placeNode(id); sync(); });
  bus.on('item', id => rebuild(id));
  bus.on('selection', paintSelection);
  // Arrow rather than the function itself: onChange hands its listener the
  // viewport, and sync() reads its argument.
  vp.onChange(() => syncView());
  reconcile();
  sync();
}

export function nodeFor(id) { return nodes.get(id); }

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

/** Drop cached nodes for items that no longer exist. */
function reconcile() {
  const live = new Set(board.items.map(i => i.id));
  for (const [id, el] of nodes) {
    if (live.has(id)) continue;
    discard(el);
    nodes.delete(id);
    shadows.get(id)?.remove();
    shadows.delete(id);
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
 */
const BUILD_BUDGET = 12;

/** Set when a sync ran out of budget, so the next frame knows to carry on. */
let catchUp = 0;

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
  if (syncedRect) {
    const v = vp.visibleRect(0);
    if (v.x0 >= syncedRect.x0 && v.x1 <= syncedRect.x1 &&
        v.y0 >= syncedRect.y0 && v.y1 <= syncedRect.y1) return;
  }
  // No restack: looking around cannot change one item's rank against another, so
  // the whole-board paintStack() the event paths run would be O(n log n) of
  // arithmetic and a zIndex write per mounted node, spent every zoom frame to
  // arrive at the order that is already there. Fresh mounts still get their
  // rank from the cached index below.
  sync(false);
}

/**
 * Mount everything inside the padded viewport, detach everything outside it.
 *
 * `restack` is false on the pure view-change path (see syncView): stacking is a
 * fact about the items, not about where the eye is, so it is recomputed only
 * when an item moves, arrives or leaves - the callers that emit 'items'/'geom' -
 * and left alone on every frame of a pan or zoom.
 */
export function sync(restack = true) {
  if (!worldEl) return;
  const r = vp.visibleRect(cullMargin());
  syncedRect = r;
  let built = 0;
  let owed = false;
  for (const item of board.items) {
    // The circumscribed radius rather than the tight box: it costs no trig,
    // it is right at any rotation, and erring towards mounting something just
    // off screen is free where erring the other way is a visible pop-in.
    const half = itemRadius(item) + 2;
    const visible = item.x + half >= r.x0 && item.x - half <= r.x1 &&
                    item.y + half >= r.y0 && item.y - half <= r.y1;
    const el = nodes.get(item.id);
    if (visible) {
      // Only a *new* node is rationed. Detaching is what the loop below does to
      // everything that left the viewport, and putting one of those back is a
      // single append - so a pan across ground already visited costs nothing
      // and is never deferred.
      if (!el) {
        if (built >= BUILD_BUDGET) { owed = true; continue; }
        built++;
      }
      const node = el || build(item);
      // A node built during a view change carries no restack behind it, so it
      // takes its rank from the last one. Harmless on the restack path too - the
      // paintStack() below overwrites it a moment later with the fresh order.
      if (!el) node.style.zIndex = stackIndex.get(item.id) ?? 0;
      if (!node.isConnected) worldEl.append(node);
      const shadow = shadows.get(item.id);
      if (shadow && !shadow.isConnected) shadowLayerEl.append(shadow);
    } else if (el && el.isConnected) {
      // Off screen. Detached either way; the question is whether the node is
      // kept for its media state or let go of.
      //
      // Keeping every one of them made memory proportional to the board a
      // person had *visited* rather than to what was on screen, which is the
      // opposite of what the culling is for: pan across a thousand photos and
      // all thousand were still held, decoded, for the life of the tab. The
      // cache only ever earned its keep for media that is mid-playback, so
      // that is now all it holds.
      shadows.get(item.id)?.remove();
      if (disposable(el)) {
        discard(el);
        nodes.delete(item.id);
        shadows.delete(item.id);
      } else {
        el.remove();
      }
    }
  }
  if (restack) paintStack();
  // Come back for the rest. One frame at a time and never more than one in
  // flight: another view change between now and then runs its own sync, which
  // is this same pass against a newer rectangle, and two of them queued would
  // build the same cards twice.
  if (owed) {
    if (!catchUp) catchUp = requestAnimationFrame(() => { catchUp = 0; sync(restack); });
  } else if (catchUp) {
    cancelAnimationFrame(catchUp);
    catchUp = 0;
  }
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
  el.dataset.fit = fitMode(item.type);
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
  shadows.set(item.id, buildShadow(item, tilt));
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
 * The strip across the foot of a card: caption on the left, handle on the right.
 *
 * Always built, for every type. Which types show a *caption* is still a
 * question app.css answers - a sticky note has a name nothing draws - and CSS
 * reveals the handle only while this item is selected. Touch also has the
 * long-press route, so hiding the resting handle does not strand its actions.
 */
function bottomBar(item) {
  const bar = document.createElement('div');
  bar.className = 'item-bar';
  bar.append(nameplate(item), menuHandle());
  return bar;
}

/** The three-dot handle. A real <button>, so it is tabbable and not draggable. */
function menuHandle() {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'item-menu';
  btn.setAttribute('aria-label', 'Actions');
  btn.title = 'Actions';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  for (const cy of [4, 8, 12]) {
    const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    dot.setAttribute('cx', '8');
    dot.setAttribute('cy', String(cy));
    dot.setAttribute('r', '1.5');
    dot.setAttribute('fill', 'currentColor');
    svg.append(dot);
  }
  btn.append(svg);
  return btn;
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
  // The bar is a sibling of the body, so replaceChildren above does not touch
  // it - only the caption inside it needs the new name. Patched rather than
  // rebuilt so the handle beside it keeps its identity, and with it any focus
  // the keyboard had put there.
  const label = el.querySelector('.item-bar > .item-label');
  if (label) {
    label.textContent = item.name || '';
    label.hidden = !item.name;
  }
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
  }
}

/** Repaint every mounted node from scratch - used after loading a board. */
export function resetItems() {
  for (const el of nodes.values()) discard(el);
  nodes.clear();
  shadows.clear();
  shadowLayerEl.replaceChildren();
  // A new board gets a new pack, so its first three items carry a full set of
  // leans rather than whatever was left over from the last one.
  tiltBag.length = 0;
  reconcile();
  sync();
}
