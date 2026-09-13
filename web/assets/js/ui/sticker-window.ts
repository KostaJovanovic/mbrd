// Sticker pad: floating window of shapes (drag or tap-then-tap onto the board).
// Shares move/resize gestures with float-window.ts. Favourites are app-wide
// (localStorage, not .mbrd) because a board carries your stickers, not your
// picks. Last category is session-only (module variable).
//
// Nothing here touches `document` at import time - every reach is inside
// initStickerWindow() or a handler that runs after it.

import { readPrefJSON, writePref } from '../prefs.ts';
import { div, markClosed } from '../util.ts';
import { cue } from '../cuelume/engine.ts';
import { bus, wouldStick, byId } from '../state.ts';
import { defaultSize } from '../canvas/renderers.ts';
import { showStickTarget } from '../canvas/items.ts';
import { makeWindowDrag, makeWindowResize } from './float-window.ts';
import { registerPanel, panelShown, panelHidden } from './panel-stack.ts';
import {
  STICKERS, STICKER_CATEGORIES, stickerArt, stickerShape,
} from '../stickers/catalogue.ts';
import type { Sticker } from '../stickers/catalogue.ts';
import type { Viewport } from '../canvas/viewport.ts';

/**
 * What this window asks of the command surface: one verb. Handed in rather
 * than imported, the same seam ui/toolbar.ts and ui/hud.ts use - commands.ts
 * imports this module, and the arrow only goes one way.
 */
export interface StickerCommands {
  addStickerAt: (shape: string, at: { x: number, y: number }) => void;
}

const CLOSE_ICON =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
const FAV_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.9 9.8 5.6 13.9 6.2 10.9 9.1 11.6 13.2 8 11.3 4.4 13.2 5.1 9.1 2.1 6.2 6.2 5.6z"/></svg>';

/** Where the picks live. Prefixed like every other preference this app writes. */
const FAV_KEY = 'mbrd.stickerFavourites';

/** How far a press has to travel before it is a drag rather than a tap. */
const DRAG_SLOP = 5;

let vp: Viewport | null = null;
let cmds: StickerCommands | null = null;
let win: HTMLElement | null = null;        // the window element, or null when closed
let body: HTMLElement | null = null;       // the scrolling region inside it
let detachGrabs: (() => void)[] = [];      // grab-listener detaches, called on close

/** The category last placed from, so the next open lands where you left off. */
let lastCategory = STICKER_CATEGORIES[0][0];

/** `{ shape, tint }` while a tile is armed and waiting for a tap on the board. */
let armed: { shape: string, tint: number } | null = null;

/** The tile drag in flight: the ghost element and what it is carrying. */
type TileDrag = {
  entry: Sticker,
  el: HTMLElement,
  id: number,
  x: number,
  y: number,
  ghost: HTMLElement | null,
};
let drag: TileDrag | null = null;

export function initStickerWindow(viewport: Viewport, commands: StickerCommands) {
  vp = viewport;
  cmds = commands;
  registerPanel('stickers', openStickerWindow, closeStickerWindow);

  // A board swap takes the window with it - not because shapes change, but
  // because everything else on screen tears down and a window left floating
  // over a gone board would be the one thing that looked like a bug.
  bus.on('board:load', () => { disarm(); closeStickerWindow(); });

  // The armed tap. Capture phase on the viewport, so it lands before the
  // ordinary press pipeline can select something or start a pan - an armed
  // board is placing a sticker and doing nothing else.
  const surface = document.getElementById('viewport');
  surface?.addEventListener('pointerdown', e => {
    if (!armed || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const shape = armed.shape;
    disarm();
    cmds!.addStickerAt(shape, vp!.toWorld(e.clientX, e.clientY));
  }, true);

  // Escape gets out, always. Capture, before anything else reads the key - a
  // mode you cannot leave is the reason this app has never had one.
  addEventListener('keydown', e => {
    if (e.key !== 'Escape' || !armed) return;
    e.stopPropagation();
    markClosed(e);
    disarm();
  }, true);
}

// ---------------------------------------------------------------------------
// The window
// ---------------------------------------------------------------------------

/** The toolbar's Stickers button: open it if closed, close it if open. */
export function toggleStickerWindow() {
  if (win) closeStickerWindow(); else openStickerWindow();
}

function openStickerWindow() {
  if (win) return;
  win = div('sticker-window');

  const head = div('sticker-window-head');
  const title = div('sticker-window-title');
  title.textContent = 'Stickers';
  const spacer = div('sticker-window-spacer');
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'sticker-window-close';
  close.setAttribute('aria-label', 'Close stickers');
  close.innerHTML = CLOSE_ICON;
  close.addEventListener('click', () => { cue('pick'); closeStickerWindow(); });
  head.append(title, spacer, close);
  detachGrabs.push(makeWindowDrag(win, head));

  body = div('sticker-window-body');
  win.append(head, body);

  const resize = div('sticker-window-resize');
  resize.setAttribute('aria-hidden', 'true');
  win.append(resize);
  detachGrabs.push(makeWindowResize(win, resize, { minW: 240, minH: 200 }));

  document.body.append(win);
  renderBody();
  panelShown('stickers');

  // Up into place next frame - it needs two computed styles to run between for
  // the transition to take, the same as the player window.
  requestAnimationFrame(() => win?.classList.add('is-open'));
}

/** The slide-out backstop, so a close that never sees transitionend finishes. */
let exitTimer = 0;

function closeStickerWindow() {
  if (!win) return;
  const el = win;
  win = null;
  body = null;
  // Take the move/resize grab listeners off window before the element goes.
  detachGrabs.forEach(fn => fn());
  detachGrabs = [];
  disarm();
  el.classList.remove('is-open');
  clearTimeout(exitTimer);
  const done = () => { clearTimeout(exitTimer); el.remove(); };
  el.addEventListener('transitionend', e => { if (e.propertyName === 'transform') done(); }, { once: true });
  exitTimer = setTimeout(done, 500);
  panelHidden('stickers');
}

// ---------------------------------------------------------------------------
// The grid
// ---------------------------------------------------------------------------

/**
 * Build the whole body: the favourites row, then every category in order.
 *
 * Rebuilt whole rather than patched on a favourite toggle - the favourites row
 * is a *second* place a shape appears, and keeping two tiles in step is more
 * code than remaking forty-five buttons. Happens on a click, not a frame.
 */
function renderBody() {
  if (!body) return;
  body.replaceChildren();

  const favs = favourites();
  if (favs.length) {
    // No heading text beyond the word - being at the top says most of what
    // "favourites" needs to. stickerShape() answers null for a retired id;
    // favourites() has already dropped those, so this just keeps the type honest.
    const pinned: Sticker[] = [];
    for (const id of favs) {
      const shape = stickerShape(id);
      if (shape) pinned.push(shape);
    }
    body.append(heading('Favourites'), gridOf(pinned, true));
  }
  for (const [key, label] of STICKER_CATEGORIES) {
    const shapes = STICKERS.filter(s => s.cat === key);
    if (!shapes.length) continue;
    const h = heading(label);
    h.dataset.cat = key;
    body.append(h, gridOf(shapes, false));
  }

  // Back to the shelf this session was last using. Instant, not smooth - the
  // window just appeared, and scrolling while you watch reads as the app
  // doing something rather than remembering something.
  //
  // Measured against the first child, not `body`: both offsetTops are
  // relative to .sticker-window, so subtracting them directly baked in the
  // body's padding and heading's margin, opening the pad a few pixels down
  // with "Marks" sliced off the top even on a fresh window - looked like a
  // font bug, which is why it survived so long. Not a blanket scrollTop = 0
  // either: that breaks the moment a favourite exists and the Favourites
  // shelf sits above Marks.
  const at = body.querySelector<HTMLElement>(`[data-cat="${lastCategory}"]`);
  // SAFETY: every child of the window's body is a shelf built with div(), so
  // the first is an HTMLElement. Null kept for an empty body.
  const first = body.firstElementChild as HTMLElement | null;
  if (at && first && at !== first) body.scrollTop = at.offsetTop - first.offsetTop;
}

function heading(text: string) {
  const h = document.createElement('h3');
  h.className = 'sticker-cat';
  h.textContent = text;
  return h;
}

function gridOf(shapes: Sticker[], inFavourites: boolean) {
  const grid = div('sticker-grid');
  for (const s of shapes) grid.append(tile(s, inFavourites));
  return grid;
}

/**
 * One shape, as a tile.
 *
 * A div with role="button", not a real <button>: the favourite star is a
 * button of its own in the corner, and a button inside a button is markup no
 * browser agrees about. Keyboard support is wired by hand to make up for it.
 */
function tile(entry: Sticker, inFavourites: boolean) {
  const el = div('sticker-tile');
  el.dataset.shape = entry.id;
  el.setAttribute('role', 'button');
  el.setAttribute('tabindex', '0');
  el.setAttribute('aria-label', entry.name);
  el.title = entry.name;
  el.append(shapeArt(entry.id, entry.tint));

  const fav = document.createElement('button');
  fav.type = 'button';
  fav.className = 'sticker-fav';
  fav.innerHTML = FAV_ICON;
  const on = favourites().includes(entry.id);
  fav.setAttribute('aria-pressed', String(on));
  fav.setAttribute('aria-label', on ? `Unpin ${entry.name}` : `Pin ${entry.name}`);
  fav.title = on ? 'Remove from favourites' : 'Keep at the top';
  // pointerdown as well as click: the tile's own press handler is on
  // pointerdown, and without stopping it here a star press would start
  // dragging the shape out of the window.
  fav.addEventListener('pointerdown', e => e.stopPropagation());
  // A toggle, not an action, so it says which way it went - same pair the
  // panel's checkboxes use.
  fav.addEventListener('click', e => { e.stopPropagation(); cue(on ? 'off' : 'on'); toggleFavourite(entry.id); });
  el.append(fav);
  if (inFavourites) el.classList.add('is-favourite');

  el.addEventListener('pointerdown', e => startTileDrag(e, entry));
  el.addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    arm(entry);
  });
  return el;
}

/**
 * An <svg> showing one shape out of the sprite. Tint goes on the artwork
 * itself, matching where items.css reads it from - one rule per colour,
 * shared by all five places a sticker is drawn. A tile shows the shape's own
 * default, the whole promise of the pad: the sticker you place is the one you saw.
 */
function shapeArt(id: string, tint: number) {
  const svg = stickerArt(id);
  if (tint) svg.dataset.tint = String(tint);
  return svg;
}

// ---------------------------------------------------------------------------
// Favourites
// ---------------------------------------------------------------------------

/**
 * The pinned shapes, as ids. Read through the catalogue rather than trusted:
 * localStorage is same-origin storage anybody with a console can edit, and a
 * bad id would otherwise land in a `<use href>`. Also tidies up after a
 * renamed or retired shape.
 */
function favourites(): string[] {
  const raw = readPrefJSON<unknown>(FAV_KEY, []);
  if (!Array.isArray(raw)) return [];
  return raw.filter((id): id is string => typeof id === 'string' && !!stickerShape(id));
}

function toggleFavourite(id: string) {
  const list = favourites();
  const i = list.indexOf(id);
  if (i >= 0) list.splice(i, 1); else list.push(id);
  writePref(FAV_KEY, JSON.stringify(list));
  renderBody();
}

// ---------------------------------------------------------------------------
// Tap to arm
// ---------------------------------------------------------------------------

/** The armed shape, or null. Read by the Mobile feed's own tap-to-place path. */
export const armedSticker = () => armed;

function arm(entry: Sticker) {
  const same = armed?.shape === entry.id;
  disarm();
  if (same) return;                       // tapping the armed tile puts it down
  armed = { shape: entry.id, tint: entry.tint };
  lastCategory = entry.cat;
  // Two marks, because two things have to say it: the held-down tile shows
  // what's in your hand, the root class lets the board carry a loaded cursor.
  // Either alone leaves half the app looking ordinary while armed.
  markArmed();
  document.documentElement.classList.add('sticker-arming');
}

export function disarm() {
  if (!armed) return;
  armed = null;
  markArmed();
  document.documentElement.classList.remove('sticker-arming');
}

function markArmed() {
  if (!win) return;
  for (const el of win.querySelectorAll<HTMLElement>('.sticker-tile')) {
    el.classList.toggle('is-armed', !!armed && el.dataset.shape === armed.shape);
  }
}

// ---------------------------------------------------------------------------
// Drag a tile onto the board
// ---------------------------------------------------------------------------

/**
 * A press on a tile, which may still turn out to be either gesture.
 *
 * Nothing decided here: the ghost isn't made until the pointer clears the
 * slop, and a press that never does is a tap - so the same press arms on a
 * phone and drags on a desktop without guessing which one it is.
 */
function startTileDrag(e: PointerEvent, entry: Sticker) {
  if (e.button !== 0) return;
  e.preventDefault();
  // SAFETY: currentTarget is the tile this listener was bound to, which is the
  // one target a handler can be sure of.
  const el = e.currentTarget as HTMLElement;
  el.setPointerCapture?.(e.pointerId);
  drag = { entry, el, id: e.pointerId, x: e.clientX, y: e.clientY, ghost: null };

  const move = (ev: PointerEvent) => {
    if (!drag || ev.pointerId !== drag.id) return;
    if (!drag.ghost) {
      if (Math.hypot(ev.clientX - drag.x, ev.clientY - drag.y) < DRAG_SLOP) return;
      // It has become a drag, and the window gets out of the way for good -
      // it used to fade to 55% instead, still standing over most of the
      // board on a phone. Safe to close mid-gesture: pointer listeners are
      // on `window`, not the tile, so the drag survives; closeStickerWindow()
      // slides out and only removes the element on transitionend or a
      // 500ms backstop, so the tile is still there when the drag ends.
      closeStickerWindow();
      drag.ghost = makeGhost(entry);
      document.body.append(drag.ghost);
    }
    placeGhost(ev.clientX, ev.clientY);
    showStickTarget(hostUnderPointer(ev.clientX, ev.clientY));
  };

  const end = (ev: PointerEvent) => {
    if (!drag || ev.pointerId !== drag.id) return;
    const { ghost } = drag;
    const dropped = ev.type === 'pointerup' && ghost && overBoard(ev.clientX, ev.clientY);
    ghost?.remove();
    // The window may have closed under this tile already, and releasing a
    // pointer the element no longer captures throws rather than no-opping.
    try { drag.el.releasePointerCapture?.(ev.pointerId); } catch { /* already gone */ }
    drag = null;
    showStickTarget(null);
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', end);
    removeEventListener('pointercancel', end);
    if (dropped) {
      lastCategory = entry.cat;
      cmds!.addStickerAt(entry.id, vp!.toWorld(ev.clientX, ev.clientY));
    }
    // Never moved: this was a tap, and a tap arms.
    else if (!ghost && ev.type === 'pointerup') arm(entry);
  };

  // On the window, not the tile, even though the tile holds capture: capture
  // keeps events coming to the tile, and these listen for them on the way
  // past - a drag ending over the board still has to be heard.
  addEventListener('pointermove', move);
  addEventListener('pointerup', end);
  addEventListener('pointercancel', end);
}

function makeGhost(entry: Sticker) {
  const el = div('sticker-ghost');
  el.append(shapeArt(entry.id, entry.tint));
  return el;
}

function placeGhost(clientX: number, clientY: number) {
  if (!drag?.ghost) return;
  drag.ghost.style.left = `${clientX}px`;
  drag.ghost.style.top = `${clientY}px`;
}

/** Is this screen point over the board rather than over the app's chrome? */
function overBoard(clientX: number, clientY: number) {
  const under = document.elementFromPoint(clientX, clientY);
  return !!under?.closest('#viewport');
}

/**
 * What the shape would stick to if it were let go here, or null - the same
 * question the note drag asks mid-flight, of a box not on the board yet
 * (wouldStick()). The rider is a bare `{ type }` stub, since there's no item
 * yet and type is all the answer turns on: a sticker may land on a fence or
 * the title card, where a note may not.
 */
function hostUnderPointer(clientX: number, clientY: number) {
  if (!overBoard(clientX, clientY)) return null;
  const at = vp!.toWorld(clientX, clientY);
  // Every sticker is the same fixed square (defaultSize), so the measured box
  // is the box the drop will make. Stops being true the day a shape gets a
  // size of its own.
  const size = defaultSize('sticker');
  // No id to exclude: there is no item yet, which is the whole point of asking.
  const host = wouldStick(
    { x: at.x, y: at.y, w: size.w, h: size.h }, undefined, { type: 'sticker' });
  // byId, because wouldStick hands back the live item and a host deleted
  // between two pointer moves would otherwise put the ring on a node that is on
  // its way off the board.
  return host && byId(host.id) ? host : null;
}

