// Tour runner. Walks board.tour, moves the camera, draws the bar. Building
// the list is tour-edit.ts. During a tour: chrome hidden (is-touring), board
// frozen, only the current stop's cards take input, click-to-advance,
// tour-specific right-click menu. Stops resolved live on every read — survives
// undo that removes a stop. Desktop only (Mobile has no free camera).

import { bus, board, byId, canTour, clearSelection } from '../state.ts';
import type { Item } from '../board-model.ts';
import { shownName } from '../board-model.ts';
import { toast } from '../notify.ts';
import { BASE_ZOOM, travelMs } from '../canvas/viewport.ts';
import type { Viewport } from '../canvas/viewport.ts';
import { nodeFor, setSpot } from '../canvas/items.ts';
import { nowPlaying, ownerOf, registeredPlayers } from '../canvas/audio.ts';
import { openAnchored } from './menu.ts';
import type { MenuEntry } from './menu.ts';

/** One resolved stop — never held across an event. */
type Stop = { items: Item[], caption: string };

/** Max zoom per stop — 1.5× base keeps surrounding context visible. */
const TOUR_MAX_ZOOM = BASE_ZOOM * 1.5;

/** The margin round the stop. Generous: a stop is meant to sit in a room. */
const TOUR_PAD = 140;

/** A stop with one clip or song in it plays that by itself, this long after it opens. */
const AUTOPLAY_MS = 2000;

let vp: Viewport;
let bar: HTMLElement | null = null;
let nameEl: HTMLElement | null = null;
let captionEl: HTMLElement | null = null;
let countEl: HTMLElement | null = null;
let prevBtn: HTMLButtonElement | null = null;
let nextBtn: HTMLButtonElement | null = null;
let autoTimer = 0;

/** -1 when no tour is running. Never anything else while the bar is down. */
let at = -1;

/** Resolve stops against the live board. Empty stops dropped, partial stops kept. */
function stops(): Stop[] {
  const out: Stop[] = [];
  board.tour.forEach(stop => {
    const items: Item[] = [];
    for (const id of stop.cards) {
      // Re-check canTour: a note dropped onto a card since the stop was written is now a rider.
      const item = byId(id);
      if (canTour(item)) items.push(item!);
    }
    if (items.length) out.push({ items, caption: stop.caption || '' });
  });
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
  // All tour elements declared hidden in index.html.
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
  // Right-click: the bar's buttons as rows, and every stop by name. Nothing
  // that edits the tour, for the reason paint() gives.
  bar.addEventListener('contextmenu', e => {
    e.preventDefault();
    if (at < 0) return;
    openAnchored({ left: e.clientX, right: e.clientX, top: e.clientY, bottom: e.clientY },
      barEntries(), { label: 'Tour' });
  });

  // Tour edited while running — repaint (the clamp in paint() handles vanished stops).
  bus.on('tour', () => { if (tourActive()) paint(); });
  // Board load or Mobile layout ends the tour.
  bus.on('board:load', () => stopTour(true));
  bus.on('layout', () => { if (vp.isMobile) stopTour(true); });
}

/** Start at stop 0. Returns false if Mobile (no camera) or no stops. */
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
  // The board's music stops: the stops have the floor.
  nowPlaying()?.el.pause();
  // And nothing stays selected: a tour shows the board rather than works on it,
  // and a ring and grips left on a card - often the editor's last stop, since
  // pressing a chip selects its cards - would sit in every frame of the showing.
  clearSelection();
  bar.hidden = false;
  // Hide all chrome.
  presentation(true);
  // One frame delay so the transition has a starting state (display:none → visible).
  requestAnimationFrame(() => bar?.classList.add('is-up'));
  travel();
  paint();
  bus.emit('tour:at', at);
  return true;
}

/** Toggle is-touring on <html> — hides all chrome except the tour bar and toasts. */
function presentation(on: boolean) {
  document.documentElement.classList.toggle('is-touring', on);
}

/** Stop the tour, leaving the camera at the last stop. Returns whether there
 * was a tour to stop (Escape uses this). */
export function stopTour(quiet = false) {
  if (at < 0) return false;
  at = -1;
  clearTimeout(autoTimer);
  // Leaving the last stop stops its clips, as leaving any stop does.
  hush(new Set());
  setSpot(null);
  presentation(false);
  bar?.classList.remove('is-up');
  bus.emit('tour:at', at);
  // Delayed hide so the exit transition has a box. Guarded on `at` to avoid stale timer conflicts.
  const b = bar;
  setTimeout(() => { if (!tourActive() && b) b.hidden = true; }, 200);
  if (!quiet) toast('Tour ended');
  return true;
}

/** Step by delta, clamped (not wrapped). Returns whether a tour was running
 * (arrows claim the press even at the last stop). */
export function stepTour(delta: number) {
  if (at < 0) return false;
  const list = stops();
  if (!list.length) { stopTour(true); return true; }
  const next = Math.min(Math.max(at + delta, 0), list.length - 1);
  if (next !== at) { at = next; travel(); bus.emit('tour:at', at); }
  paint();
  return true;
}

/** Preview a stop (camera only, no bar/mode) — what the editor rows use.
 * Silent on Mobile, no-op during a running tour. */
export function previewStop(i: number) {
  // vp may be unset if initTour found no bar.
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
  // Skip travel if startTour already flew to this stop — avoids double animation.
  const moved = want !== at;
  at = want;
  if (moved) travel();
  paint();
  if (moved) bus.emit('tour:at', at);
  return true;
}

/** Fly to the current stop, framing all its cards together, and open it. */
function travel() {
  const stop = stops()[at];
  if (!stop) return;
  // travelMs reads --dur-travel, which honours prefers-reduced-motion.
  vp.fit(stop.items, TOUR_PAD, travelMs(), TOUR_MAX_ZOOM);
  arrive(stop);
}

/**
 * A stop opens: the clips of the one left behind stop, and a stop holding
 * exactly one clip or song plays it after a moment. Two or more play nothing
 * by themselves - which of them first is the viewer's to say.
 */
function arrive(stop: Stop) {
  hush(new Set(stop.items.map(i => i.id)));
  clearTimeout(autoTimer);
  const playable = stop.items.filter(i => i.type === 'video' || i.type === 'audio');
  if (playable.length !== 1) return;
  const id = playable[0].id;
  const was = at;
  autoTimer = setTimeout(() => { if (at === was) play(id); }, AUTOPLAY_MS);
}

/** Pause every clip playing on a card outside `keep`. */
function hush(keep: Set<string>) {
  for (const el of registeredPlayers()) {
    const owner = ownerOf(el)?.id;
    if (!el.paused && !(owner && keep.has(owner))) el.pause();
  }
}

/** Press a card's own play button, so it starts exactly as a press would start it. */
function play(id: string) {
  const el = nodeFor(id);
  const media = el?.querySelector<HTMLMediaElement>('video, audio');
  if (media && !media.paused) return;
  el?.querySelector<HTMLButtonElement>('.vbig, .transport .play')?.click();
}

/** The running bar's right-click rows. */
function barEntries(): MenuEntry[] {
  const list = stops();
  return [
    { label: 'The stop before', disabled: at <= 0, action: () => stepTour(-1) },
    { label: 'The next stop', disabled: at >= list.length - 1, action: () => stepTour(1) },
    {
      label: 'Go to stop',
      sub: list.map((stop, i) => ({
        label: `${i + 1}. ${stopLabel(stop).text}`,
        check: i === at,
        action: () => { goToStop(i); },
      })),
    },
    { sep: true },
    { label: 'End the tour', action: () => { stopTour(); } },
  ];
}

/** Label for the bar: first name + count; full list in title attribute. */
function stopLabel(stop: Stop): { text: string, full: string } {
  const names = stop.items.map(i => shownName(i).trim() || 'Untitled');
  const full = names.join(', ');
  return {
    text: names.length > 1 ? `${names[0]} +${names.length - 1}` : names[0],
    full,
  };
}

/**
 * The bar's strings and the two greyed ends. Nothing that edits the tour: a
 * running tour is being shown, and splitting, joining or taking a stop off is
 * the editor's (ui/tour-edit.ts).
 */
function paint() {
  const list = stops();
  if (!list.length) { stopTour(true); return; }
  if (at >= list.length) at = list.length - 1;
  const stop = list[at];
  const { text, full } = stopLabel(stop);
  if (nameEl) {
    nameEl.textContent = text;
    // Tooltip carries the full names + caption.
    nameEl.title = stop.caption ? `${full}\n${stop.caption}` : full;
  }
  // Caption hidden when empty — no blank line on uncaptioned stops.
  if (captionEl) {
    captionEl.textContent = stop.caption;
    captionEl.hidden = !stop.caption;
  }
  if (countEl) countEl.textContent = `${at + 1} of ${list.length}`;
  if (prevBtn) prevBtn.disabled = at <= 0;
  if (nextBtn) nextBtn.disabled = at >= list.length - 1;
  // Only this stop's cards take input (item-chrome.css). Here rather than in
  // travel(), since an edit or an undo can change a stop's cards in place.
  setSpot(stop.items.map(i => i.id));
}
