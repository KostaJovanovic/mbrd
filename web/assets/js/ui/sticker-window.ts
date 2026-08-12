// @ts-nocheck - TypeScript migration debt, not a judgement about this file.
//
// The tree was renamed from .js to .ts mechanically, which moved 104 modules in
// one step and annotated none of them. This module is carried unchecked so that
// npm run typecheck stays green and keeps meaning something, rather than going
// red and being ignored. Converting this module IS deleting this block and
// fixing what tsc then says - tests/ts-debt.test.js holds the count and lets it
// only fall.
// The sticker pad: a little floating window of shapes you drag or tap onto the
// board.
//
// Modelled on the Playlist's Desktop window and sharing its two gestures
// outright (ui/float-window.js) - draggable by its title bar, resizable by its
// corner. What is different is what it is *for*: the player window shows you
// the board's own contents, and this one is a drawer of things that are not on
// the board yet. So it is a grid rather than a list, it is on both layouts
// rather than Desktop alone, and it has favourites.
//
// Two ways out of it, and they are two because a mouse and a finger do not want
// the same one:
//
//   - **Drag a tile onto the board.** A ghost follows the pointer and the card
//     it would land on wears the same ring a dragged note's host wears, so the
//     target is unmistakable before you let go. Desktop, in practice.
//   - **Tap a tile, then tap the board.** The only one that works on a phone,
//     and it works on both. The armed shape is visibly held down and the board
//     says so too - a board that quietly places a star on your next click is a
//     board that has been possessed - and Escape always puts it back.
//
// Deliberately absent: a recently-used row, and a keyboard shortcut. Favourites
// cover the same want with less machinery, and the letter keys are worth
// keeping free.
//
// **Favourites are app-wide and not part of the board.** A board you send
// somebody carries your stickers and not your picks, which is the whole reason
// they are in localStorage (readPrefJSON / writePref, the same door the volume
// and the panel state use) rather than a key in the .mbrd. The last category is
// remembered too, but only in a module variable: which shelf you were looking
// at is a fact about this sitting, not about you.
//
// Nothing here touches `document` at import time - every reach is inside
// initStickerWindow() or a handler that runs after it.

import { readPrefJSON, writePref } from '../prefs.ts';
import { bus, wouldStick, byId } from '../state.ts';
import { defaultSize } from '../canvas/renderers.ts';
import { showStickTarget } from '../canvas/items.ts';
import { makeWindowDrag, makeWindowResize } from './float-window.ts';
import { registerPanel, panelShown, panelHidden } from './panel-stack.ts';
import {
  STICKERS, STICKER_CATEGORIES, STICKER_SPRITE, STICKER_VIEWBOX, stickerShape,
} from '../stickers/catalogue.ts';

const CLOSE_ICON =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
const FAV_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.9 9.8 5.6 13.9 6.2 10.9 9.1 11.6 13.2 8 11.3 4.4 13.2 5.1 9.1 2.1 6.2 6.2 5.6z"/></svg>';

/** Where the picks live. Prefixed like every other preference this app writes. */
const FAV_KEY = 'mbrd.stickerFavourites';

/** How far a press has to travel before it is a drag rather than a tap. */
const DRAG_SLOP = 5;

let vp = null;
let cmds = null;
let win = null;        // the window element, or null when closed
let body = null;       // the scrolling region inside it

/** The category last placed from, so the next open lands where you left off. */
let lastCategory = STICKER_CATEGORIES[0][0];

/** `{ shape, tint }` while a tile is armed and waiting for a tap on the board. */
let armed = null;

/** The tile drag in flight: the ghost element and what it is carrying. */
let drag = null;

export function initStickerWindow(viewport, commands) {
  vp = viewport;
  cmds = commands;
  registerPanel('stickers', openStickerWindow, closeStickerWindow);

  // A board swap takes the window with it. Not because the shapes change - the
  // catalogue is the same on every board - but because everything else on
  // screen is torn down and a window left floating over a board that no longer
  // exists is the one thing that would look like a bug.
  bus.on('board:load', () => { disarm(); closeStickerWindow(); });

  // The armed tap. On the viewport in the capture phase, so it lands before the
  // ordinary press pipeline has a chance to select something or start a pan -
  // an armed board is placing a sticker and doing nothing else, which is the
  // whole of what "armed" means.
  const surface = document.getElementById('viewport');
  surface?.addEventListener('pointerdown', e => {
    if (!armed || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const shape = armed.shape;
    disarm();
    cmds.addStickerAt(shape, vp.toWorld(e.clientX, e.clientY));
  }, true);

  // Escape gets out, always. Capture, and before anything else can read the
  // key: a mode you cannot leave is the reason this app has never had one.
  addEventListener('keydown', e => {
    if (e.key !== 'Escape' || !armed) return;
    e.stopPropagation();
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

export function openStickerWindow() {
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
  close.addEventListener('click', closeStickerWindow);
  head.append(title, spacer, close);
  makeWindowDrag(win, head);

  body = div('sticker-window-body');
  win.append(head, body);

  const resize = div('sticker-window-resize');
  resize.setAttribute('aria-hidden', 'true');
  win.append(resize);
  makeWindowResize(win, resize, { minW: 240, minH: 200 });

  document.body.append(win);
  renderBody();
  panelShown('stickers');

  // Up into place next frame - it needs two computed styles to run between for
  // the transition to take, the same as the player window.
  requestAnimationFrame(() => win?.classList.add('is-open'));
}

/** The slide-out backstop, so a close that never sees transitionend finishes. */
let exitTimer = 0;

export function closeStickerWindow() {
  if (!win) return;
  const el = win;
  win = null;
  body = null;
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
 * Rebuilt whole rather than patched when a favourite changes, because the
 * favourites row is a *second* place a shape appears and keeping two copies of
 * one tile in step through a toggle is more code than making forty-five
 * buttons again. It happens on a click, not on a frame.
 */
function renderBody() {
  if (!body) return;
  body.replaceChildren();

  const favs = favourites();
  if (favs.length) {
    // No heading text of its own beyond the word - the row is at the top, which
    // is most of what "favourites" has to say, and a shelf of six shapes under
    // a paragraph would be more explanation than shelf.
    body.append(heading('Favourites'), gridOf(favs.map(stickerShape).filter(Boolean), true));
  }
  for (const [key, label] of STICKER_CATEGORIES) {
    const shapes = STICKERS.filter(s => s.cat === key);
    if (!shapes.length) continue;
    const h = heading(label);
    h.dataset.cat = key;
    body.append(h, gridOf(shapes, false));
  }

  // Back to the shelf this session was last using. Instant rather than smooth:
  // the window has only just appeared, and a body that scrolls itself while you
  // are looking at it reads as the app doing something rather than as it
  // remembering something.
  const at = body.querySelector(`[data-cat="${lastCategory}"]`);
  if (at) body.scrollTop = at.offsetTop - body.offsetTop;
}

function heading(text) {
  const h = document.createElement('h3');
  h.className = 'sticker-cat';
  h.textContent = text;
  return h;
}

function gridOf(shapes, inFavourites) {
  const grid = div('sticker-grid');
  for (const s of shapes) grid.append(tile(s, inFavourites));
  return grid;
}

/**
 * One shape, as a tile.
 *
 * A div with role="button" rather than a real <button>, and for one reason: the
 * favourite star is a button of its own in the corner, and a button inside a
 * button is not markup any browser agrees about. The keyboard is wired by hand
 * below to make up for it.
 */
function tile(entry, inFavourites) {
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
  // pointerdown, and without stopping it here a press on the star would start
  // dragging the shape out of the window.
  fav.addEventListener('pointerdown', e => e.stopPropagation());
  fav.addEventListener('click', e => { e.stopPropagation(); toggleFavourite(entry.id); });
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
 * An <svg> showing one shape out of the sprite.
 *
 * The tint goes on the artwork rather than on whatever holds it, because that
 * is where items.css reads it from - one rule per colour, shared by all five
 * places a sticker is drawn. A tile shows the shape's own default, which is
 * the whole promise of the pad: the sticker you place is the one you saw.
 */
function shapeArt(id, tint) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'sticker-art');
  svg.setAttribute('viewBox', STICKER_VIEWBOX);
  svg.setAttribute('aria-hidden', 'true');
  if (tint) svg.dataset.tint = tint;
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `${STICKER_SPRITE}#${id}`);
  svg.append(use);
  return svg;
}

// ---------------------------------------------------------------------------
// Favourites
// ---------------------------------------------------------------------------

/**
 * The pinned shapes, as ids.
 *
 * Read through the catalogue rather than trusted: localStorage is same-origin
 * storage anybody with a console can edit, and an id from it would otherwise be
 * written into a `<use href>`. An entry naming nothing is dropped, which also
 * quietly tidies up after a shape being renamed or retired.
 */
function favourites() {
  const raw = readPrefJSON(FAV_KEY, []);
  if (!Array.isArray(raw)) return [];
  return raw.filter(id => typeof id === 'string' && stickerShape(id));
}

function toggleFavourite(id) {
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

function arm(entry) {
  const same = armed?.shape === entry.id;
  disarm();
  if (same) return;                       // tapping the armed tile puts it down
  armed = { shape: entry.id, tint: entry.tint };
  lastCategory = entry.cat;
  // Two marks, because two things have to say it. The tile stays held down, so
  // the window shows what is in your hand; the root class is what lets the
  // board carry a loaded cursor. Either alone leaves half the app looking
  // ordinary while it is waiting to place a star.
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
  for (const el of win.querySelectorAll('.sticker-tile')) {
    el.classList.toggle('is-armed', !!armed && el.dataset.shape === armed.shape);
  }
}

// ---------------------------------------------------------------------------
// Drag a tile onto the board
// ---------------------------------------------------------------------------

/**
 * A press on a tile, which may still turn out to be either gesture.
 *
 * Nothing is decided here. The ghost is not made until the pointer has moved
 * past the slop, and a press that never does is a tap - so the same press arms
 * the shape on a phone and carries it on a desktop, without the window having
 * to guess which one it is looking at.
 */
function startTileDrag(e, entry) {
  if (e.button !== 0) return;
  e.preventDefault();
  const el = e.currentTarget;
  el.setPointerCapture?.(e.pointerId);
  drag = { entry, el, id: e.pointerId, x: e.clientX, y: e.clientY, ghost: null };

  const move = ev => {
    if (!drag || ev.pointerId !== drag.id) return;
    if (!drag.ghost) {
      if (Math.hypot(ev.clientX - drag.x, ev.clientY - drag.y) < DRAG_SLOP) return;
      // It has become a drag, and the window gets out of the way for good. It
      // used to fade to 55% instead, which is a window still standing over the
      // board you are aiming at - and on a phone the board it covers is most of
      // the board there is.
      //
      // Safe to close mid-gesture, in three parts worth naming because none of
      // them is obvious. The pointer listeners are on `window`, not on the tile,
      // so the drag survives its own tile being removed. closeStickerWindow()
      // plays the slide-out and only removes the element on transitionend or a
      // 500ms backstop, so the tile is still in the document when the drag ends
      // and releases its capture. And it calls disarm() itself, which is what
      // the line here used to do.
      closeStickerWindow();
      drag.ghost = makeGhost(entry);
      document.body.append(drag.ghost);
    }
    placeGhost(ev.clientX, ev.clientY);
    showStickTarget(hostUnderPointer(ev.clientX, ev.clientY));
  };

  const end = ev => {
    if (!drag || ev.pointerId !== drag.id) return;
    const { ghost } = drag;
    const dropped = ev.type === 'pointerup' && ghost && overBoard(ev.clientX, ev.clientY);
    ghost?.remove();
    // The window may have closed under this tile the moment the drag started, and
    // a release for a pointer the element no longer captures throws rather than
    // no-opping. The capture is dropped with the element either way; this is only
    // about not throwing on the way past the rest of the cleanup.
    try { drag.el.releasePointerCapture?.(ev.pointerId); } catch { /* already gone */ }
    drag = null;
    showStickTarget(null);
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', end);
    removeEventListener('pointercancel', end);
    if (dropped) {
      lastCategory = entry.cat;
      cmds.addStickerAt(entry.id, vp.toWorld(ev.clientX, ev.clientY));
    }
    // Never moved: this was a tap, and a tap arms.
    else if (!ghost && ev.type === 'pointerup') arm(entry);
  };

  // On the window rather than on the tile, even though the tile holds the
  // capture: the capture keeps the events coming to the tile, and these listen
  // for them on the way past. A drag that ends over the board still has to be
  // heard, and the board is not inside the tile.
  addEventListener('pointermove', move);
  addEventListener('pointerup', end);
  addEventListener('pointercancel', end);
}

function makeGhost(entry) {
  const el = div('sticker-ghost');
  el.append(shapeArt(entry.id, entry.tint));
  return el;
}

function placeGhost(clientX, clientY) {
  if (!drag?.ghost) return;
  drag.ghost.style.left = `${clientX}px`;
  drag.ghost.style.top = `${clientY}px`;
}

/** Is this screen point over the board rather than over the app's chrome? */
function overBoard(clientX, clientY) {
  const under = document.elementFromPoint(clientX, clientY);
  return !!under?.closest('#viewport');
}

/**
 * What the shape would stick to if it were let go here, or null.
 *
 * The same question the note drag asks mid-flight, of a box that is not on the
 * board yet - which is exactly what wouldStick() is for. The rider is a bare
 * `{ type }` stub because there is no item yet and its type is the only thing
 * the answer turns on: a sticker may land on a fence and on the title card,
 * where a note may not.
 */
function hostUnderPointer(clientX, clientY) {
  if (!overBoard(clientX, clientY)) return null;
  const at = vp.toWorld(clientX, clientY);
  // Every sticker is the same fixed 96 square (see defaultSize), so the box the
  // measurement gets is the box the drop will make. The day a shape carries a
  // size of its own, this is where that stops being true.
  const size = defaultSize('sticker');
  const host = wouldStick(
    { x: at.x, y: at.y, w: size.w, h: size.h }, null, { type: 'sticker' });
  // byId, because wouldStick hands back the live item and a host deleted
  // between two pointer moves would otherwise put the ring on a node that is on
  // its way off the board.
  return host && byId(host.id) ? host : null;
}

function div(cls) {
  const el = document.createElement('div');
  el.className = cls;
  return el;
}
