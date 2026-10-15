// Mounts board items into #world. Culling keeps the DOM proportional
// to what is on screen, not board size. item-dom.ts builds the tree;
// this owns the node map, culling, pooling, placement and selection.

import {
  board, byId, selection, bus, renameItem, setFontText, visualStackOrder, travelling, isFence,
  rolledAway, rolledFences,
  isFiltered, isPinned, settlesIn, setItemsLocked, startSettling,
} from '../state.ts';
import { quality } from '../quality.ts';
import { caretToEnd, icon, makeEditable, markClosed, readToken, selectContents, toHex } from '../util.ts';
import { copyHex } from '../clipboard.ts';
import { itemRadius, rotatedExtents } from '../geometry.ts';
import type { Bounds } from '../geometry.ts';
import type { Item } from '../board-model.ts';
import { TITLE_ID, shownName } from '../board-model.ts';
import type { Viewport } from './viewport.ts';
import { baseMs, cullMargin, fastMs, reducedMotion } from './viewport.ts';
import {
  buildContent, fontFamilyOf, paintStyleTileFaces, releaseImages, retitleContent,
} from './renderers.ts';
import {
  buildItem, buildRing, buildShadow, buildTitleControls, farKind, itemAccessibleName,
  resetTilt, restingTilt, retilt, setGrips, wantsHead, writeFit, writeAdjust, writeFenceLook, writeNoteTint,
  writeMissing, fillCaption, fitCaption,
} from './item-dom.ts';
import { markLang } from './note-model.ts';
import { POSTER_TIME } from './video.ts';
import { clearDisplay } from './display.ts';
import { releasePlayers } from './audio.ts';
import { flyOut, cancelExit } from './exit-anim.ts';
import { releaseStills } from './stills.ts';
import { releaseTransports } from './transport.ts';
import { releaseModels } from './model.ts';
import * as spatial from './spatial.ts';

// Three pure questions about what a card says, moved down to item-dom.ts but
// re-exported by name since canvas/renderers.ts, ui/ and tests still ask this
// module - an export that stops existing should break loudly, not quietly.
export { farKind, itemAccessibleName, wantsHead };

/** Above this many items in one delete, the fly-out is skipped - a fifty-item
 *  delete shouldn't spawn fifty animating clones; past the cap they just vanish. */
const EXIT_ANIM_CAP = 12;

/** id -> element, including elements currently detached by culling. */
const nodes = new Map<string, HTMLElement>();
/** id -> lightweight geometry twin painted below the complete item stack. */
const shadows = new Map<string, HTMLElement>();
/** id -> selection ring painted above the complete item stack. See paintRing(). */
const rings = new Map<string, HTMLElement>();
// The things initItems() sets, together, once, for the rest of the
// session - hence the `!` on reads below once one of them (e.g. worldEl) has
// already been checked: a state with one set and another not never happens.
// cullMargin() (viewport.ts) is the exception, since it's reachable from a
// repaint scheduled before the wiring, so it guards `vp` where these don't.
let worldEl: HTMLElement | null = null;
let shadowLayerEl: HTMLElement | null = null;
let ringLayerEl: HTMLElement | null = null;
let vp: Viewport | null = null;

/**
 * The set of ids currently carrying the hover lift.
 *
 * The group that lifts is the group travelling([id]) would carry with a drag -
 * a photo's stickies, a fence's cards - so what answers the pointer is the
 * object you'd pick up. travelling() only goes downward (to riders, never a
 * host; to contents, never the fence around them), so a note lifts with its
 * card but not the reverse, and a card inside a region lifts alone.
 *
 * The pointer never reaches a fence's face (items.css refuses events there),
 * so in practice this fires from the name plate: a hand on the label lifts
 * the area it names without moving anything.
 */
let lastHoverId: string | null = null;
let hoverGroup = new Set<string>();
function setHoverLift(id: string, on: boolean) {
  const card = nodes.get(id);
  card?.classList.toggle('is-hover', on);
  // The caption shows on hover, so that is when whether it fits is worth asking.
  if (on && card) fitCaption(card);
  shadows.get(id)?.classList.toggle('is-hover', on);
  // Same frame as the card, so the ring runs the card's transition with it.
  if (ringLayerEl) paintRing(id);
}

/** Most cards a rearrangement slides; past it the board simply changes. */
const SLIDE_CAP = 80;

/**
 * Where the cards that are on screen now stand, for slideFrom() to play from
 * once a rearrangement has moved them. Read before the move. Empty past
 * SLIDE_CAP: a hundred cards crossing each other is noise, not explanation.
 */
export function seenPlaces(ids: readonly string[]): Map<string, { x: number, y: number }> {
  const out = new Map<string, { x: number, y: number }>();
  if (typeof innerWidth !== 'number') return out;
  for (const id of ids) {
    const el = nodes.get(id);
    const item = byId(id);
    if (!el?.isConnected || !item) continue;
    const r = el.getBoundingClientRect();
    if (r.right < 0 || r.bottom < 0 || r.left > innerWidth || r.top > innerHeight) continue;
    out.set(id, { x: item.x, y: item.y });
    if (out.size > SLIDE_CAP) return new Map();
  }
  return out;
}

/**
 * Slide the cards seenPlaces() found from where they were to where the model
 * now has them, so a rearrangement shows where each card went instead of
 * teleporting the board. `transform` only - position is left/top and the
 * lift, lean and grow are the individual properties, so this composes with
 * all of them - on the card and its shadow twin together. The in-and-out
 * curve on-screen movement wants, with a short stagger that never holds
 * anything up: the positions are already committed.
 */
export function slideFrom(was: ReadonlyMap<string, { x: number, y: number }>, ms: number) {
  if (!(ms > 0) || !was.size) return;
  const step = Math.min(30, 240 / was.size);
  let i = 0;
  for (const [id, from] of was) {
    const item = byId(id);
    const el = nodes.get(id);
    if (!item || !el || typeof el.animate !== 'function') continue;
    // World y runs up and the page's runs down - see place().
    const dx = from.x - item.x, dy = item.y - from.y;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
    const opts = { duration: ms, delay: i++ * step, easing: 'cubic-bezier(0.77, 0, 0.175, 1)', fill: 'backwards' as const };
    for (const node of [el, shadows.get(id), rings.get(id)]) {
      // Over the node's own inline transform (the card's rot and device snap),
      // or a turned card would stand up straight for the length of the slide.
      const rest = node?.style.transform || 'none';
      const from = `translate(${dx}px, ${dy}px)${rest === 'none' ? '' : ' ' + rest}`;
      node?.animate([{ transform: from }, { transform: rest }], opts);
    }
  }
}

/**
 * Mark cards as carried, for the length of a drag: the pickup (lift, lean,
 * grow) that items.css and canvas.css style under .is-dragging. Called by
 * canvas/input.ts when a press becomes a move and again when it ends.
 *
 * The end leaves .is-dropping on for one --dur-base: the way down, which a
 * tier can ease differently from the way up (quality.css puts Softish's card
 * straight down rather than through the board and back).
 */
export function setDragging(ids: readonly string[], on: boolean) {
  for (const id of ids) {
    clearTimeout(dropping.get(id));
    dropping.delete(id);
    const els = [nodes.get(id), shadows.get(id)];
    for (const el of els) {
      el?.classList.toggle('is-dragging', on);
      el?.classList.toggle('is-dropping', !on);
    }
    if (on) continue;
    dropping.set(id, setTimeout(() => {
      dropping.delete(id);
      for (const el of els) el?.classList.remove('is-dropping');
      paintRings();
    }, baseMs()));
  }
  paintRings();
}
/** The cards still on their way down from a drag, and the timer that ends it. */
const dropping = new Map<string, ReturnType<typeof setTimeout>>();
/**
 * The card a finger is holding down on, shrinking towards the long-press menu
 * (.item.is-pressing, items.css), or null to let it spring back. One at a
 * time; canvas/input.ts sets it after a moment of stillness and clears it on
 * every path that ends the hold.
 */
let pressingId: string | null = null;
export function setPressing(id: string | null) {
  if (id === pressingId) return;
  for (const was of [pressingId, id]) {
    if (!was) continue;
    const on = was === id;
    nodes.get(was)?.classList.toggle('is-pressing', on);
    shadows.get(was)?.classList.toggle('is-pressing', on);
    if (ringLayerEl) paintRing(was);
  }
  pressingId = id;
}

/**
 * Told which cards the pointer is on, whenever that changes.
 *
 * One subscriber (canvas/web.ts, which lifts a card's connections above the
 * rest of the board). A callback, not a bus event: this fires on pointer
 * moves, and anything every module can hear is something one will eventually
 * answer with a rebuild.
 *
 * The *group*, not the id: a sticky lifts with the card it's pinned to, since
 * a connection is drawn to the photograph, not the note riding on it.
 */
let hoverWatcher: ((group: Set<string>) => void) | null = null;
export function onHoverItem(fn: (group: Set<string>) => void) { hoverWatcher = fn; }

function setHoverGroup(id: string | null) {
  if (id === lastHoverId) return;
  // The pin badge is worked out here, not baked in at build: pinning is a fact
  // about two items that changes without either being rebuilt (host deleted,
  // undo, card dragged out from under a note), so it's asked fresh on the one
  // moment it's visible rather than kept in a class that can go stale.
  //
  // Only on the hovered item, not the group - the lift already says "these move
  // together"; this says "fixed to that one", true only of the pointer's target.
  const was = lastHoverId ? nodes.get(lastHoverId) : undefined;
  if (was) showPin(was, 'is-pinned', false);
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
 * The one timer this feature has, and it is here rather than in sticky.ts
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
function paintPinBadge(id: string | null) {
  // Nothing hovered is a real argument here - setHoverGroup(null) is how a
  // pointer leaving the board arrives - and it used to fall through byId(null)
  // and nodes.get(null), both of which answer nothing. Asked rather than
  // relied on, which is the same two nothings.
  const it = id ? byId(id) : undefined;
  const el = id ? nodes.get(id) : undefined;
  if (el) showPin(el, 'is-pinned', isPinned(it));
  const left = settlesIn(it);
  // +50ms, so the callback lands the far side of the comparison rather than on
  // the exact millisecond it turns over.
  if (left) settleWatch = setTimeout(() => paintPinBadge(id), left + 50);
}

/**
 * Show or hide the pin badge on a card, for one of its two reasons: hovered
 * (`is-pinned`) or selected (`is-pin-sel`). Two classes, so the pointer
 * leaving a selected note does not take its badge away.
 *
 * The badge is a button, built on first need and kept: a press on it lets the
 * note go for a settle window (the click handler in initItems()).
 */
function showPin(el: HTMLElement, why: 'is-pinned' | 'is-pin-sel', on: boolean) {
  el.classList.toggle(why, on);
  if (!on || el.querySelector(':scope > .item-pin')) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'item-badge item-pin';
  btn.setAttribute('aria-label', 'Unpin for ten seconds');
  btn.title = 'Unpin for ten seconds';
  el.append(btn);
}

// cullMargin() and its two constants moved to canvas/viewport.ts, which both
// this module and canvas/web.ts already import - the two copies had drifted.

/**
 * An item's entry in the spatial cull index: a circumscribed square, centre and
 * full size, matching the precise test sync() runs (itemRadius + 2). Registering
 * by the circumscribed radius rather than the tight box is what makes a rotated
 * card index by the corner it actually reaches, so the grid never drops an item
 * the precise test would have kept - see canvas/spatial.ts.
 */
const cullBox = (item: Item) => {
  const r = itemRadius(item) + 2;
  return { id: item.id, x: item.x, y: item.y, w: 2 * r, h: 2 * r };
};

/** What an 'items' announcement carries, and what reconcile() reads too. */
type ItemsDelta = { added?: string[]; removed?: string[] };

/**
 * Bring the spatial cull index up to date with a membership change.
 *
 * A delta names exactly what arrived and left, so the index touches only those;
 * without one - a load, or any emitter that names no change - it rebuilds from
 * the whole board, which is always right if slower. Either way it is off the
 * per-frame path: this runs on 'items' and 'layout', never on a pan or zoom,
 * where the whole point of the index is to avoid walking every item.
 */
function reindex(delta?: ItemsDelta) {
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

export function initItems(world: HTMLElement, viewport: Viewport) {
  worldEl = world;
  shadowLayerEl = world.querySelector('#item-shadows');
  ringLayerEl = world.querySelector('#item-rings');
  vp = viewport;
  // The tour mark's press, delegated once for the whole world rather than bound
  // per node. The marks come and go with the cull and with every edit to the
  // list, and a listener per mark would be one closure per mounted card thrown
  // away on every pan. The id comes off the card the mark is in, which is where
  // itemIdFromEvent() reads it from too.
  world.addEventListener('click', e => {
    const t = e.target instanceof Element ? e.target : null;
    const mark = t?.closest('.tour-mark');
    if (mark) {
      const id = itemIdFromEvent(mark);
      if (id) tourMarks?.press(id);
      return;
    }
    // Unzip on an archive card, Open on a folder card.
    const unpack = t?.closest('.card-unpack');
    if (unpack) {
      const id = itemIdFromEvent(unpack);
      if (id) unpacker?.(id);
      return;
    }
    // Retry on a picture that arrived as a named card.
    const retry = t?.closest('.card-retry');
    if (retry) {
      const id = itemIdFromEvent(retry);
      if (id) retrier?.(id);
      return;
    }
    // The song under a Spotless card.
    const song = t?.closest('.spotless-song');
    if (song) {
      const id = itemIdFromEvent(song);
      if (id) songDealer?.(id);
      return;
    }
    // A style tile's swatch copies its colour as the palette has it now.
    const swatch = t?.closest<HTMLElement>('.style-tile-swatch');
    if (swatch) {
      const hex = swatchHexNow(swatch);
      if (hex) copyHex(hex);
      return;
    }
    // The two corner badges, delegated the same way. Both are buttons, so
    // canvas/input.ts treats a press on one as a widget's and never a drag.
    const badge = t?.closest('.item-badge');
    if (!badge) return;
    const id = itemIdFromEvent(badge);
    if (!id) return;
    // The anchor comes off for good, as the menu's Unanchor does.
    if (badge.classList.contains('item-locked')) { setItemsLocked([id], false); return; }
    // The pin lets go for one settle window: the note moves freely and pins
    // again ten seconds after its last move (sticky.ts).
    startSettling([id]);
    paintPinBadge(id);
    paintGrips();
  });
  // A swatch's hex, written as the pointer or the keyboard arrives rather than
  // when the tile was built, so it is always the palette's current value.
  const showHex = (e: Event) => {
    const swatch = e.target instanceof Element ? e.target.closest<HTMLElement>('.style-tile-swatch') : null;
    const hex = swatch?.querySelector('.style-tile-hex');
    if (swatch && hex) hex.textContent = swatchHexNow(swatch) || '';
  };
  world.addEventListener('pointerover', showHex);
  world.addEventListener('focusin', showHex);
  // A tour mark's number under the pointer, told to the editor, which lights
  // that stop. Every pointerover, so leaving a number says null.
  world.addEventListener('pointerover', e => {
    const mark = e.target instanceof Element ? e.target.closest('.tour-mark:not(.is-add)') : null;
    tourMarks?.hover?.(mark ? itemIdFromEvent(mark) : null);
  });
  // paintGrips() on both, because pinning is a fact about two items and changes
  // without either being rebuilt. 'items' is the host deleted or undone back out
  // of existence, which frees its riders; 'geom' is a drop, a nudge and Unstick,
  // all of which change what a sticky is fixed to without touching the
  // selection. It costs one question per selected id, which is what keeps it
  // affordable on 'geom' - see the docstring.
  bus.on('items', delta => {
    reconcile(delta);
    reindex(delta);
    // No delta is a wholesale change - a load or a Timeline replay.
    if (!delta) redrawChanged();
    sync();
    paintGrips();
    if (delta?.added) enterAdded(delta.added);
  });
  bus.on('geom', ids => {
    for (const id of ids) {
      // The one per-item index write on a hot path: a moved card has to change
      // cells or the next cull would look for it where it no longer is. placeNode
      // already resolved the item (byId is O(1), state.ts), so it is reused here
      // rather than looked up again; a null item just removes it from the index.
      const item = placeNode(id);
      spatial.update(id, item && cullBox(item));
    }
    sync();
    paintGrips();
  });
  bus.on('item', id => rebuild(id));
  // A per-item fit change comes through 'item' (rebuild re-reads fitMode). The
  // board-wide default changes nothing about an item, so it arrives as a plain
  // 'settings' and only the data-fit attribute needs rewriting - no rebuild, no
  // reflow of the media itself. Items with their own meta.fit keep it. The grid
  // too, since the choice only applies on it (fitMode).
  const refit = () => {
    for (const [id, el] of nodes) {
      const item = byId(id);
      if (item && (item.type === 'image' || item.type === 'video')) writeFit(el, item);
    }
  };
  bus.on('settings', key => {
    if (key === 'mediaFit' || key === 'snap') refit();
  });
  // A layout switch brings the other layout's snap with it, unannounced.
  bus.on('layout', refit);
  // A style tile follows the look on its own everywhere it can - its swatches
  // hold `var(--accent)` rather than a colour and re-resolve when the palette
  // moves under them. The two face *names* are the exception, because they are
  // text: nothing repaints a string. So they are rewritten here, on the two
  // announcements that can change which face a token resolves to.
  //
  // No rebuild, for the same reason the fit above is not one: the card is
  // correct apart from two lines of text, and tearing it down would drop the
  // strip's decoded pictures to rewrite them.
  const refreshTiles = () => {
    for (const [id, el] of nodes) {
      if (byId(id)?.type === 'style-tile') paintStyleTileFaces(el);
    }
  };
  bus.on('settings', key => { if (key === 'appearance') refreshTiles(); });
  bus.on('fonts', refreshTiles);
  // A layout-mode switch rewrites every item's geometry through writeLayout()
  // and announces it with 'layout' alone - no 'geom' per id, no 'items'. The old
  // whole-board scan read board.items fresh and never noticed; the index has to
  // be told, or the next cull would hunt the new layout in the old layout's
  // cells. The view change the switch also fires runs its own sync(); this makes
  // sure the index that sync reads is the one the new layout put things in.
  bus.on('layout', () => { reindex(); sync(); });
  bus.on('selection', paintSelection);
  bus.on('filter', paintFilter);
  // A tag written onto a card while a filter is up changes whether that card
  // matches, and the write arrives as 'item'. Repainting the whole set is a
  // class toggle per mounted node and the filter is a menu-speed event, so
  // there is nothing here worth the bookkeeping of a narrower answer.
  bus.on('item', paintFilter);
  // A roll is an 'item' write, and membership changes with arrivals and moves.
  bus.on('item', paintRolled);
  bus.on('items', paintRolled);
  bus.on('geom', paintRolled);
  bus.on('layout', paintRolled);
  // The shadow twin lives in its own layer, so no CSS :hover on the card can
  // reach it. Mirror the hover onto it here: one delegated pair on the world,
  // tracking which item the pointer is over, so the twin lifts with the card
  // instead of being left behind as a second card (see .item-shadow.is-hover).
  world.addEventListener('pointerover', e => {
    // A finger's pointerover is the press itself, not a hover - see flyout.ts's
    // per-event touch rule. Lifting on it read as the card jumping under the finger.
    if (e.pointerType === 'touch') return;
    setHoverGroup(itemIdFromEvent(e.target));
    swellMark(e.target);
  });
  world.addEventListener('pointerout', e => {
    if (!itemIdFromEvent(e.relatedTarget)) setHoverGroup(null);
    swellMark(e.relatedTarget);
  });
  // Arrow rather than the function itself: onChange hands its listener the
  // viewport, and sync() reads its argument.
  //
  // The cull is the zoom-out hot path - visibleRect grows past syncedRect every
  // frame and this falls through to a full sync() - and the main.ts profiler
  // does not wrap it, so its cost was invisible. When mbrd.perf is armed
  // (cullProfile.on), each frame records its own time and whether it ran a full
  // sync; off, it is a single boolean read and the plain call, same as ever.
  //
  // resnap() rides the same listener rather than one of its own: it has to run
  // after syncView(), because a card that has only just been mounted has no
  // snapped transform yet, and it costs a single boolean read on every frame
  // that is not the settling one. See the note above deviceSnap().
  // The rings follow on the settling frame, as the snap does: a selected card
  // that scrolled into view mid-pan gets its ring the moment the view stops.
  vp.onChange(() => {
    if (!vp!.moving) paintRings();
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

export function nodeFor(id: string) { return nodes.get(id); }

/** Every card with a node on the board now, for a change that cannot name what
 *  it will move (undo, redo) to hand seenPlaces(). Bounded by the screen. */
export function mountedIds(): string[] {
  const out: string[] = [];
  for (const [id, el] of nodes) if (el.isConnected) out.push(id);
  return out;
}

/**
 * The item something being dropped would stick to, wearing the selection ring
 * while it is aimed at. Null clears it.
 *
 * One at a time, and the caller clears it when the gesture ends. Written here
 * rather than by each gesture because the mark belongs to a node and this
 * module owns the nodes - and because there are two gestures now: a note or
 * sticker dragged across the board (canvas/input.ts) and a shape dragged out of
 * the sticker window (ui/sticker-window.ts), which cannot see into the other's
 * closure. Two copies of one mark is two chances for one of them to be left on.
 */
let stickTargetId: string | null = null;
export function showStickTarget(host: { id: string } | null | undefined) {
  const id = host?.id ?? null;
  if (id === stickTargetId) return;
  if (stickTargetId) nodes.get(stickTargetId)?.classList.remove('is-stick-target');
  stickTargetId = id;
  if (id) nodes.get(id)?.classList.add('is-stick-target');
}

/** Subscribe to view changes (pan/zoom); returns the unsubscribe. */
export function onViewChange(fn: (vp: Viewport) => void) { return vp?.onChange(fn); }

// ---- the tour mark -------------------------------------------------------
//
// The square in a card's top-right corner while the tour editor is open: the
// stop number the card is at, or a "+" that puts it on the tour. It is the
// Drawn here, not in tour-edit.ts, because a culled card is rebuilt from
// nothing — a mark written from outside vanishes on pan-out and back.
// Injected (not imported) because the editor state is a ui/ fact.

/**
 * What the editor knows and this module has to ask it.
 *
 * `markFor` answers the number the card wears: a positive integer for a card
 * that is at that stop, `0` for a card that is not on the tour (the "+"), and
 * `null` for no mark at all - the editor is shut, or this is furniture, which is
 * the state every card is in for all of an ordinary session.
 */
export type TourMarks = {
  markFor(id: string): number | null,
  press(id: string): void,
  /** The pointer is on this card's number, or on no number at all (null). */
  hover?(id: string | null): void,
};

let tourMarks: TourMarks | null = null;

/**
 * Which cards are wearing a mark, so the common answer costs one Set lookup.
 *
 * applyTourMark() runs from build(), which is the mount pass - the hot path this
 * module's spatial index and build budget both exist for - and for all of an
 * ordinary session the answer there is "no mark, and there was not one before".
 * Without this that answer costs a querySelector against every card built on
 * every pan, to find nothing.
 *
 * An id in here whose node has since been discarded and rebuilt is harmless: the
 * removal below finds nothing and the id leaves the set on the same pass.
 */
const marked = new Set<string>();

let unpacker: ((id: string) => void) | null = null;

/**
 * What Unzip and Open do (import/unpack.ts). Injected, since import/ sits
 * beside canvas/ rather than under it; main.ts wires it. Unwired, the button
 * does nothing.
 */
export function setUnpack(fn: ((id: string) => void) | null) {
  unpacker = fn;
}

let retrier: ((id: string) => void) | null = null;

/** What Retry on a named picture card does (retryPicture() in import/drop.ts).
 *  Injected for the reason setUnpack() is; unwired, the button does nothing. */
export function setRetryPicture(fn: ((id: string) => void) | null) {
  retrier = fn;
}

let songDealer: ((id: string) => void) | null = null;

/** What the Spotless card's song button does (ui/clean/clean.ts). Injected for
 *  the reason setUnpack() is; unwired, the button does nothing. */
export function setSpotlessSong(fn: ((id: string) => void) | null) {
  songDealer = fn;
}

/** Wire the editor up, or `null` to take every mark off. See paintTourMarks(). */
export function setTourMarks(marks: TourMarks | null) {
  tourMarks = marks;
  paintTourMarks();
}

/**
 * Re-ask the question for every mounted card.
 *
 * The push half of the pair: build() covers a card arriving on screen, and this
 * covers the list changing under cards that are already there. Every mounted
 * node rather than a diff - the marks change on a press, not on a frame, and the
 * mounted set is bounded by the screen.
 */
export function paintTourMarks() {
  for (const [id, el] of nodes) applyTourMark(el, id);
}

/**
 * The cards a tour is pointing at, each wearing `is-spot`: the stop on show
 * (ui/tour.ts), or the stop whose chip or number is under the pointer in the
 * editor (ui/tour-edit.ts). What that means is the root class's to say - see
 * item-chrome.css. Handed to the hover watcher as well, so the connections
 * fade round the stop as they do round a hovered card.
 */
let spot: Set<string> | null = null;
export function setSpot(ids: Iterable<string> | null) {
  spot = ids ? new Set(ids) : null;
  // The twins too, since the peek fades whatever is not lit and a shadow or
  // ring left at full strength reads as a slab where the card was.
  for (const [id, el] of nodes) {
    const on = !!spot?.has(id);
    el.classList.toggle('is-spot', on);
    shadows.get(id)?.classList.toggle('is-spot', on);
  }
  paintRings();
  hoverWatcher?.(spot ?? hoverGroup);
}

/** One card's mark, put on, changed or taken off. */
function applyTourMark(el: HTMLElement, id: string) {
  const n = tourMarks ? tourMarks.markFor(id) : null;
  if (n === null) {
    if (!marked.has(id)) return;
    el.querySelector(':scope > .tour-mark')?.remove();
    marked.delete(id);
    return;
  }
  const had = el.querySelector<HTMLButtonElement>(':scope > .tour-mark');
  const mark = had ?? document.createElement('button');
  if (!had) {
    // A real <button>, and that is load-bearing twice over. canvas/input.ts
    // treats `button` as a widget that owns its own press (see pressIntent), so
    // pressing this selects the card and never drags it - without which the
    // mark would be a target you could only hit by not moving a pixel. And it
    // is the only thing here a keyboard can reach.
    mark.type = 'button';
    mark.className = 'tour-mark';
    // Two glyphs, built once and swapped by CSS: the stop number at rest and a
    // cross under the pointer. A number is not a button - it reads as a label,
    // and the first version of this had no visible way to take a card back off
    // the tour at all, because the only one was the number nobody would think
    // to press. The cross is the removable-chip idiom and says so in one hover.
    // Both live in the DOM from the start rather than being written on hover,
    // so nothing under the pointer is replaced between a press and its click.
    const num = document.createElement('span');
    num.className = 'tour-mark-n';
    mark.append(num);
    mark.append(icon('i-close', 'tour-mark-x'));
    el.append(mark);
  }
  marked.add(id);
  mark.classList.toggle('is-add', n === 0);
  // Non-null: the branch above appends it to every mark this function makes,
  // and a `.tour-mark` in a card is one it made.
  const num = mark.querySelector('.tour-mark-n')!;
  const text = n === 0 ? '+' : String(n);
  // Only when it has actually changed. This runs for every mounted card on every
  // selection, every edit and every card built by a pan, and the overwhelming
  // majority of those are the same number written again.
  if (num.textContent !== text) num.textContent = text;
  mark.title = n === 0 ? 'Put this card on the tour' : `Stop ${n} - press to take it off`;
  mark.setAttribute('aria-label', mark.title);
}

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
export function screenBoxOf(item: Item | null | undefined) {
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
 * Owned here rather than in ui/toolbar.ts, which is what actually decides it,
 * because a mark on a card has to survive the card being culled and rebuilt -
 * see the note in build(). ui/ hands the id down; this layer keeps it true.
 */
let pickedId: string | null = null;

export function setConnectPick(id: string | null | undefined) {
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
let aimedId: string | null = null;

export function setConnectAim(id: string | null | undefined) {
  if (aimedId === id) return;
  if (aimedId) nodeFor(aimedId)?.removeAttribute('data-aim');
  aimedId = id || null;
  if (aimedId) nodeFor(aimedId)?.setAttribute('data-aim', '');
}

/**
 * The cards a hovered card's lines actually involve - it, their far ends, and
 * whatever is stuck to any of them. Everything else on the paper steps back.
 *
 * The threads already do this among themselves: hovering a card drops every line
 * that is not its own, and the cards behind them carried on at full strength -
 * so a picture that was meant to say "this and these three" was three lit lines
 * over forty photographs. The board is the loudest thing on the board.
 *
 * A gentle step rather than the threads' 0.18. A line at 0.18 is a hairline
 * going quiet; a photograph at 0.18 is gone, and the board would flicker between
 * two documents as the pointer crossed it. Enough to separate, not enough to
 * hide - the number and the argument are in items.css.
 *
 * Written as one class on the root and an attribute on the few that stay,
 * rather than a class on every card that goes. paintFilter() takes the other
 * shape and is right to: a filter changes when somebody ticks a tag, where this
 * changes every time the pointer crosses a card, and a loop over every mounted
 * node at that rate is the cost this avoids. What the browser has to
 * re-evaluate is the same either way; what it is handed is two writes rather
 * than two hundred.
 *
 * The twins in #item-shadows get the same attribute, because a dimmed card with
 * a full-strength shadow under it is a card floating over its own outline.
 */
let liftedIds: Set<string> = new Set();

export function setBoardLift(ids: Set<string> | null | undefined): void {
  const next = ids?.size ? ids : null;
  if (liftedIds.size === (next?.size || 0)) {
    let same = true;
    if (next) for (const id of next) if (!liftedIds.has(id)) { same = false; break; }
    if (same) return;
  }
  for (const id of liftedIds) {
    if (next?.has(id)) continue;
    nodeFor(id)?.removeAttribute('data-lit');
    shadows.get(id)?.removeAttribute('data-lit');
  }
  if (next) {
    for (const id of next) {
      if (liftedIds.has(id)) continue;
      nodeFor(id)?.setAttribute('data-lit', '');
      shadows.get(id)?.setAttribute('data-lit', '');
    }
  }
  liftedIds = next ? new Set(next) : new Set();
  document.documentElement.classList.toggle('board-lifted', !!next);
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
 * canvas/web.ts asks for every connected card on every frame of a drag, and a
 * getComputedStyle there would be a style flush per card per frame.
 *
 * 0 for a card with no node - one that is culled is off screen, and a lean
 * nobody can see does not change where a line should stop.
 */
export function tiltOf(id: string) {
  const el = nodeFor(id);
  if (!el) return 0;
  return parseFloat(el.style.getPropertyValue('--item-tilt')) || 0;
}

/** A style tile swatch's colour as `#rrggbb`, read off its token now. */
const swatchHexNow = (swatch: HTMLElement) => toHex(readToken(swatch.dataset.token || ''));

/** The item id owning a DOM node, or null for canvas chrome. */
export function itemIdFromEvent(target: EventTarget | null): string | null {
  const el = target instanceof Element ? target.closest<HTMLElement>('.item') : null;
  // `?? null` covers a .item with no data-id, which cannot happen - buildItem()
  // is the only thing that makes one and it writes the id - and which the type
  // of dataset has no way of knowing cannot happen.
  return el ? el.dataset.id ?? null : null;
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
function discard(el: HTMLElement) {
  // Focus out first. A card being written in loses focus as it leaves, and the
  // blur can take the node out itself, so the removal after it threw - and one
  // throw in resetItems() left the rest of the old board's cards on screen.
  // Taken out already, remove() does nothing.
  const focused = document.activeElement;
  if (focused instanceof HTMLElement && el.contains(focused)) focused.blur();
  // Released while still in the document, then removed. The other way round,
  // Chromium never frees an <img> whose src was taken off after it left: every
  // culled card stayed alive, and a Galaxy S22+ panning one board kept 600 more
  // per few seconds of it (2026-09-23). rebuild() and the drawer already did it
  // in this order.
  releaseCardContent(el);
  el.remove();
  discardProbe?.(el);
}

/**
 * Told of every card thrown away, for the benchmark's leak check
 * (perf/bench.ts), which registers each with a FinalizationRegistry and counts
 * how many the collector has since taken. Unset, discard() pays one null test.
 */
let discardProbe: ((el: HTMLElement) => void) | null = null;
export function setDiscardProbe(fn: ((el: HTMLElement) => void) | null) {
  discardProbe = fn;
}

/**
 * Everything a card's *contents* hold on to, handed back.
 *
 * Its own function because callers throw content away and only one of them
 * was doing this. discard() is the obvious one; rebuild() is the other, and it
 * replaces a card's whole body on a rename, a Fit toggle, a crop, an adjust or
 * a cover change - every one of which arrives as an 'item' emit. It called
 * releasePlayers() and nothing else, so the old `<img>` was dropped by
 * replaceChildren() with its `src` intact and a 4000x3000 photograph's ~48 MB
 * decode lived until the next GC, once per rename; a `<video>` was paused and
 * kept its source and therefore its decoder.
 *
 * The argument for every line of it is discard()'s own: the element frees what
 * it has buffered when its source goes, not when the last reference to it does.
 *
 * Exported for the third caller, which is not on the canvas at all: ui/drawer.ts
 * mounts real cards on its shelves and lets them go again as they scroll out of
 * the window, and that is the same act as culling one off the board. The whole
 * point of exporting it rather than letting that module write its own four lines
 * is that there is one answer to "what does a card hold on to" - the day a
 * renderer starts holding something new, it is added here and every surface that
 * mounts a card gets the release for free.
 */
export function releaseCardContent(el: Element) {
  releasePlayers(el);
  for (const m of el.querySelectorAll<HTMLMediaElement>('video, audio')) {
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
  releaseImages(el);
  // And the frozen-GIF frames, which are object URLs this app made rather than
  // ones the asset store owns. Clearing the src above drops the *reference*;
  // the blob stays in the document's URL store until it is revoked by name. See
  // releaseStills().
  releaseStills(el);
  // And the transports' selection subscriptions, which unsubscribe themselves
  // only when the selection next changes - so a board panned past and then left
  // alone kept one live closure per audio card. See releaseTransports().
  releaseTransports(el);
  // And the model stages' size observers, whose callback closes over a parsed
  // mesh. See releaseModels().
  releaseModels(el);
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
function disposable(el: HTMLElement) {
  for (const m of el.querySelectorAll<HTMLMediaElement>('video, audio')) {
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
 * ui/nowplaying.ts can offer to control something you cannot see.
 *
 * One node, in practice. registerPlayer()'s one-clip-at-a-time rule means there
 * is only ever one thing playing on a board, so this exempts exactly one card
 * from the cull - and it is off screen, so it is a card's worth of style and
 * layout with nothing to paint.
 *
 * An embedded player counts too. Its `paused` cannot be read across origins,
 * and taking an iframe out of the document destroys it, so a detach stopped
 * the song and a pan back loaded the player again from the start. It only
 * exists because somebody pressed Watch, so these are few.
 *
 * rebuild() asks the same question of a card's body: what this protects from a
 * detach, it protects from a body replaced under it.
 */
function sounding(el: Element) {
  for (const m of el.querySelectorAll<HTMLMediaElement>('video, audio')) {
    if (!m.paused) return true;
  }
  return !!el.querySelector('iframe');
}

/** Let go of one item's node and shadow, mounted or merely cached. */
function dropNode(id: string, el = nodes.get(id)) {
  if (!el) return;
  discard(el);
  nodes.delete(id);
  shadows.get(id)?.remove();
  shadows.delete(id);
  paintRing(id);
}

/**
 * Drop cached nodes for items that are gone.
 *
 * A delta names the removed ids, so only their nodes are discarded - the common
 * case, an add or a delete of a handful, no longer walks the whole cache. Without
 * a delta (a load, or an emitter that names no change) it falls back to the diff
 * against the live board, which needs no payload to be correct.
 */
function reconcile(delta?: ItemsDelta) {
  // A card back inside its own exit (an undo straight after a delete) takes
  // its ghost with it, or the ghost falls on top of it.
  for (const id of delta?.added || []) cancelExit(id);
  if (delta && delta.removed) {
    // A user delete (or redo of one) is the only path that names removed ids;
    // a load or clear reconciles by diff and reaches the else branch, so a
    // board swap never animates. Animate before dropNode discards the node -
    // flyOut clones it, so the snapshot survives the discard on the next line.
    if (delta.removed.length <= EXIT_ANIM_CAP) {
      for (const id of delta.removed) { const el = nodes.get(id); if (el) flyOut(el, vp?.zoom); }
    }
    for (const id of delta.removed) dropNode(id);
  } else {
    const live = new Set(board.items.map(i => i.id));
    for (const [id, el] of nodes) if (!live.has(id)) dropNode(id, el);
  }
  // Non-null: every caller of this is either initItems(), which set it two lines
  // earlier, or a path that runs after it. See the note on the declaration.
  worldEl!.classList.toggle('is-empty', board.items.length === 0);
}

/**
 * The mirror of the exit: cards that have just arrived (paste, duplicate, a
 * drop, an undone delete) grow in rather than appearing in one frame, where a
 * pasted card under the pointer is easy to miss.
 *
 * Only for a delta's `added`, so a load or a Timeline replay (no delta) and a
 * card the cull mounts never play it. On screen only, and not at all past
 * EXIT_ANIM_CAP, with Quality's motion off, or when --dur-fast is 0. The
 * keyframe has no end, so it settles on whatever the node is styled to be
 * (the hover grow, a filter's fade), and `scale` is the individual property, so
 * the rot and device snap on `transform` stand untouched.
 */
function enterAdded(ids: readonly string[]) {
  if (!quality.anim || ids.length > EXIT_ANIM_CAP || typeof innerWidth !== 'number') return;
  const ms = fastMs();
  if (!(ms > 0)) return;
  const opts = { duration: ms, easing: readToken('--ease') || 'ease-out' };
  // Reduced motion keeps the fade and drops the growth, as fastMs() is meant.
  const from = reducedMotion() ? { opacity: 0, offset: 0 } : { opacity: 0, scale: '0.94', offset: 0 };
  for (const id of ids) {
    const el = nodes.get(id);
    if (el?.parentElement !== worldEl || typeof el.animate !== 'function') continue;
    const r = el.getBoundingClientRect();
    if (r.right < 0 || r.bottom < 0 || r.left > innerWidth || r.top > innerHeight) continue;
    for (const node of [el, shadows.get(id), rings.get(id)]) {
      node?.animate([from], opts);
    }
  }
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
 * See BUILD_STEPS in quality.ts.
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
let syncedRect: Bounds | null = null;

/** The view moved. Re-mount only if the screen has left what we last covered. */
function syncView() {
  if (!worldEl) return;
  // `vp!` three times below: worldEl is set, so the viewport is too - see the
  // note on the declarations.
  // The exception to the containment guard: the view has stopped and the
  // throttle below owes a detach. Nothing has moved, so the guard would send
  // this frame away - and the settling frame is the last one that will be
  // offered until somebody touches the board again.
  const collecting = detachOwed && !vp!.moving;
  if (syncedRect && !collecting) {
    const v = vp!.visibleRect(0);
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
  // `vp!` and `shadowLayerEl!` below: worldEl is set, so both of those are - see
  // the note on the declarations.
  const r = vp!.visibleRect(cullMargin(vp));
  syncedRect = r;
  let built = 0;
  let owed = false;
  // Which items are on screen this pass. Filled by the mount loop and read by
  // the detach loop; the two used to be one loop over the whole board, and
  // splitting them is the point of the spatial index - the mount loop now visits
  // only what is near the viewport, and the detach loop only what is mounted.
  const onScreen = new Set<string>();
  // Mount pass. queryRect() narrows the field from the whole board to the cells
  // the padded viewport touches; the precise test below is the same one the old
  // whole-board scan ran, now paid only for that handful of candidates.
  for (const id of spatial.queryRect(r)) {
    const item = byId(id);
    if (!item) continue;
    // The title card is not culled with the rest - it is handled once, below,
    // so it stays mounted off-screen (ui/mobile-header.ts must always find its
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
    // String() for the reason place() gives: a zIndex is written as one either
    // way, and this is the way that says so.
    if (!el) node.style.zIndex = String(stackIndex.get(id) ?? 0);
    if (!node.isConnected) worldEl.append(node);
    const shadow = shadows.get(id);
    if (shadow && !shadow.isConnected) shadowLayerEl!.append(shadow);
  }
  // The title card, kept mounted whatever the pan so its style always has a node
  // to land on. Desktop only: on Mobile it is left out of onScreen, so the
  // detach pass below unmounts it (the masthead is Mobile's title instead).
  if (board.layoutMode !== 'mobile') {
    // byId(), not a scan. This runs on every full sync - every frame of a
    // zoom-out - and `find` walked the whole board to reach a card whose id is
    // a constant: three thousand items visited per view frame, on the one path
    // whose stated point is that the mount loop above visits only what is near
    // the viewport. The title card is a singleton with a fixed id (TITLE_ID),
    // which is what makes the index the right question; the type test stays as
    // the check that the thing under that id is still what this expects.
    const found = byId(TITLE_ID);
    const title = found?.type === 'title' ? found : null;
    if (title) {
      onScreen.add(title.id);
      const node = nodes.get(title.id) || build(title);
      if (!node.isConnected) worldEl.append(node);
      const shadow = shadows.get(title.id);
      if (shadow && !shadow.isConnected) shadowLayerEl!.append(shadow);
    }
  }
  // Detach pass. Walk what is mounted - bounded by the screen, not the board -
  // and let go of everything no longer on it. Three answers, not two: thrown
  // away, detached and kept for its media state, or - for the one clip actually
  // playing, and any embedded player - left where it is, because detaching it
  // would stop it. See sounding().
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
      // A card that has been lifted out of the world layer is somebody else's
      // for the moment, and culling has no business touching it. The note
      // composer moves the live .item into #compose-mount, where it is still
      // isConnected and is nowhere near the padded rect - so any sync while the
      // dialog was up discarded it and dropped it from the node map: the sheet
      // blanked mid-edit, and on close the card was appended back into #world as
      // an orphan the map no longer knew about, so the next sync built a second
      // card for the same item. resnap() guards on exactly this test.
      if (el.parentElement !== worldEl) continue;
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
 * the thing the main.ts grid profiler never saw. Off by default - the listener
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
export function ensureMounted(id: string) {
  const item = byId(id);
  if (!item) return null;
  const el = nodes.get(id) || build(item);
  // Both non-null: there is an item to mount, so a board is open, so initItems()
  // has run - see the note on the declarations.
  if (!el.isConnected) worldEl!.append(el);
  const shadow = shadows.get(id);
  if (shadow && !shadow.isConnected) shadowLayerEl!.append(shadow);
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
 * units - the same reading canvas/notes.ts takes for a note's text.
 *
 * Mounted first, since a plate that is not in the document has no height and
 * "not on screen" is not an answer to this question.
 *
 * The caller is the region-closing half of rearrange(): a fence's plate sits
 * across the top of its box, so a layout packed to the box's top edge puts its
 * first row *under the name*. This is how much room to leave it.
 */
export function barHeight(id: string) {
  // No page to measure in a test with no browser: no plate.
  if (typeof document === 'undefined') return 0;
  const el = ensureMounted(id);
  const bar = el?.querySelector<HTMLElement>(':scope > .item-bar');
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
 * this module rather than in ui/toolbar.ts precisely because of this function: a
 * card that is culled while it is picked is thrown away and rebuilt from nothing
 * when it comes back on screen, so a mark applied only to the live node would
 * quietly disappear the moment somebody panned away from it and back.
 */
function build(item: Item) {
  const tilt = restingTilt(item);
  const el = buildItem(item, tilt, item.id === pickedId);

  nodes.set(item.id, el);
  drawnFrom.set(el, item);
  drawnSource.set(el, sourceOf(item));
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
  if (quality.shadows && !noTwin(item)) {
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
  // Grips on the same terms paintGrips() sets them: selected, and not pinned to
  // something. A card culled while selected is rebuilt from nothing when it
  // comes back on screen, so the question has to be asked here too or a pinned
  // sticker would collect handles by being panned away from and back.
  if (selection.has(item.id)) {
    el.classList.add('is-selected');
    setGrips(el, !isPinned(item));
  }
  // Written at build for the reason the connector's pick is: a card culled while
  // a filter is up is thrown away and rebuilt from nothing when it comes back on
  // screen, so a class applied only by the repaint pass would come off every
  // card somebody panned away from and back.
  if (isFiltered(item)) {
    el.classList.add('is-filtered');
    shadows.get(item.id)?.classList.add('is-filtered');
  }
  // Folded away in a rolled-up fence, for the same reason: a card panned back
  // on screen while its fence is rolled must come back hidden.
  if (rolledAway(item, rolledNow)) {
    el.classList.add('is-rolled-away');
    shadows.get(item.id)?.classList.add('is-rolled-away');
  }
  // Left out of the cleaning game, for the same reason again.
  if (cleanOut(item.id)) {
    el.classList.add('is-clean-out');
    shadows.get(item.id)?.classList.add('is-clean-out');
  }
  // And the tour mark, for the third time in the same words - see the block
  // above applyTourMark(). A card panned off screen and back is a new node, and
  // the editor is a mode somebody spends minutes in doing exactly that.
  applyTourMark(el, item.id);
  if (spot?.has(item.id)) {
    el.classList.add('is-spot');
    shadows.get(item.id)?.classList.add('is-spot');
  }
  return el;
}

/**
 * The types that get no geometry twin in #item-shadows.
 *
 * Every one of them for the same underlying reason: the twin is a rounded
 * rectangle at the item box, so it is only ever right for a type whose
 * silhouette *is* that box. Where it is not, the twin lays a card's shadow
 * under something that is not a card. The first four are argued one by one at
 * the call site, which is where the shadow is decided; this is only the list.
 * Archives and folders are drawn as folders, tab and all, and cast their own
 * drop-shadow in cards.css.
 */
const NO_TWIN = new Set(['title', 'ghost', 'fence', 'sticker', 'archive', 'folder', 'drawing']);

/**
 * The same question, asked of an item rather than of a type.
 *
 * A cut-out is the fifth case and the first that is not a type: an image with
 * `meta.bare` has had its card taken away precisely because its silhouette is
 * not the box, which is word for word the reason the four above are on the list.
 * Leaving it out would hang a rectangular shadow under a picture with no
 * rectangle, which is the same fault the flag exists to fix and more obvious,
 * because a shadow reads as a surface.
 *
 * A sticky at low opacity is the sixth. The twin is a separate element at full
 * strength, so under see-through paper it shows through as a grey block.
 */
function noTwin(item: Item): boolean {
  return NO_TWIN.has(item.type) || item.meta?.bare === true
    || (item.type === 'note' && item.meta?.faded === true);
}

/**
 * Bring an existing card's twin into line with what noTwin() now says.
 *
 * build() asks the question once, when the card is made, and for the four
 * *types* on the list that is the only time it can change - nothing turns a
 * sticker into a photograph. `meta.bare` is the fifth case and the one that
 * moves: it is toggled from the menu on a card that has been on the board for
 * as long as you like, arrives as an ordinary 'item' event, and rebuild() was
 * patching the card and leaving the shadow layer exactly as it found it.
 *
 * So taking the card off left the rectangular twin lying under a thing with no
 * rectangle - which is word for word the fault the flag exists to fix, and it
 * shipped that way because a cut-out photograph mostly covers its own shadow.
 * An emptied sticky does not cover anything, so what you get is a shadow with
 * nothing casting it.
 *
 * Both directions. Putting the card back has to hand the shadow back with it,
 * or "No card" would be a one-way door for everything but the paint.
 *
 * The tilt is read off the card rather than dealt again, and that is the whole
 * reason this takes the node: tiltFactor() deals a fresh angle per call, so a
 * recomputed one would stand the shadow at a different lean from the card it is
 * under. See the note on build(), which deals it once for exactly this reason.
 */
function syncTwin(el: HTMLElement, item: Item) {
  const had = shadows.get(item.id);
  const wants = quality.shadows && !noTwin(item);
  if (had && !wants) {
    had.remove();
    shadows.delete(item.id);
    return;
  }
  if (had || !wants) return;
  const twin = buildShadow(item, el.style.getPropertyValue('--item-tilt'));
  placeBox(twin, item);
  shadows.set(item.id, twin);
  // Mounted here rather than left to the render pass that appends any twin it
  // finds unconnected: that pass runs on the next frame, and a card whose
  // shadow arrives a frame late is a card that flickers flat and then settles.
  if (shadowLayerEl && !twin.isConnected) shadowLayerEl.append(twin);
}

/**
 * The item each card was last drawn from, by node.
 *
 * A Timeline replay puts back a whole board of new item objects and announces
 * it as 'items' with no delta. That reconciles the cards that went and places
 * the rest, but it rebuilds none of them, so a card kept the look it had: a note
 * stayed faded after its fade was stepped back. redrawChanged() compares each
 * card with the item it came from and rebuilds the ones that differ.
 */
const drawnFrom = new WeakMap<HTMLElement, Item>();

/**
 * What a card's body plays, by node: the asset and a player's address. The
 * item is changed in place, so this is the one record of what was built.
 */
const drawnSource = new WeakMap<HTMLElement, string>();
export const sourceOf = (item: Pick<Item, 'asset' | 'meta'>) =>
  `${item.asset?.hash ?? ''}\n${typeof item.meta?.url === 'string' ? item.meta.url : ''}`;

/** The parts of an item a card draws. Geometry is placeNode()'s. By value,
 *  since a replay hands back copies and every card with a file was rebuilt. */
export const sameFace = (a: Item, b: Item) => a.type === b.type && a.name === b.name
  && JSON.stringify(a.asset ?? null) === JSON.stringify(b.asset ?? null)
  && JSON.stringify(a.meta ?? null) === JSON.stringify(b.meta ?? null);

/** Rebuild every card whose item is a new object with a different face. */
function redrawChanged() {
  for (const [id, el] of nodes) {
    const was = drawnFrom.get(el);
    const now = byId(id);
    if (!now || now === was) continue;
    if (was && sameFace(was, now)) drawnFrom.set(el, now);
    else rebuild(id);
  }
}

/** Rebuild one item's content in place (note edits, renames). */
function rebuild(id: string) {
  const el = nodes.get(id);
  const item = byId(id);
  if (!el || !item) return;
  drawnFrom.set(el, item);
  // Non-null: buildItem() appends the body to every card it makes, and a node in
  // this map is a card it made. The two below are the same argument - farHead()
  // appends both of its lines before it returns the head they are in.
  const body = el.querySelector('.item-body')!;
  // A playing clip or an open player keeps its body unless what it plays has
  // changed: a rename, a tag or a backfilled poster stopped the sound, and a
  // fetched title swapped the player back for its offer. See sounding().
  if (sounding(body) && drawnSource.get(el) === sourceOf(item)) {
    retitleContent(body, item);
  } else {
    // The old content is being thrown away, not detached, so it has to be let
    // go of properly first - replaceChildren would otherwise leave the card's
    // former <audio> registered under the volume control and holding its
    // stream, once per rename, and its <img> holding a full-resolution decode.
    // The same teardown discard() does: the same act on a smaller scale.
    releaseCardContent(body);
    body.replaceChildren(buildContent(item));
    drawnSource.set(el, sourceOf(item));
  }
  // data-fit lives on the outer .item and is otherwise only written in build(),
  // so a per-item fit change (which arrives as 'item' → rebuild) would rebuild
  // the picture but leave the old object-fit. Re-read it here.
  writeFit(el, item);
  // And the lock and the adjustments, on the same outer element and for exactly
  // the same reason: locking a card, or moving a brightness dial, arrives as an
  // 'item' event and lands here.
  writeAdjust(el, item);
  // And a fence's colour and roll, which its menu changes the same way.
  if (isFence(item)) writeFenceLook(el, item);
  // And a note's sheet, which its menu's Colour row changes.
  if (item.type === 'note') writeNoteTint(el, item);
  writeMissing(el, item);
  // And the shadow twin, which is not on this element at all - see syncTwin(),
  // and the reason a question build() asks once has to be asked again here.
  syncTwin(el, item);
  // And the ring, which reads the lock and the roll written just above.
  paintRing(id);
  // The bar is a sibling of the body, so replaceChildren above does not touch
  // it - only the caption inside it needs the new name. Patched rather than
  // rebuilt so the handle beside it keeps its identity, and with it any focus
  // the keyboard had put there.
  const label = el.querySelector<HTMLElement>('.item-bar > .item-label');
  if (label) fillCaption(label, item);
  // The headline is the same string on the same schedule, and it is a sibling
  // too. A note is why this cannot be skipped as "renames only": a note's name
  // is its first line, rewritten on every edit, and an edit arrives here as an
  // ordinary re-render.
  const head = el.querySelector<HTMLElement>(':scope > .far-head');
  if (head) {
    const line = head.querySelector<HTMLElement>('.fh-name')!;
    line.textContent = shownName(item);
    markLang(line, line.textContent);
    // The kind follows a rename too: the extension is read off item.name, so
    // renaming "sketch.png" to "sketch" changes what this card calls itself.
    head.querySelector('.fh-kind')!.textContent = farKind(item);
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
export const canRenameItem = (id: string) => {
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
 * see canvas/notes.ts, which this follows.
 *
 * A card line normally shows the stem alone (renderers.ts runs it through
 * baseName), but an edit puts the whole filename back on screen for as long as
 * it lasts. What gets committed is the item's name in full, and hiding half of
 * a string while someone edits it is how a .jpg goes missing without anyone
 * being told.
 */
export function editItemName(id: string) {
  // Bound in two steps, here and at `field` below, so that finish() sees the
  // narrowing: a function *declaration* is hoisted above the checks, so what it
  // closes over is the unchecked binding however early the check runs. The
  // second const is checked by construction and is what the closure reads.
  const named = byId(id);
  if (!named || !canRenameItem(id)) return;
  const item = named;
  const el = ensureMounted(id);
  const body = el?.querySelector('.item-body');
  if (!body) return;

  // `el!` here and below: ensureMounted() answers null only for an id with no
  // item, and there is one - it was read two lines up. A body found through
  // `el?.` is the same fact said again.
  const shown = el!.querySelector<HTMLElement>('.card-name')
    || el!.querySelector<HTMLElement>('.item-label');
  if (!shown) return;
  const field = shown;
  // A picture that has lost its name still has its caption element - the bar
  // always builds one - but it is hidden, and typing into a hidden element is
  // typing into nothing. Shown for the length of the edit, and hidden again
  // below if nothing came of it.
  const wasHidden = field.hidden;
  field.hidden = false;

  el!.classList.add('is-editing');
  makeEditable(field);
  field.textContent = item.name;

  let done = false;
  let keep = true;

  const onKey = (e: KeyboardEvent) => {
    e.stopPropagation();          // the canvas must not see Delete, space or Escape
    if (e.key === 'Enter') { e.preventDefault(); finish(); }
    else if (e.key === 'Escape') { keep = false; markClosed(e); finish(); }
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
    el!.classList.remove('is-editing');
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
  selectContents(field);
}

/**
 * Edit a font card's specimen text - the same inline editor the title card uses
 * (ui/board-title.ts editBoardName), pointed at the card's own words.
 *
 * The specimen is SVG text fitted to the box, which cannot be typed into, so for
 * the length of the edit it is swapped for a plain editable line; rebuild() puts
 * the fitted mark back afterwards, changed or not. Empty commits a cleared key -
 * setFontText() drops meta.text on all-whitespace, so the specimen falls back to
 * the face's own name.
 */
export function editFontText(id: string) {
  const found = byId(id);
  if (!found || found.type !== 'font') return;
  const item = found;
  const mounted = ensureMounted(id);
  if (!mounted) return;
  // Checked by construction, so the handlers below read a non-null host - the
  // same reason editBoardName() binds a second const past its own null check.
  const host = mounted;
  const box = host.querySelector<HTMLElement>('.font-specimen');
  if (!box) return;

  const custom = typeof item.meta?.text === 'string' ? item.meta.text : '';
  const field = document.createElement('div');
  field.className = 'font-edit';
  makeEditable(field);
  // Seed with the words on the card now - the custom text, or the face's name
  // when there is none - so a first keystroke replaces what the reader sees.
  field.textContent = custom || fontFamilyOf(item);
  box.replaceChildren(field);
  host.classList.add('is-editing');

  let done = false;
  let keep = true;

  const onKey = (e: KeyboardEvent) => {
    e.stopPropagation();          // the canvas must not see Delete, space or Escape
    if (e.key === 'Enter') { e.preventDefault(); finish(); }
    else if (e.key === 'Escape') { keep = false; markClosed(e); finish(); }
  };

  // One line: a pasted newline is folded to a space rather than growing the
  // field, the same shape the board-name editor keeps. The caret jumped to the
  // front when textContent was rewritten, so it is put back at the end.
  const onInput = () => {
    const clean = (field.textContent || '').replace(/[\r\n]+/g, ' ');
    if (clean === field.textContent) return;
    field.textContent = clean;
    caretToEnd(field);
  };

  function finish() {
    if (done) return;
    done = true;
    // Read before teardown: innerText is what the field renders. setFontText()
    // trims and drops an empty value.
    const typed = field.innerText.replace(/\s+/g, ' ').trim();
    field.removeEventListener('keydown', onKey);
    field.removeEventListener('input', onInput);
    field.removeEventListener('blur', finish);
    offRebuild?.();
    offRebuild = null;
    host.classList.remove('is-editing');
    if (keep) setFontText(id, typed);
    // Restore the fitted specimen from state. A real change already rebuilt via
    // setFontText's 'item'; this covers Escape and an unchanged commit, and a
    // second rebuild of one small card is cheap.
    rebuild(id);
  }

  field.addEventListener('keydown', onKey);
  field.addEventListener('input', onInput);
  field.addEventListener('blur', finish);
  // The card is culled and rebuilt on any 'items' emit; a rebuilt card is a new
  // node, so the field would vanish and finish() never run. Commit what was
  // typed - the same guard the title editor keeps.
  let offRebuild: (() => void) | null = bus.on('items', () => {
    if (!done && !field.isConnected) finish();
  });
  // Next frame, not now: the double-click that opens this is still settling, and
  // focusing inside it now would be blurred by the click that follows.
  requestAnimationFrame(() => {
    if (done) return;
    field.focus();
    selectContents(field);
  });
}

// World y points up, CSS top points down - this negation is the only place the
// two conventions meet on the layout side (viewport.ts handles the other half).
// Rotation is negated for the same reason: a positive angle is anticlockwise in
// the world, clockwise in CSS.
function place(el: HTMLElement, item: Item) {
  placeBox(el, item);
  // String() rather than the DOM's own coercion of the number, which is the
  // only thing it can do with one. Same value written.
  el.style.zIndex = String(Math.round(item.z));
}

/** Apply the outer geometry shared by an item and its shadow twin. */
function placeBox(el: HTMLElement, item: Item) {
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
function deviceSnap(item: Item) {
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
function itemTransform(item: Item) {
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
    // out of the world layer and into a dialog (openComposer, canvas/notes.ts),
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
 * id -> effective z-index, cached from the last restack.
 *
 * Read when sync() mounts a fresh node on a view-change frame, which does not
 * restack (see syncView): the new node still needs a rank, and the ranks did
 * not change, so it takes the one this remembers rather than forcing the whole
 * board to be recomputed for the sake of one card scrolling into view.
 */
let stackIndex = new Map<string, number>();

// The two underlays inside #world, from canvas.css: #item-shadows at -1 and #web
// at -2. Named here because the fence band has to be sunk past both of them, and
// a bare -3 in the arithmetic below would be a number nobody could check.
const UNDERLAY_Z = -2;

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
  for (const [id, el] of nodes) el.style.zIndex = String(stackIndex.get(id) ?? 0);
}

/** Place a node and its shadow, and hand back the item it resolved for reuse. */
function placeNode(id: string) {
  const el = nodes.get(id);
  const shadow = shadows.get(id);
  const item = byId(id);
  if (el && item) {
    place(el, item);
    // Every frame of a resize lands here, so this is where a card pulled past
    // the size a lean allows stands up straight - see retilt(). The twin turns
    // with it, or the shadow would keep the old angle.
    const tilt = retilt(el, item);
    if (tilt !== null) shadow?.style.setProperty('--item-tilt', tilt);
  }
  if (shadow && item) placeBox(shadow, item);
  return item;
}

function paintSelection() {
  for (const [id, el] of nodes) {
    const on = selection.has(id);
    // Taking them *away* only. Which selected cards get grips is paintGrips()'s
    // question, because it has a second one to ask and a clock to watch - and
    // this walk, over every mounted node, is the one that must not run per frame.
    if (!on) { setGrips(el, false); showPin(el, 'is-pin-sel', false); }
    el.classList.toggle('is-selected', on);
    // The twin tracks selection too, so a selected card's shadow holds still
    // under the pointer exactly as the card does (see .item-shadow in canvas.css).
    shadows.get(id)?.classList.toggle('is-selected', on);
  }
  paintGrips();
}

/**
 * The eight resize handles onto the selection - minus anything pinned.
 *
 * A note or sticker fixed to a card is that card's. Its place is already the
 * card's (press it and the host moves), and its size is the same sentence one
 * dimension over, so the grips it would wear are eight handles canvas/input.ts
 * then declines. That is precisely what data-locked avoids by not drawing them,
 * and the same bargain applies: the refusal itself lives in pressIntent() and
 * never here, because a paint pass that was the only thing standing between a
 * pointer and an item's geometry would be one missed repaint away from meaning
 * nothing.
 *
 * Over the selection rather than over every mounted node, because this runs on
 * 'geom' - which fires on every frame of a drag - and a selection is a handful
 * of ids where `nodes` is a screenful. Deselected cards lose their grips in
 * paintSelection(), which walks the whole map once per selection change.
 *
 * The timer is the settle clock, and it is the argument paintPinBadge() makes
 * one relation over. A sticker is stuck the instant it lands but does not *pin*
 * for ten seconds (SETTLE_MS, sticky.ts), and nothing announces the moment it
 * does - so without this, a sticker dropped onto a photograph, which a drop
 * leaves selected, would keep its grips for as long as it stayed selected and
 * pressing one would move the photograph. One outstanding timer, cleared on
 * every run, so there is nothing to cancel on a delete or a board swap: the
 * next run finds the item unselected or gone and schedules nothing.
 */
let gripWatch = 0;
function paintGrips() {
  clearTimeout(gripWatch);
  let soonest = 0;
  for (const id of selection) {
    const it = byId(id);
    // A selected card can be culled: it has no node until it comes back on
    // screen, and build() asks this same question when it does.
    const el = nodes.get(id);
    const pinned = isPinned(it);
    if (el) { setGrips(el, !pinned); showPin(el, 'is-pin-sel', pinned); }
    const left = settlesIn(it);
    if (left && (!soonest || left < soonest)) soonest = left;
  }
  // +50ms, so the callback lands the far side of the comparison rather than on
  // the exact millisecond it turns over.
  if (soonest) gripWatch = setTimeout(paintGrips, soonest + 50);
  // Last, since the rings copy the grips. This pass already runs after every
  // selection change and every frame of a drag, which are the two things a
  // ring has to follow.
  paintRings();
}

/** What a card says on itself that its ring's rules read. Classes go across too:
 *  every `is-` state the card wears, from the drag lift to the roll. */
const RING_ATTRS = ['data-type', 'data-locked', 'data-bare', 'data-grips'] as const;

/**
 * Bring one card's selection ring into line with the card.
 *
 * The ring used to be the card's own ::before, which paints at the card's depth:
 * any card stacked higher drew straight over the outline of what was selected.
 * Here it is a twin in #item-rings, a layer above the whole item stack, built
 * as #item-shadows is below it - same box, same lean, same lift - so it cannot
 * be covered. It exists while the card is selected and on the board, and not
 * otherwise: a card lifted into the note composer or culled has none.
 *
 * Cheap enough to run over the selection on every frame of a drag: each write is
 * skipped when it would not change anything, and placeBox() is what placeNode()
 * already pays for the card itself.
 */
function paintRing(id: string) {
  const el = nodes.get(id);
  const item = byId(id);
  let ring = rings.get(id);
  if (!el || !item || !selection.has(id) || el.parentElement !== worldEl) {
    ring?.remove();
    rings.delete(id);
    return;
  }
  let fresh = false;
  if (!ring) {
    ring = buildRing();
    rings.set(id, ring);
    fresh = true;
  }
  if (!ring.isConnected) ringLayerEl!.append(ring);
  // A press on a hover-lifted card selects it and the card settles from the
  // lift. A ring born at rest would show the card sinking through it, so it is
  // born lifted, as the card was, and both settle on the one transition.
  if (fresh && el.classList.contains('is-hover') && !el.classList.contains('is-dragging')) {
    ring.className = 'item-ring is-hover';
    placeBox(ring, item);
    ring.style.setProperty('--item-tilt', el.style.getPropertyValue('--item-tilt'));
    void getComputedStyle(ring).scale;   // commit the lifted start before the classes below
  }
  let cls = 'item-ring';
  for (const c of el.classList) if (c.startsWith('is-')) cls += ' ' + c;
  if (ring.className !== cls) ring.className = cls;
  for (const name of RING_ATTRS) {
    const v = el.getAttribute(name);
    if (v === null) ring.removeAttribute(name);
    else if (ring.getAttribute(name) !== v) ring.setAttribute(name, v);
  }
  const tilt = el.style.getPropertyValue('--item-tilt');
  if (ring.style.getPropertyValue('--item-tilt') !== tilt) ring.style.setProperty('--item-tilt', tilt);
  placeBox(ring, item);
}

/** Every ring: the selection's, and any left over from cards no longer in it. */
function paintRings() {
  if (!ringLayerEl) return;
  for (const id of rings.keys()) if (!selection.has(id)) paintRing(id);
  for (const id of selection) paintRing(id);
}

/** Exported for canvas/input.ts, which takes a resize's mark-swelling class off
 *  the card at the end of the gesture, after the last frame that repaints. */
export const refreshRings = paintRings;

/**
 * Swell the corner mark under the pointer, as the mark itself did when it was
 * drawn on the grip: the grip is on the card and the mark is in the ring layer,
 * so CSS :hover on one cannot reach the other.
 */
function swellMark(target: EventTarget | null) {
  if (!ringLayerEl) return;
  for (const m of ringLayerEl.querySelectorAll('.ring-mark.is-swell')) m.classList.remove('is-swell');
  const grip = target instanceof Element ? target.closest<HTMLElement>('.grip:not(.grip-edge)') : null;
  const id = grip && itemIdFromEvent(grip);
  if (id) rings.get(id)?.querySelector(`.ring-mark[data-g="${grip.dataset.g}"]`)?.classList.add('is-swell');
}

/**
 * Fade whatever the tag filter is not showing.
 *
 * A class and nothing else: the card stays mounted, stays where it is, stays
 * selectable and stays draggable, because the filter dims rather than hides -
 * see tagFilter in board-store.ts for why that is the design and not a
 * half-finished version of hiding.
 *
 * Its own pass rather than a line inside paintSelection(), even though the two
 * are the same shape, because they answer different events at very different
 * rates: selection repaints on every click and every drag, and this repaints
 * when somebody opens a menu and ticks a tag.
 */
function paintFilter() {
  for (const [id, el] of nodes) {
    const dim = isFiltered(byId(id));
    el.classList.toggle('is-filtered', dim);
    shadows.get(id)?.classList.toggle('is-filtered', dim);
  }
  paintRings();
}

/** The rolled-up fences as of the last paintRolled(), read again at build. */
let rolledNow: Set<string> = new Set();

/**
 * Hide what a rolled-up fence holds, and show it again when it unrolls.
 *
 * Hidden rather than dimmed, unlike the filter: roll-up is a fence folded down
 * to its name bar, and what it folds is out of sight. The cards stay mounted and
 * stay where they are, so the fence carries them when it moves. Nothing to do on
 * a board with no rolled fence and none just unrolled, which is every board
 * until somebody rolls one.
 */
function paintRolled() {
  const next = rolledFences();
  if (!next.size && !rolledNow.size) return;
  rolledNow = next;
  for (const [id, el] of nodes) {
    const away = rolledAway(byId(id), next);
    el.classList.toggle('is-rolled-away', away);
    shadows.get(id)?.classList.toggle('is-rolled-away', away);
  }
  paintRings();
}

/** The cards the cleaning game dealt a mess to, while it is up and left some
 *  out; null otherwise. Read again at build. */
let cleanPlay: Set<string> | null = null;

const cleanOut = (id: string) => !!cleanPlay && !cleanPlay.has(id);

/**
 * Hide every card the cleaning game left out, or show them all again with null.
 *
 * Hidden rather than dimmed, like a rolled-up fence: a card with no mess on it
 * beside the ones being washed is a card that looks forgotten. The set is the
 * cards in play rather than the ones left out, so a card that was off screen
 * when the game began comes back hidden when it is panned to - see build().
 */
export function setCleanPlay(ids: Set<string> | null) {
  if (!ids && !cleanPlay) return;
  cleanPlay = ids;
  for (const [id, el] of nodes) {
    const out = cleanOut(id);
    el.classList.toggle('is-clean-out', out);
    shadows.get(id)?.classList.toggle('is-clean-out', out);
  }
  paintRings();
}

/** Repaint every mounted node from scratch - used after loading a board. */
export function resetItems() {
  for (const el of nodes.values()) discard(el);
  nodes.clear();
  shadows.clear();
  rings.clear();
  ringLayerEl?.replaceChildren();
  // The five id-keyed latches, which are the same kind of state as the two maps
  // above and were being left behind. Each is "which card is currently wearing
  // this mark", and every one of them is compared before it is written: with
  // the pointer resting on a card while a board loads or the quality dial
  // rebuilds every node, setHoverGroup(id) returned early on `id ===
  // lastHoverId` and the rebuilt card never got its `is-hover` - a card the
  // pointer was on that would not light up until it was left and re-entered.
  lastHoverId = null;
  hoverGroup = new Set();
  stickTargetId = null;
  pickedId = null;
  aimedId = null;
  // Non-null: a board can only be replaced once one has been opened, which is
  // after initItems() - see the note on the declarations.
  shadowLayerEl!.replaceChildren();
  // The display copies are keyed by content hash and a new board is new content;
  // release the ones this session made so a long-lived PWA does not accumulate
  // them board after board (canvas/display.ts).
  clearDisplay();
  // A new board gets a new pack, so its first three items carry a full set of
  // leans rather than whatever was left over from the last one.
  resetTilt();
  reconcile();
  reindex();
  sync();
}
