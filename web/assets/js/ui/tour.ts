// The tour: the board read as a sequence of stops rather than as a surface.
//
// This is the *runner* - it walks `board.tour`, moves the camera and draws the
// bar. Building the list is ui/tour-edit.ts, in the Board tab - the split the
// Playlist makes between the window that plays and the panel that orders.
//
// ── A tour is a presentation, so the app gets out of the way ──
//
// Four things happen at the first stop and none is the camera:
//
//   - every piece of chrome goes. One class on <html> - see presentation()
//     and :root.is-touring in chrome.css - takes the bin, the zoom cluster,
//     the toolbar, the player, the strip and either panel. What is left is the
//     board and this bar.
//   - a click on anything that is not a card is the next stop, in
//     canvas/input.ts where the one gesture pipeline is (`tourClick`) - so the
//     bar's two buttons are a convenience, not the way through a tour.
//   - a right-click opens the tour's own menu and nothing else - see
//     tourEntries() in ui/menu.ts. Every other menu edits a board.
//   - the board freezes: nothing moves, resizes, is picked up, pans or zooms.
//     A press answers `frozen` in pressIntent(), a wheel returns, a second
//     finger is not a pinch - all three in canvas/input.ts. Each stop is a
//     framed shot, and a viewer who has dragged the board off one has lost
//     their place with no way back but the next stop. `fit` in the tour menu
//     is the exception, because it is asked for rather than stumbled into.
//
// ── Why it is in ui/ ──
//
// It needs the board, the bus and the Viewport, and it builds chrome. The
// first three would have allowed canvas/, the fourth does not: canvas/ draws
// the board and never the furniture around it. The commands that open it are
// in commands/view.ts, which takes the Viewport and calls itself the file for
// the commands that are journeys.
//
// ── Which stop you are on is not board data ──
//
// The index lives in this module and nowhere else, never a field on the board.
// The .mbrd holds the *itinerary* - the cards, in order - because somebody
// made that and would expect to find it again. Where they had got to when they
// closed the tab is a position in a reading, the same kind of fact as the
// Feed's scroll offset, and writing it would make opening a board a change to
// it.
//
// ── The list is resolved live, every time ──
//
// stops() maps board.tour through byId() and drops what is not there.
// setTour() normalizes against the live board on every write, but a tour
// running while cards are deleted is the window where the two disagree - and
// the answer that costs nothing is to never hold a resolved list across an
// event. Stepping therefore survives an undo that takes a stop away under it.
//
// ── Desktop only, and it says so ──
//
// vp.fit() opens with `if (this.isMobile) return this.viewTo(...)` - it
// ignores its items entirely, because on Mobile the camera is not free: the
// zoom follows the column count and the pan is a scroll. A tour there would
// light the bar, step the counter and never move. So startTour() declines on
// Mobile the way lockZoom does, with a toast that says why rather than a
// button that lies.

import { bus, board, byId, canTour } from '../state.ts';
import type { Item } from '../board-model.ts';
import { toast } from '../notify.ts';
import { BASE_ZOOM, travelMs } from '../canvas/viewport.ts';
import type { Viewport } from '../canvas/viewport.ts';

/**
 * One stop, resolved: the cards actually on the board, and what is said about
 * them. Resolved fresh on every read - see the head of this file - so one only
 * ever exists inside a single call. Nothing holds one across an event.
 */
type Stop = { items: Item[], caption: string };

/**
 * How far in a single stop may take the camera.
 *
 * vp.fit()'s cap, and without one a tour is unusable: the default is MAX_ZOOM,
 * 500% as printed, so a stop on a sticker or a small note flies the whole way
 * in and the board vanishes behind one object. Half again over 100% fills a
 * comfortable part of the window while the things around it stay visible -
 * the difference between a tour and a slideshow.
 */
const TOUR_MAX_ZOOM = BASE_ZOOM * 1.5;

/** The margin round the stop. Generous: a stop is meant to sit in a room. */
const TOUR_PAD = 140;

let vp: Viewport;
let bar: HTMLElement | null = null;
let nameEl: HTMLElement | null = null;
let captionEl: HTMLElement | null = null;
let countEl: HTMLElement | null = null;
let prevBtn: HTMLButtonElement | null = null;
let nextBtn: HTMLButtonElement | null = null;

/** -1 when no tour is running. Never anything else while the bar is down. */
let at = -1;

/**
 * The stops actually on the board, in the board's own order.
 *
 * A stop whose cards have all gone is dropped here rather than flown to and
 * apologised for; a stop that has lost *some* of its cards is still the stop
 * it was, framed round what is left. Neither case edits the board's own copy -
 * a card in the bin comes back, and its place in the group with it (see
 * setTour() in state.ts).
 */
function stops(): Stop[] {
  const out: Stop[] = [];
  for (const stop of board.tour) {
    const items: Item[] = [];
    for (const id of stop.cards) {
      // canTour(), the same question the door that made the stop asked - see
      // state.ts. Asked again because the answer can change under a stop
      // already written: a note on the tour dropped onto a photograph is part
      // of that photograph now, and flying to it would be flying to the
      // photograph and calling it a stop of its own.
      const item = byId(id);
      if (canTour(item)) items.push(item!);
    }
    if (items.length) out.push({ items, caption: stop.caption || '' });
  }
  return out;
}

/** Is a tour running right now? Read by the commands and by the key handler. */
export function tourActive() { return at >= 0; }

/** Which stop the tour is on, or -1. What the editor's list highlights. */
export function tourAt() { return at; }

/** How many stops the board's tour has that are still on the board. */
export function tourLength() { return stops().length; }

export function initTour(viewport: Viewport) {
  vp = viewport;
  // Declared in index.html, hidden. An absent one is a broken build rather
  // than a state to recover from - as canvas/input.ts says about #marquee.
  bar = document.getElementById('tour');
  if (!bar) return;
  nameEl = bar.querySelector<HTMLElement>('.tour-name');
  captionEl = bar.querySelector<HTMLElement>('.tour-caption');
  countEl = bar.querySelector<HTMLElement>('.tour-count');
  prevBtn = bar.querySelector<HTMLButtonElement>('.tour-prev');
  nextBtn = bar.querySelector<HTMLButtonElement>('.tour-next');

  prevBtn?.addEventListener('click', () => stepTour(-1));
  nextBtn?.addEventListener('click', () => stepTour(1));
  bar.querySelector('.tour-close')?.addEventListener('click', () => stopTour());

  // The itinerary changed under a running tour - a card added from the menu,
  // or one taken off. Repaint rather than stop: adding a stop while reading is
  // reasonable, and the counter is the only thing now wrong. A stop that
  // vanished is handled by the clamp in paint().
  bus.on('tour', () => { if (tourActive()) paint(); });
  // And the two that end it. A different board is a different itinerary, and
  // Mobile has no camera to drive - see the head of this file.
  bus.on('board:load', () => stopTour(true));
  bus.on('layout', () => { if (vp.isMobile) stopTour(true); });
}

/**
 * Start at the first stop.
 *
 * Returns whether it started: the two ways it declines are both worth a caller
 * knowing about and neither is an error - there is no camera to drive, or
 * nothing to drive it to.
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
  // Everything that is not the board, out of the way.
  presentation(true);
  // A frame between the unhide and the class, or the entrance transition has
  // nothing to run from: display:none straight to the final state is a jump,
  // not a transition. The two-step ui/nowplaying.ts uses for its own bar.
  requestAnimationFrame(() => bar?.classList.add('is-up'));
  travel();
  paint();
  bus.emit('tour:at', at);
  return true;
}

/**
 * The chrome, gone or back.
 *
 * A tour is the board being *shown*; everything pinned to the corners is the
 * board being worked on - the bin, the zoom cluster, the toolbar, the player,
 * the strip, and either panel if one was left open. One class on <html> takes
 * the lot; the rules are in chrome.css beside the idle ones, the same
 * mechanism doing a stronger version of the same thing.
 *
 * The tour bar is the exception by construction: it is not on the list.
 * Neither is the toast - "Saved" during a tour is one line that fades, and a
 * save that said nothing because a tour was running would be the app going
 * quiet at the moment it had something to report.
 *
 * A class rather than closing the panels: a panel left open is a decision
 * somebody made, and a tour is a few minutes long. Hidden, it is where they
 * left it when the tour ends.
 */
function presentation(on: boolean) {
  document.documentElement.classList.toggle('is-touring', on);
}

/**
 * End it, and leave the camera where the last stop put it.
 *
 * Not a return to where the tour started: a tour is a way of reading the
 * board, and reading it usually ends where you want to be - putting the camera
 * back would throw away the one thing the last step just did.
 *
 * Returns whether there was a tour to stop, which is what makes it usable as
 * Escape's first try in canvas/input.ts.
 */
export function stopTour(quiet = false) {
  if (at < 0) return false;
  at = -1;
  presentation(false);
  bar?.classList.remove('is-up');
  bus.emit('tour:at', at);
  // Hidden on the way out rather than at once, so the exit has a box to run
  // in. Guarded on `at`, or a tour restarted inside the window would be hidden
  // by the timer belonging to the one before it.
  const b = bar;
  setTimeout(() => { if (!tourActive() && b) b.hidden = true; }, 200);
  if (!quiet) toast('Tour ended');
  return true;
}

/**
 * Move by `delta` stops, clamped at both ends.
 *
 * Clamped rather than wrapped, the same decision the Playlist's repeat-off
 * mode makes: a tour has a first stop and a last one, and arriving back at the
 * beginning without asking reads as a bug rather than a loop. The ends grey
 * the buttons instead.
 *
 * Returns whether a tour was running - not whether it moved. That is what the
 * arrow keys need: while the bar is up the arrows belong to the tour even at
 * the last stop, and a false there would drop through to nudging the
 * selection.
 */
export function stepTour(delta: number) {
  if (at < 0) return false;
  const list = stops();
  if (!list.length) { stopTour(true); return true; }
  const next = Math.min(Math.max(at + delta, 0), list.length - 1);
  if (next !== at) { at = next; travel(); bus.emit('tour:at', at); }
  paint();
  return true;
}

/**
 * Fly to a stop without starting a tour - what the editor's rows press.
 *
 * The camera move alone, with no bar, no index and no mode: somebody building
 * a tour needs to see whether a stop frames what they meant, and starting the
 * tour would hide the panel they are building it in (see :root.is-touring). A
 * running tour is left as it is - a look, not a jump - so this writes nothing
 * and returns nothing.
 *
 * Silent on Mobile rather than toasting, unlike startTour(): the row is in a
 * panel somebody is editing a list in, and a toast on every press explaining
 * that the camera is not free would be four lines of apology for one glance.
 */
export function previewStop(i: number) {
  // `vp` is only set by initTour(), which returns early where there is no bar,
  // so this is the one exported door reachable before there is a viewport to
  // drive. The rest are guarded by `at`, which stays -1.
  if (!vp || vp.isMobile) return;
  const stop = stops()[i];
  if (!stop) return;
  vp.fit(stop.items, TOUR_PAD, travelMs(), TOUR_MAX_ZOOM);
}

/** Jump straight to a stop by its index - the door a list of stops would use. */
export function goToStop(i: number) {
  if (at < 0 && !startTour()) return false;
  const list = stops();
  if (!list.length) return false;
  const want = Math.min(Math.max(Math.trunc(i) || 0, 0), list.length - 1);
  // Only when it is a different stop from the one startTour() may have just
  // flown to. Jumping to stop 4 with no tour running used to fire two camera
  // animations in one tick: startTour() sets `at = 0` and travels there, then
  // this set `at = 4` and travelled again - so the board lurched towards the
  // first stop and then set off for the fourth. stepTour() guards its travel
  // the same way.
  const moved = want !== at;
  at = want;
  if (moved) travel();
  paint();
  if (moved) bus.emit('tour:at', at);
  return true;
}

/**
 * The camera move: everything at this stop, framed together, at a
 * magnification that keeps the room.
 *
 * vp.fit() takes the list, so a stop holding three cards is one journey to the
 * box round all three - the whole of what grouping buys. The zoom ceiling then
 * matters more than with one card: a group spread across the board is framed
 * by the *cap* on how far out fit() may go, and there is none - so a badly
 * built stop reads as "the board", the honest picture of what was asked for.
 */
function travel() {
  const stop = stops()[at];
  if (!stop) return;
  // travelMs() rather than a literal: it reads --dur-travel, where
  // prefers-reduced-motion is already honoured for every other journey.
  vp.fit(stop.items, TOUR_PAD, travelMs(), TOUR_MAX_ZOOM);
}

/**
 * What the bar says at a stop: the cards, named.
 *
 * One card gives its own name. Several give the first and a count rather than
 * a list - three names in a bar this wide is three ellipses - and the full
 * list goes in the `title`, for whoever wants to hover for it.
 */
function stopLabel(stop: Stop): { text: string, full: string } {
  const names = stop.items.map(i => (i.name || '').trim() || 'Untitled');
  const full = names.join(', ');
  return {
    text: names.length > 1 ? `${names[0]} +${names.length - 1}` : names[0],
    full,
  };
}

/** The bar's strings and the two greyed ends. */
function paint() {
  const list = stops();
  if (!list.length) { stopTour(true); return; }
  if (at >= list.length) at = list.length - 1;
  const stop = list[at];
  const { text, full } = stopLabel(stop);
  if (nameEl) {
    nameEl.textContent = text;
    // The whole group's names, and the caption under it when there is one:
    // the tooltip is where the bar puts what it had to shorten.
    nameEl.title = stop.caption ? `${full}\n${stop.caption}` : full;
  }
  // The caption is the line somebody wrote for this stop, so it sits where the
  // counter is and the counter moves along - and the element goes entirely
  // when there is nothing to say, rather than holding an empty line's height
  // on every uncaptioned board.
  if (captionEl) {
    captionEl.textContent = stop.caption;
    captionEl.hidden = !stop.caption;
  }
  if (countEl) countEl.textContent = `${at + 1} of ${list.length}`;
  if (prevBtn) prevBtn.disabled = at <= 0;
  if (nextBtn) nextBtn.disabled = at >= list.length - 1;
}
