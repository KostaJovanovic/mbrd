// Board framing and geometry profile. Lives here (not viewport.ts) because
// each decision is about the app's framing, not the coordinate model.
// Viewport is injected, not imported — no browser global at import time.

import { board, bus, mobileBoardWidth, mobileBoardTop, mobileBoardBottom } from '../state.ts';
import { BASE_ZOOM } from '../canvas/viewport.ts';
import type { Viewport } from '../canvas/viewport.ts';

/** Which mobile lens is up. */
export type Lens = 'feed' | 'playlist';

let vp: Viewport | null = null;

export function initBoardView(viewport: Viewport): void {
  vp = viewport;
}

/**
 * Which mobile lens is up: 'feed' (the masonry wall) or 'playlist' (the audio
 * player). A session choice, not board state. Mirrored onto
 * documentElement.dataset.feedLens, which mobile.css keys the show/hide off;
 * removed entirely off Mobile so it can never touch the Desktop canvas.
 */
let lens: Lens = 'feed';

/** The lens up right now. */
export const currentLens = (): Lens => lens;

/**
 * Choose a lens. Writes it where the CSS can see it (only while Mobile) and
 * announces it on the bus, so ui/feed.ts and ui/playlist.ts each render or tear
 * down without either importing the other or this reaching into them.
 */
export function setLens(name: string): void {
  lens = name === 'playlist' ? 'playlist' : 'feed';
  syncLens();
  bus.emit('lens', lens);
}

/** Mirror the lens onto <html>, or clear it when the canvas is what shows. */
export function syncLens(): void {
  const root = document.documentElement;
  if (board.layoutMode === 'mobile') root.dataset.feedLens = lens;
  else delete root.dataset.feedLens;
}

/**
 * How a board is framed the moment it appears - a restored session, a file
 * opened, a file dropped on the window.
 *
 * Fit, not the stored view: a saved pan/zoom is where somebody stopped, which
 * after a resize can be off the edge of everything, reading as an empty board.
 * Framing the whole thing always answers "what is on here". fit() falls back
 * to the origin at 1:1 when there's nothing to frame, so a new board still
 * opens right.
 *
 * ms = 0 deliberately: the travel animation is for a Fit somebody *asked*
 * for; there's nothing to travel from at load.
 */
export function openingView(): void {
  // An empty board - only the title card, which is furniture, not content -
  // opens at the origin at 100%. Fitting the title card alone would frame
  // that one card and read as "this is all there is". The inline item type
  // below is because board-model.ts's migration pragma still leaves
  // `board.items`'s element type unknowable from here.
  if (!vp!.isMobile && board.items.every((it: { type: string }) => it.type === 'title')) return vp!.recenter(0);
  // Capped at 100%: a small board opens at actual size, not magnified. A board
  // bigger than the window still zooms out to frame it - see fit()'s maxZoom.
  vp!.fit(board.items, 80, 0, BASE_ZOOM);
}

/**
 * Publish the active geometry profile to the viewport and CSS. The choice is a
 * local device preference; state.ts keeps both arrangements in the board.
 */
export function syncBoardMode(frame = false): void {
  document.documentElement.dataset.boardMode = board.layoutMode;
  // The lens attribute follows the mode: written on the way into Mobile, cleared
  // on the way out, so a Desktop board never carries a feed-lens the CSS could act
  // on. Entering Mobile lands on whichever lens was last up (feed to begin with).
  syncLens();
  vp!.setBoardMode(
    board.layoutMode,
    mobileBoardWidth(),
    mobileBoardTop(),
    mobileBoardBottom(),
  );
  if (frame) openingView();
}

/** Follow the lowest Mobile item without resetting or reframing the view. */
export function syncMobileBoardBounds(): void {
  if (board.layoutMode !== 'mobile') return;
  vp!.setMobileBounds(mobileBoardWidth(), mobileBoardTop(), mobileBoardBottom());
}
