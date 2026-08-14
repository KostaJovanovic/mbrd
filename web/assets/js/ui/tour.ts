// The tour: the board read as a sequence of stops rather than as a surface.
//
// `board.tour` has existed end to end for a while and nothing consumed it -
// board-model.ts holds the field and normalizeTour(), board-schema.ts reads and
// writes it, state.ts has setTour()/setTourMembers() and the 'tour' event. So
// this module is the whole of the feature that was missing: a runner that walks
// that list, a camera move per stop, and a bar saying where you are.
//
// ── Why it is in ui/ ──
//
// It needs the board, the bus and the Viewport, and it builds chrome. The first
// three would have allowed canvas/, the fourth does not: canvas/ draws the board
// and never the furniture around it. So the runner is here and the commands that
// open it are in commands/view.ts, which already takes the Viewport and already
// calls itself the file for the commands that are journeys.
//
// ── Which stop you are on is not board data ──
//
// The index lives in this module and nowhere else, and it is deliberately not a
// field on the board. What is in the .mbrd is the *itinerary* - the cards, in
// order - because that is a thing somebody made and would expect to find again.
// Where they had got to when they closed the tab is not: it is a position in a
// reading, the same kind of fact as the scroll offset of the Feed, and writing
// it would make opening a board a change to it.
//
// ── The list is resolved live, every time ──
//
// stops() maps board.tour through byId() and drops what is not there. setTour()
// normalizes against the live board on every write, but a tour that is running
// while cards are deleted is exactly the window where the two disagree - and the
// answer that costs nothing is to never hold a resolved list across an event.
// Stepping therefore also survives an undo that takes a stop away underneath it.
//
// ── Desktop only, and it says so ──
//
// vp.fit() opens with `if (this.isMobile) return this.viewTo(...)` - it ignores
// its items entirely, because on Mobile the camera is not free: the zoom follows
// the column count and the pan is a scroll. A tour there would light the bar,
// step the counter and never move. So startTour() declines on Mobile the way
// lockZoom does, with a toast that says why rather than a button that lies.

import { bus, board, byId, isFurniture } from '../state.ts';
import type { Item } from '../board-model.ts';
import { toast } from '../notify.ts';
import { BASE_ZOOM, travelMs } from '../canvas/viewport.ts';
import type { Viewport } from '../canvas/viewport.ts';

/**
 * How far in a single stop is allowed to take the camera.
 *
 * vp.fit()'s cap, and without one a tour is unusable rather than merely
 * imperfect: the default is MAX_ZOOM, which is 500% as printed, so a stop on a
 * sticker or a small note flies the whole way in and the board vanishes behind
 * one object. Half again over 100% is the point where a card fills a comfortable
 * part of the window and the things around it are still visible - which is the
 * whole difference between a tour and a slideshow.
 */
const TOUR_MAX_ZOOM = BASE_ZOOM * 1.5;

/** The margin left round the stop. Generous: a stop is meant to sit in a room. */
const TOUR_PAD = 140;

let vp: Viewport;
let bar: HTMLElement | null = null;
let nameEl: HTMLElement | null = null;
let countEl: HTMLElement | null = null;
let prevBtn: HTMLButtonElement | null = null;
let nextBtn: HTMLButtonElement | null = null;

/** -1 when no tour is running. Never anything else while the bar is down. */
let at = -1;

/** The stops that are actually on the board, in the board's own order. */
function stops(): Item[] {
  const out: Item[] = [];
  for (const id of board.tour) {
    const item = byId(id);
    if (item && !isFurniture(item)) out.push(item);
  }
  return out;
}

/** Is a tour running right now? Read by the commands and by the key handler. */
export function tourActive() { return at >= 0; }

/** How many stops the board's tour has that are still on the board. */
export function tourLength() { return stops().length; }

export function initTour(viewport: Viewport) {
  vp = viewport;
  // Declared in index.html, hidden. An absent one is a broken build rather than
  // a state to recover from - the same thing canvas/input.ts says about #marquee.
  bar = document.getElementById('tour');
  if (!bar) return;
  nameEl = bar.querySelector<HTMLElement>('.tour-name');
  countEl = bar.querySelector<HTMLElement>('.tour-count');
  prevBtn = bar.querySelector<HTMLButtonElement>('.tour-prev');
  nextBtn = bar.querySelector<HTMLButtonElement>('.tour-next');

  prevBtn?.addEventListener('click', () => stepTour(-1));
  nextBtn?.addEventListener('click', () => stepTour(1));
  bar.querySelector('.tour-close')?.addEventListener('click', () => stopTour());

  // The itinerary changed underneath a running tour - a card added to it from
  // the menu, or one taken off. Repaint rather than stop: adding a stop while
  // reading is a reasonable thing to do, and the counter is the only thing that
  // is now wrong. A stop that vanished is handled by the clamp in paint().
  bus.on('tour', () => { if (tourActive()) paint(); });
  // And the two that end it. A different board is a different itinerary, and
  // Mobile has no camera to drive - see the head of this file.
  bus.on('board:load', () => stopTour(true));
  bus.on('layout', () => { if (vp.isMobile) stopTour(true); });
}

/**
 * Start at the first stop.
 *
 * Returns whether it started, because the two ways it declines are both worth a
 * caller knowing about and neither is an error: there is no camera to drive, or
 * there is nothing to drive it to.
 */
export function startTour() {
  if (!bar) return false;
  if (vp.isMobile) {
    toast('The tour needs the canvas - the mobile board scrolls instead');
    return false;
  }
  if (!stops().length) {
    toast('Nothing is on the tour yet - add cards from their menu');
    return false;
  }
  at = 0;
  bar.hidden = false;
  // A frame between the unhide and the class, or the entrance transition has
  // nothing to run from: an element going from display:none straight to its
  // final state is not a transition, it is a jump. The same two-step
  // ui/nowplaying.ts uses for its own bar.
  requestAnimationFrame(() => bar?.classList.add('is-up'));
  travel();
  paint();
  return true;
}

/**
 * End it, and leave the camera exactly where the last stop put it.
 *
 * Deliberately not a return to where the tour started. A tour is a way of
 * reading the board, and reading it usually ends where you want to be - putting
 * the camera back would throw away the one thing the last step just did.
 *
 * Returns whether there was a tour to stop, which is what makes it usable as
 * Escape's first try in canvas/input.ts.
 */
export function stopTour(quiet = false) {
  if (at < 0) return false;
  at = -1;
  bar?.classList.remove('is-up');
  // Hidden on the way out rather than at once, so the exit has a box to run in.
  // Guarded on `at`, or a tour restarted inside the window would be hidden by
  // the timer belonging to the one before it.
  const b = bar;
  setTimeout(() => { if (!tourActive() && b) b.hidden = true; }, 200);
  if (!quiet) toast('Tour ended');
  return true;
}

/**
 * Move by `delta` stops, clamped at both ends.
 *
 * Clamped rather than wrapped, and that is the same decision the Playlist's
 * repeat-off mode makes: a tour has a first stop and a last one, and arriving
 * back at the beginning without asking reads as a bug rather than as a loop.
 * The ends grey the buttons instead.
 *
 * Returns whether a tour was running - not whether it moved. That is what the
 * arrow keys need: while the bar is up the arrows belong to the tour even at the
 * last stop, and a false there would drop through to nudging the selection.
 */
export function stepTour(delta: number) {
  if (at < 0) return false;
  const list = stops();
  if (!list.length) { stopTour(true); return true; }
  const next = Math.min(Math.max(at + delta, 0), list.length - 1);
  if (next !== at) { at = next; travel(); }
  paint();
  return true;
}

/** Jump straight to a stop by its index - the door a list of stops would use. */
export function goToStop(i: number) {
  if (at < 0 && !startTour()) return false;
  const list = stops();
  if (!list.length) return false;
  at = Math.min(Math.max(Math.trunc(i) || 0, 0), list.length - 1);
  travel();
  paint();
  return true;
}

/** The camera move. One item, framed, at a magnification that keeps the room. */
function travel() {
  const list = stops();
  const item = list[at];
  if (!item) return;
  // travelMs() rather than a literal: it reads --dur-travel, which is where
  // prefers-reduced-motion is already honoured for every other journey.
  vp.fit([item], TOUR_PAD, travelMs(), TOUR_MAX_ZOOM);
}

/** The bar's two strings and the two greyed ends. */
function paint() {
  const list = stops();
  if (!list.length) { stopTour(true); return; }
  if (at >= list.length) at = list.length - 1;
  const item = list[at];
  const label = (item?.name || '').trim();
  if (nameEl) {
    nameEl.textContent = label || 'Untitled';
    nameEl.title = label;
  }
  if (countEl) countEl.textContent = `${at + 1} of ${list.length}`;
  if (prevBtn) prevBtn.disabled = at <= 0;
  if (nextBtn) nextBtn.disabled = at >= list.length - 1;
}
