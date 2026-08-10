// How the board is framed, and which geometry profile the viewport is on.
//
// Three functions that were loose in main.js and are called from four places
// between them - the boot, the layout event, a board arriving, and "Reload
// board". They are here rather than in canvas/viewport.js because each is a
// decision about *this app's* framing (open on a fit, not on the stored view;
// the title card is furniture) rather than part of the coordinate model.
//
// The viewport is handed in by initBoardView() rather than imported, so nothing
// here touches a browser global at import time.

import { board, bus, mobileBoardWidth, mobileBoardTop, mobileBoardBottom } from '../state.js';
import { BASE_ZOOM } from '../canvas/viewport.js';

let vp = null;

export function initBoardView(viewport) {
  vp = viewport;
}

/**
 * Which mobile lens is up: 'feed' (the masonry wall of everything) or 'playlist'
 * (the audio player). A session choice, not board state - the same status as
 * layoutMode, and kept beside it for the same reason. Mirrored onto
 * documentElement.dataset.feedLens, which mobile.css keys the canvas / feed /
 * playlist show-hide off, under data-board-mode="mobile". Removed entirely off
 * Mobile so it can never touch the Desktop canvas.
 */
let lens = 'feed';

/** The lens up right now. */
export const currentLens = () => lens;

/**
 * Choose a lens. Writes it where the CSS can see it (only while Mobile) and
 * announces it on the bus, so ui/feed.js and ui/playlist.js each render or tear
 * down without either importing the other or this reaching into them.
 */
export function setLens(name) {
  lens = name === 'playlist' ? 'playlist' : 'feed';
  syncLens();
  bus.emit('lens', lens);
}

/** Mirror the lens onto <html>, or clear it when the canvas is what shows. */
export function syncLens() {
  const root = document.documentElement;
  if (board.layoutMode === 'mobile') root.dataset.feedLens = lens;
  else delete root.dataset.feedLens;
}

/**
 * How a board is framed the moment it appears, wherever it came from - a
 * restored session, a file opened, a file dropped on the window.
 *
 * Fit, not the stored view. A saved pan and zoom is a record of where somebody
 * was standing when they stopped, and that is not the same question as where
 * to start: it can be a corner, a single card filling the screen, or - after a
 * board is opened on a narrower screen than it was saved on - somewhere off the
 * edge of everything, which reads as an empty board with the work missing.
 * Framing the whole thing always answers "what is on here", and getting back to
 * a detail is one gesture away.
 *
 * fit() falls back to the origin at 1:1 by itself when there is nothing to
 * frame, so a brand new board still opens where a new board should.
 *
 * ms = 0 deliberately: the travel animation is for a Fit somebody *asked* for,
 * where the movement says which way the board went. There is nothing to travel
 * from at load.
 */
export function openingView() {
  // An empty board - only the title card, which is furniture rather than
  // content - opens at the origin at 100%, where a fresh board should. Fitting
  // the title card alone would frame that one card and read as "this is all
  // there is", which is exactly what a blank board is trying not to say.
  if (!vp.isMobile && board.items.every(it => it.type === 'title')) return vp.recenter(0);
  // Capped at 100%: a small board opens at actual size, not magnified. A board
  // bigger than the window still zooms out to frame it - see fit()'s maxZoom.
  vp.fit(board.items, 80, 0, BASE_ZOOM);
}

/**
 * Publish the active geometry profile to the viewport and CSS. The choice is a
 * local device preference; state.js keeps both arrangements in the board.
 */
export function syncBoardMode(frame = false) {
  document.documentElement.dataset.boardMode = board.layoutMode;
  // The lens attribute follows the mode: written on the way into Mobile, cleared
  // on the way out, so a Desktop board never carries a feed-lens the CSS could act
  // on. Entering Mobile lands on whichever lens was last up (feed to begin with).
  syncLens();
  vp.setBoardMode(
    board.layoutMode,
    mobileBoardWidth(),
    mobileBoardTop(),
    mobileBoardBottom(),
  );
  if (frame) openingView();
}

/** Follow the lowest Mobile item without resetting or reframing the view. */
export function syncMobileBoardBounds() {
  if (board.layoutMode !== 'mobile') return;
  vp.setMobileBounds(mobileBoardWidth(), mobileBoardTop(), mobileBoardBottom());
}
